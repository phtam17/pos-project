import { createHash, randomUUID } from "node:crypto";

import {
  AuditEntry,
  Cart,
  Money,
  Order,
  OutboxMessage,
  Payment,
  PaymentAttempt,
  Product,
  Refund,
  type OrderStatus,
  type PaymentAttemptStatus
} from "@pos/domain";
import {
  PaymentProviderError,
  type PaymentProvider,
  type PaymentPresentation,
  type PaymentResult,
  type ProviderEvent,
  type ProviderWebhookHeaders,
  type RefundResult
} from "@pos/payment-contract";
import {
  RepositoryConflictError,
  type IdempotencyRecord,
  type IdempotencyClaim,
  type PosRepository,
  type ReconciliationQuery,
  type ReconciliationSummary
} from "@pos/persistence";

import { ApplicationError, notFound } from "./errors.js";

export interface CreateProductCommand {
  readonly sku: string;
  readonly name: string;
  readonly priceMinor: string;
  readonly currency: string;
  readonly taxRateBps?: number;
  readonly active?: boolean;
}

export interface StartPaymentCommand {
  readonly orderId: string;
  readonly tender: "cash" | "card" | "vietnam_qr";
  readonly terminalId?: string;
  readonly idempotencyKey: string;
}

export interface StartPaymentResult {
  readonly attempt: PaymentAttempt;
  readonly payment?: Payment;
  readonly presentation?: PaymentPresentation;
  readonly wallet?: PaymentResult["wallet"];
  readonly replayed: boolean;
}

export interface RefundCommand {
  readonly paymentId: string;
  readonly amountMinor: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly actorId?: string;
}

export interface RefundCommandResult {
  readonly refund: Refund;
  readonly replayed: boolean;
}

interface AppliedPaymentResult {
  readonly attempt: PaymentAttempt;
  readonly payment?: Payment;
  readonly presentation?: PaymentPresentation;
  readonly wallet?: PaymentResult["wallet"];
}

const TERMINAL_STATUSES = new Set<PaymentAttemptStatus>([
  "CAPTURED",
  "DECLINED",
  "CANCELED"
]);

export class PosService {
  private readonly paymentProviders: ReadonlyMap<string, PaymentProvider>;
  private readonly defaultPaymentProvider: PaymentProvider;

  constructor(
    private readonly repository: PosRepository,
    paymentProviders: PaymentProvider | readonly PaymentProvider[],
    private readonly now: () => Date = () => new Date()
  ) {
    const providers = Array.isArray(paymentProviders) ? paymentProviders : [paymentProviders];
    if (providers.length === 0 || !providers[0]) {
      throw new ApplicationError("At least one payment provider is required", "PAYMENT_PROVIDER_REQUIRED", 500);
    }
    this.paymentProviders = new Map(providers.map((provider) => [provider.name, provider]));
    this.defaultPaymentProvider = providers.find((provider) =>
      provider.capabilities.paymentMethods?.includes("CARD")
    ) ?? providers[0];
  }

  listPaymentProviders(): readonly PaymentProvider[] {
    return [...this.paymentProviders.values()];
  }

  private providerForTender(tender: "card" | "vietnam_qr"): PaymentProvider {
    const method = tender === "card" ? "CARD" : "VIETNAM_QR";
    const provider = [...this.paymentProviders.values()].find((candidate) =>
      candidate.capabilities.paymentMethods?.includes(method)
    );
    if (provider) return provider;
    if (tender === "card") return this.defaultPaymentProvider;
    throw new ApplicationError(
      "Vietnam QR is not configured on this register",
      "PAYMENT_METHOD_NOT_CONFIGURED",
      501
    );
  }

  private providerForName(name: string): PaymentProvider {
    const provider = this.paymentProviders.get(name);
    if (!provider) {
      throw new ApplicationError(`Payment provider is unavailable: ${name}`, "PAYMENT_PROVIDER_UNAVAILABLE", 503);
    }
    return provider;
  }

  listProducts(search?: string, limit = 500, offset = 0): Promise<readonly Product[]> {
    return this.repository.listProducts({
      activeOnly: true,
      limit,
      offset,
      ...(search ? { search } : {})
    });
  }

  async createProduct(command: CreateProductCommand): Promise<Product> {
    const product = new Product({
      id: randomUUID(),
      sku: command.sku,
      name: command.name,
      unitPrice: Money.fromMinor(parseMinor(command.priceMinor), command.currency),
      taxRateBps: command.taxRateBps ?? 0,
      active: command.active ?? true
    });
    await this.repository.createProduct(product);
    await this.record("Product", product.id, "PRODUCT_CREATED", {
      sku: product.sku,
      priceMinor: product.unitPrice.minorUnits.toString()
    });
    return product;
  }

  async createCart(currency = "USD"): Promise<Cart> {
    const cart = new Cart({ id: randomUUID(), currency });
    await this.repository.createCart(cart);
    await this.record("Cart", cart.id, "CART_CREATED", { currency: cart.currency });
    return cart;
  }

  async getCart(id: string): Promise<Cart> {
    return (await this.repository.getCart(id)) ?? Promise.reject(notFound("Cart", id));
  }

  async addCartLine(cartId: string, productId: string, quantity: number): Promise<Cart> {
    const [cart, product] = await Promise.all([
      this.getCart(cartId),
      this.repository.getProduct(productId)
    ]);
    if (!product) throw notFound("Product", productId);
    const expectedVersion = cart.version;
    // Line IDs are stable within a cart but globally unique for persistence.
    // Using product.id alone would collide when two carts contain the same SKU.
    cart.addProduct(product, quantity, `${cart.id}:${product.id}`, this.now());
    await this.repository.saveCart(cart, expectedVersion);
    await this.record("Cart", cart.id, "CART_LINE_ADDED", { productId, quantity });
    return cart;
  }

  async removeCartLine(cartId: string, lineId: string): Promise<Cart> {
    const cart = await this.getCart(cartId);
    const expectedVersion = cart.version;
    cart.removeLine(lineId, this.now());
    await this.repository.saveCart(cart, expectedVersion);
    await this.record("Cart", cart.id, "CART_LINE_REMOVED", { lineId });
    return cart;
  }

  async checkout(cartId: string, idempotencyKey: string): Promise<Order> {
    const scope = `cart-checkout:${cartId}`;
    const requestHash = hashRequest({ cartId });
    const cart = await this.getCart(cartId);
    const previouslyCreated = await this.repository.findOrderByCartId(cartId);
    if (previouslyCreated) return previouslyCreated;
    if (cart.status === "OPEN") {
      const expectedVersion = cart.version;
      cart.markCheckedOut(this.now());
      await this.repository.saveCart(cart, expectedVersion);
    } else if (cart.status !== "CHECKED_OUT") {
      throw new ApplicationError(`Cart cannot be checked out while ${cart.status}`, "CART_NOT_OPEN", 409);
    }
    const proposedOrderId = randomUUID();
    const claim = await this.claimIdempotency({
      scope,
      key: idempotencyKey,
      requestHash,
      state: "IN_PROGRESS",
      resourceId: proposedOrderId
    });
    if (!claim.claimed) {
      const resourceId = claim.record.resourceId;
      if (!resourceId) {
        throw new ApplicationError("Checkout is already in progress", "IDEMPOTENCY_IN_PROGRESS", 409);
      }
      const replayedOrder = await this.repository.getOrder(resourceId);
      if (replayedOrder) return replayedOrder;
      const repairedOrder = Order.fromCart(resourceId, cart, this.now());
      await this.repository.createOrder(repairedOrder);
      await this.completeIdempotency(scope, idempotencyKey, requestHash, repairedOrder.id);
      return repairedOrder;
    }
    const order = Order.fromCart(proposedOrderId, cart, this.now());
    try {
      await this.repository.createOrder(order);
    } catch (error) {
      // A different API process/key may have converted this cart after our
      // pre-check. The cart can have only one immutable order snapshot.
      const concurrentOrder = await this.repository.findOrderByCartId(cartId);
      if (!concurrentOrder) throw error;
      await this.completeIdempotency(
        scope,
        idempotencyKey,
        requestHash,
        concurrentOrder.id
      );
      return concurrentOrder;
    }
    await this.completeIdempotency(scope, idempotencyKey, requestHash, order.id);
    await this.record("Order", order.id, "ORDER_CREATED", {
      cartId,
      totalMinor: order.total.minorUnits.toString(),
      currency: order.currency
    });
    return order;
  }

  async getOrder(id: string): Promise<Order> {
    return (await this.repository.getOrder(id)) ?? Promise.reject(notFound("Order", id));
  }

  listOrders(
    search?: string,
    status?: OrderStatus,
    limit = 100,
    offset = 0
  ): Promise<readonly Order[]> {
    return this.repository.listOrders({
      limit,
      offset,
      ...(search ? { search } : {}),
      ...(status ? { status } : {})
    });
  }

  async startPayment(command: StartPaymentCommand): Promise<StartPaymentResult> {
    if (command.idempotencyKey.trim().length < 8) {
      throw new ApplicationError(
        "An Idempotency-Key of at least 8 characters is required",
        "IDEMPOTENCY_KEY_REQUIRED",
        400
      );
    }
    const scope = `order-payment:${command.orderId}`;
    const requestHash = hashRequest({
      orderId: command.orderId,
      tender: command.tender,
      terminalId: command.terminalId ?? null
    });
    const replay = await this.loadPaymentReplay(
      scope,
      command.idempotencyKey,
      requestHash,
      command
    );
    if (replay) return replay;

    const order = await this.getOrder(command.orderId);
    if (order.status === "PAID" || order.status === "REFUNDED") {
      throw new ApplicationError("The order is already paid", "ORDER_ALREADY_PAID", 409);
    }
    if (order.status !== "OPEN") {
      throw new ApplicationError(
        `Order cannot be paid while ${order.status}`,
        "ORDER_NOT_PAYABLE",
        409
      );
    }

    const selectedProvider = command.tender === "cash"
      ? undefined
      : this.providerForTender(command.tender);
    const providerName = selectedProvider?.name ?? "cash";
    const terminalId = command.tender === "cash"
      ? "cash-drawer"
      : command.tender === "vietnam_qr"
        ? "register-qr-display"
        : command.terminalId?.trim();
    if (!terminalId) {
      throw new ApplicationError("terminalId is required for card payments", "TERMINAL_REQUIRED");
    }

    const attempt = PaymentAttempt.create({
      id: randomUUID(),
      orderId: order.id,
      provider: providerName,
      amount: order.total,
      terminalId,
      idempotencyKey: command.idempotencyKey,
      createdAt: this.now()
    });
    const claim = await this.claimIdempotency({
      scope,
      key: command.idempotencyKey,
      requestHash,
      state: "IN_PROGRESS",
      resourceId: attempt.id
    });
    if (!claim.claimed) {
      if (!claim.record.resourceId) {
        throw new ApplicationError("Payment is already in progress", "IDEMPOTENCY_IN_PROGRESS", 409);
      }
      const replay = await this.repository.getPaymentAttempt(claim.record.resourceId);
      if (!replay) {
        throw new ApplicationError("Payment is still being committed", "IDEMPOTENCY_IN_PROGRESS", 409);
      }
      if (replay.status === "CREATED") {
        return { attempt: replay, replayed: true };
      }
      return this.getPaymentAttempt(replay.id, true);
    }
    const expectedOrderVersion = order.version;
    order.markPaymentPending(this.now());
    try {
      await this.repository.reservePaymentAttempt(order, attempt, expectedOrderVersion);
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        await this.failIdempotency(
          scope,
          command.idempotencyKey,
          requestHash,
          "The order is already being paid",
          409
        );
      }
      throw error;
    }

    if (command.tender === "cash") {
      const applied = await this.applyProviderResult(order, attempt, {
        attemptId: attempt.id,
        status: "CAPTURED",
        providerPaymentId: `cash_${attempt.id}`,
        providerReference: `cash_${attempt.id}`,
        failureCode: null,
        failureMessage: null,
        card: null,
        processedAt: this.now()
      });
      await this.completeIdempotency(scope, command.idempotencyKey, requestHash, attempt.id);
      return { ...applied, replayed: false };
    }

    let result: PaymentResult;
    try {
      result = await selectedProvider!.startSale({
        attemptId: attempt.id,
        orderId: order.id,
        amount: order.total,
        terminalId,
        idempotencyKey: providerPaymentIdempotencyKey(attempt),
        metadata: { orderId: order.id, tender: command.tender }
      });
    } catch (error) {
      const deterministic = error instanceof PaymentProviderError
        && !error.retryable
        && error.code !== "PROVIDER_UNAVAILABLE";
      await this.applyProviderResult(order, attempt, {
        attemptId: attempt.id,
        status: deterministic ? "CANCELED" : "UNKNOWN",
        providerPaymentId: null,
        providerReference: null,
        failureCode: error instanceof PaymentProviderError ? error.code : "PROVIDER_UNAVAILABLE",
        failureMessage: error instanceof Error ? error.message : "Payment provider unavailable",
        card: null,
        processedAt: this.now()
      });
      await this.completeIdempotency(scope, command.idempotencyKey, requestHash, attempt.id);
      throw error;
    }
    const applied = await this.applyProviderResult(order, attempt, result);
    await this.completeIdempotency(scope, command.idempotencyKey, requestHash, attempt.id);
    return { ...applied, replayed: false };
  }

  async getPaymentAttempt(id: string, refresh = true): Promise<StartPaymentResult> {
    const attempt = await this.repository.getPaymentAttempt(id);
    if (!attempt) throw notFound("Payment attempt", id);
    const existingPayments = await this.repository.listPaymentsForOrder(attempt.orderId);
    const existing = existingPayments.find((payment) => payment.paymentAttemptId === attempt.id);
    const order = await this.getOrder(attempt.orderId);
    if (existing) {
      await this.ensureOrderPaid(order, existing);
      return { attempt, payment: existing, replayed: false };
    }
    if (!refresh) return { attempt, replayed: false };

    if (attempt.status === "CAPTURED") {
      const result: PaymentResult = attempt.provider === "cash"
        ? {
            attemptId: attempt.id,
            status: "CAPTURED",
            providerPaymentId: attempt.providerReference,
            providerReference: attempt.providerReference,
            failureCode: null,
            failureMessage: null,
            card: null,
            processedAt: attempt.updatedAt
          }
        : await this.providerForName(attempt.provider).getStatus(attempt.id);
      const applied = await this.applyProviderResult(order, attempt, result);
      return { ...applied, replayed: false };
    }
    if (attempt.status === "DECLINED" || attempt.status === "CANCELED") {
      return { attempt, replayed: false };
    }
    if (attempt.provider === "cash") return { attempt, replayed: false };

    const result = await this.queryOrResumeProviderAttempt(attempt);
    const applied = await this.applyProviderResult(order, attempt, result);
    return { ...applied, replayed: false };
  }

  async cancelPaymentAttempt(id: string): Promise<PaymentAttempt> {
    const attempt = await this.repository.getPaymentAttempt(id);
    if (!attempt) throw notFound("Payment attempt", id);
    if (attempt.provider === "cash") {
      throw new ApplicationError("Captured cash payments cannot be canceled", "CANCEL_NOT_ALLOWED", 409);
    }
    const provider = this.providerForName(attempt.provider);
    if (!provider.capabilities.supportsCancellation) {
      throw new ApplicationError(
        "The configured payment provider does not support cancellation",
        "CANCEL_NOT_SUPPORTED",
        501
      );
    }
    if (TERMINAL_STATUSES.has(attempt.status)) {
      throw new ApplicationError(
        `Payment attempt cannot be canceled while ${attempt.status}`,
        "CANCEL_NOT_ALLOWED",
        409
      );
    }
    const order = await this.getOrder(attempt.orderId);
    const result = await provider.cancel(attempt.id);
    return (await this.applyProviderResult(order, attempt, result)).attempt;
  }

  async getPayment(id: string): Promise<Payment> {
    return (await this.repository.getPayment(id)) ?? Promise.reject(notFound("Payment", id));
  }

  async listPaymentsForOrder(orderId: string): Promise<readonly Payment[]> {
    return this.repository.listPaymentsForOrder(orderId);
  }

  async listRefundsForPayment(paymentId: string): Promise<readonly Refund[]> {
    return this.repository.listRefundsForPayment(paymentId);
  }

  async refundPayment(command: RefundCommand): Promise<RefundCommandResult> {
    const scope = `payment-refund:${command.paymentId}`;
    const requestHash = hashRequest({
      paymentId: command.paymentId,
      amountMinor: command.amountMinor,
      reason: command.reason
    });
    const existing = await this.repository.getIdempotency(scope, command.idempotencyKey);
    if (existing) {
      assertMatchingHash(existing, requestHash);
      if (existing.state === "FAILED") {
        throw new ApplicationError(
          "The original refund request was rejected",
          "REFUND_REJECTED",
          existing.responseStatus ?? 409
        );
      }
      if (!existing.resourceId) {
        throw new ApplicationError("Refund is already in progress", "IDEMPOTENCY_IN_PROGRESS", 409);
      }
      const refunds = await this.repository.listRefundsForPayment(command.paymentId);
      const payment = await this.getPayment(command.paymentId);
      const refundProvider = payment.provider === "cash"
        ? undefined
        : this.providerForName(payment.provider);
      let refund = refunds.find((candidate) => candidate.id === existing.resourceId);
      if (!refund) {
        if (existing.state !== "IN_PROGRESS") {
          throw new ApplicationError(
            "The saved refund result is unavailable",
            "REFUND_STATE_CONFLICT",
            409
          );
        }
        const amount = Money.fromMinor(parseMinor(command.amountMinor), payment.amount.currency);
        if (amount.minorUnits <= 0n) {
          throw new ApplicationError("Refund amount must be positive", "INVALID_REFUND_AMOUNT");
        }
        if (
          amount.compare(payment.amount) < 0 &&
          refundProvider !== undefined &&
          !refundProvider.capabilities.supportsPartialRefunds
        ) {
          throw new ApplicationError(
            "The configured payment provider does not support partial refunds",
            "PARTIAL_REFUND_NOT_SUPPORTED",
            409
          );
        }
        refund = Refund.create({
          id: existing.resourceId,
          paymentId: payment.id,
          provider: payment.provider,
          amount,
          idempotencyKey: command.idempotencyKey,
          createdAt: existing.createdAt
        });
        try {
          await this.repository.reserveRefund(refund);
        } catch (error) {
          if (error instanceof RepositoryConflictError) {
            await this.failIdempotency(
              scope,
              command.idempotencyKey,
              requestHash,
              "Refund capacity could not be reserved",
              409
            );
          }
          throw error;
        }
      }
      if (refund.status === "PENDING") {
        if (payment.provider === "cash") {
          refund.markSucceeded(`cash_refund_${refund.id}`, this.now());
        } else {
          const result = await refundProvider!.refund({
            refundId: refund.id,
            paymentId: payment.providerReference,
            amount: refund.amount,
            idempotencyKey: providerRefundIdempotencyKey(refund),
            metadata: { reason: command.reason }
          });
          this.applyRefundResult(refund, payment, result);
        }
        if (refund.version > 0) await this.repository.saveRefund(refund, 0);
        await this.completeIdempotency(scope, command.idempotencyKey, requestHash, refund.id);
      }
      if (refund.status === "SUCCEEDED") {
        await this.repairOrderAfterRefund(payment);
        await this.recordVietnamQrRefundTimeline(payment, refund);
      }
      return { refund, replayed: true };
    }

    const payment = await this.getPayment(command.paymentId);
    const amount = Money.fromMinor(parseMinor(command.amountMinor), payment.amount.currency);
    if (amount.minorUnits <= 0n) {
      throw new ApplicationError("Refund amount must be positive", "INVALID_REFUND_AMOUNT");
    }
    const refundProvider = payment.provider === "cash"
      ? undefined
      : this.providerForName(payment.provider);
    if (
      amount.compare(payment.amount) < 0 &&
      refundProvider !== undefined &&
      !refundProvider.capabilities.supportsPartialRefunds
    ) {
      throw new ApplicationError(
        "The configured payment provider does not support partial refunds",
        "PARTIAL_REFUND_NOT_SUPPORTED",
        409
      );
    }
    const prior = await this.repository.listRefundsForPayment(payment.id);
    const alreadyRefunded = prior
      .filter((refund) => refund.status === "SUCCEEDED" || refund.status === "PENDING")
      .reduce((sum, refund) => sum.add(refund.amount), Money.zero(payment.amount.currency));
    if (alreadyRefunded.add(amount).compare(payment.amount) > 0) {
      throw new ApplicationError(
        "Refund amount exceeds the remaining captured amount",
        "REFUND_EXCEEDS_CAPTURE",
        409
      );
    }

    const refund = Refund.create({
      id: randomUUID(),
      paymentId: payment.id,
      provider: payment.provider,
      amount,
      idempotencyKey: command.idempotencyKey,
      createdAt: this.now()
    });
    const claim = await this.claimIdempotency({
      scope,
      key: command.idempotencyKey,
      requestHash,
      state: "IN_PROGRESS",
      resourceId: refund.id
    });
    if (!claim.claimed) {
      if (!claim.record.resourceId) {
        throw new ApplicationError("Refund is already in progress", "IDEMPOTENCY_IN_PROGRESS", 409);
      }
      const refunds = await this.repository.listRefundsForPayment(payment.id);
      const replay = refunds.find((candidate) => candidate.id === claim.record.resourceId);
      if (!replay) {
        throw new ApplicationError("Refund is still being committed", "IDEMPOTENCY_IN_PROGRESS", 409);
      }
      if (replay.status === "SUCCEEDED") {
        await this.recordVietnamQrRefundTimeline(payment, replay);
      }
      return { refund: replay, replayed: true };
    }
    try {
      await this.repository.reserveRefund(refund);
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        await this.failIdempotency(
          scope,
          command.idempotencyKey,
          requestHash,
          "Refund capacity could not be reserved",
          409
        );
      }
      throw error;
    }

    if (payment.provider === "cash") {
      refund.markSucceeded(`cash_refund_${refund.id}`, this.now());
    } else {
      const result = await refundProvider!.refund({
        refundId: refund.id,
        paymentId: payment.providerReference,
        amount,
        idempotencyKey: providerRefundIdempotencyKey(refund),
        metadata: { reason: command.reason }
      });
      this.applyRefundResult(refund, payment, result);
    }
    if (refund.version > 0) await this.repository.saveRefund(refund, 0);
    await this.completeIdempotency(scope, command.idempotencyKey, requestHash, refund.id);
    await this.record("Refund", refund.id, "REFUND_UPDATED", {
      paymentId: payment.id,
      status: refund.status,
      amountMinor: refund.amount.minorUnits.toString(),
      reason: command.reason
    }, command.actorId ?? null);

    if (refund.status === "SUCCEEDED") {
      await this.repairOrderAfterRefund(payment);
      await this.recordVietnamQrRefundTimeline(payment, refund);
    }
    return { refund, replayed: false };
  }

  async verifyWebhook(
    rawBody: Uint8Array,
    headers: ProviderWebhookHeaders,
    providerName = this.defaultPaymentProvider.name
  ): Promise<ProviderEvent> {
    const event = await this.providerForName(providerName).verifyWebhook(rawBody, headers);
    await this.record("ProviderEvent", event.id, "PROVIDER_EVENT_VERIFIED", {
      type: event.type,
      occurredAt: event.occurredAt.toISOString()
    });
    const attemptId = event.data.attemptId;
    if (typeof attemptId === "string") await this.getPaymentAttempt(attemptId, true);
    return event;
  }

  reconciliationSummary(query: ReconciliationQuery): Promise<ReconciliationSummary> {
    return this.repository.reconciliationSummary(query);
  }

  async close(): Promise<void> {
    await this.repository.close();
  }

  private async loadPaymentReplay(
    scope: string,
    key: string,
    requestHash: string,
    command: StartPaymentCommand
  ): Promise<StartPaymentResult | undefined> {
    const existing = await this.repository.getIdempotency(scope, key);
    if (!existing) return undefined;
    assertMatchingHash(existing, requestHash);
    if (existing.state === "FAILED") {
      const message = idempotencyFailureMessage(existing) ?? "The original payment request was rejected";
      throw new ApplicationError(message, "PAYMENT_REJECTED", existing.responseStatus ?? 409);
    }
    if (!existing.resourceId) {
      throw new ApplicationError("Payment is already in progress", "IDEMPOTENCY_IN_PROGRESS", 409);
    }
    // A replay can be the recovery path after the first response was UNKNOWN
    // or the client lost the response. Query the original provider attempt;
    // never create a second charge.
    const stored = await this.repository.getPaymentAttempt(existing.resourceId);
    if (!stored) {
      if (existing.state !== "IN_PROGRESS") {
        throw new ApplicationError(
          "The saved payment result is unavailable",
          "PAYMENT_STATE_CONFLICT",
          409
        );
      }
      return this.recoverUncommittedPaymentClaim(existing, scope, key, requestHash, command);
    }
    const result = stored.status === "CREATED"
      ? await this.resumeCreatedAttempt(stored, scope, key, requestHash)
      : await this.getPaymentAttempt(existing.resourceId, true);
    return { ...result, replayed: true };
  }

  private async recoverUncommittedPaymentClaim(
    record: IdempotencyRecord,
    scope: string,
    key: string,
    requestHash: string,
    command: StartPaymentCommand
  ): Promise<StartPaymentResult> {
    if (!record.resourceId) {
      throw new ApplicationError("Payment is already in progress", "IDEMPOTENCY_IN_PROGRESS", 409);
    }
    const order = await this.getOrder(command.orderId);
    if (order.status !== "OPEN") {
      const code = order.status === "PAID" || order.status === "REFUNDED"
        ? "ORDER_ALREADY_PAID"
        : "IDEMPOTENCY_IN_PROGRESS";
      throw new ApplicationError(
        order.status === "PAID" || order.status === "REFUNDED"
          ? "The order is already paid"
          : "Another payment is already in progress",
        code,
        409
      );
    }
    const terminalId = command.tender === "cash"
      ? "cash-drawer"
      : command.tender === "vietnam_qr"
        ? "register-qr-display"
        : command.terminalId?.trim();
    if (!terminalId) {
      throw new ApplicationError("terminalId is required for card payments", "TERMINAL_REQUIRED");
    }
    const attempt = PaymentAttempt.create({
      id: record.resourceId,
      orderId: order.id,
      provider: command.tender === "cash" ? "cash" : this.providerForTender(command.tender).name,
      amount: order.total,
      terminalId,
      idempotencyKey: key,
      createdAt: record.createdAt
    });
    const expectedVersion = order.version;
    order.markPaymentPending(this.now());
    try {
      await this.repository.reservePaymentAttempt(order, attempt, expectedVersion);
    } catch (error) {
      const concurrentlyCommitted = await this.repository.getPaymentAttempt(attempt.id);
      if (concurrentlyCommitted) {
        return this.resumeCreatedAttempt(concurrentlyCommitted, scope, key, requestHash);
      }
      if (error instanceof RepositoryConflictError) {
        await this.failIdempotency(
          scope,
          key,
          requestHash,
          "The order is already being paid",
          409
        );
      }
      throw error;
    }
    return this.resumeCreatedAttempt(attempt, scope, key, requestHash);
  }

  private async resumeCreatedAttempt(
    attempt: PaymentAttempt,
    scope: string,
    key: string,
    requestHash: string
  ): Promise<StartPaymentResult> {
    const order = await this.getOrder(attempt.orderId);
    const payments = await this.repository.listPaymentsForOrder(order.id);
    const ownPayment = payments.find((payment) => payment.paymentAttemptId === attempt.id);
    if (ownPayment) {
      await this.ensureOrderPaid(order, ownPayment);
      await this.completeIdempotency(scope, key, requestHash, attempt.id);
      return { attempt, payment: ownPayment, replayed: true };
    }
    if (payments.length > 0 || order.status === "PAID" || order.status === "REFUNDED") {
      await this.completeIdempotency(scope, key, requestHash, attempt.id);
      throw new ApplicationError("The order is already paid", "ORDER_ALREADY_PAID", 409);
    }
    if (order.status === "CANCELED") {
      throw new ApplicationError("The order is canceled", "ORDER_NOT_PAYABLE", 409);
    }
    if (order.status === "OPEN") {
      const expectedVersion = order.version;
      order.markPaymentPending(this.now());
      await this.repository.saveOrder(order, expectedVersion);
    }
    const result: PaymentResult = attempt.provider === "cash"
      ? {
          attemptId: attempt.id,
          status: "CAPTURED",
          providerPaymentId: `cash_${attempt.id}`,
          providerReference: `cash_${attempt.id}`,
          failureCode: null,
          failureMessage: null,
          card: null,
          processedAt: this.now()
        }
      : await this.providerForName(attempt.provider).startSale({
          attemptId: attempt.id,
          orderId: attempt.orderId,
          amount: attempt.amount,
          terminalId: attempt.terminalId,
          idempotencyKey: providerPaymentIdempotencyKey(attempt),
          metadata: {
            orderId: attempt.orderId,
            tender: attempt.provider.includes("vietnam-qr") ? "vietnam_qr" : "card"
          }
        });
    const applied = await this.applyProviderResult(order, attempt, result);
    await this.completeIdempotency(scope, key, requestHash, attempt.id);
    return { ...applied, replayed: true };
  }

  private async applyProviderResult(
    order: Order,
    attempt: PaymentAttempt,
    result: PaymentResult
  ): Promise<AppliedPaymentResult> {
    if (result.attemptId !== attempt.id) {
      throw new ApplicationError("Provider returned the wrong attempt", "PROVIDER_RESULT_MISMATCH", 502);
    }
    const previousVersion = attempt.version;
    const persistedAttempt = await this.persistProviderTransition(attempt, result);
    if (persistedAttempt.status === "CAPTURED") {
      const existing = (await this.repository.listPaymentsForOrder(order.id)).find(
        (payment) => payment.paymentAttemptId === persistedAttempt.id
      );
      if (existing) {
        await this.ensureOrderPaid(order, existing);
        return {
          attempt: persistedAttempt,
          payment: existing,
          ...(result.presentation ? { presentation: result.presentation } : {}),
          ...(result.wallet ? { wallet: result.wallet } : {})
        };
      }
      // A stale non-capture response may lose a CAS race to the capture path.
      // Let the winning request create the Payment; a later read repairs any
      // crash between the captured attempt and payment insert.
      if (result.status !== "CAPTURED") return { attempt: persistedAttempt };
      const payment = await this.capturePayment(order, persistedAttempt, result);
      return {
        attempt: persistedAttempt,
        payment,
        ...(result.wallet ? { wallet: result.wallet } : {})
      };
    }
    if (
      (persistedAttempt.status === "DECLINED" || persistedAttempt.status === "CANCELED") &&
      order.status === "PAYMENT_PENDING"
    ) {
      await this.reopenOrderAfterFailedPayment(order, result.processedAt);
    }
    if (persistedAttempt.version !== previousVersion) {
      await this.record("PaymentAttempt", persistedAttempt.id, "PAYMENT_ATTEMPT_UPDATED", {
        orderId: persistedAttempt.orderId,
        status: persistedAttempt.status,
        provider: persistedAttempt.provider,
        failureCode: persistedAttempt.failureCode
      });
    }
    return {
      attempt: persistedAttempt,
      ...(result.presentation ? { presentation: result.presentation } : {}),
      ...(result.wallet ? { wallet: result.wallet } : {})
    };
  }

  private async capturePayment(
    order: Order,
    attempt: PaymentAttempt,
    result: PaymentResult
  ): Promise<Payment> {
    const providerReference = result.providerPaymentId ?? result.providerReference;
    if (!providerReference) {
      throw new ApplicationError(
        "Captured provider result has no payment reference",
        "MISSING_PROVIDER_REFERENCE",
        502
      );
    }
    const proposedPayment = new Payment({
      id: randomUUID(),
      orderId: order.id,
      paymentAttemptId: attempt.id,
      provider: attempt.provider,
      providerReference,
      amount: attempt.amount,
      card: result.card,
      capturedAt: result.processedAt
    });
    let payment = proposedPayment;
    let created = true;
    try {
      await this.repository.createPayment(proposedPayment);
    } catch (error) {
      if (!(error instanceof RepositoryConflictError)) throw error;
      const existing = (await this.repository.listPaymentsForOrder(order.id)).find(
        (candidate) => candidate.paymentAttemptId === attempt.id
      );
      if (!existing) throw error;
      payment = existing;
      created = false;
    }
    await this.ensureOrderPaid(order, payment, result.processedAt);
    if (created) {
      await this.record("Payment", payment.id, "PAYMENT_CAPTURED", {
        orderId: order.id,
        provider: payment.provider,
        amountMinor: payment.amount.minorUnits.toString(),
        currency: payment.amount.currency
      });
    }
    return payment;
  }

  private async persistProviderTransition(
    initial: PaymentAttempt,
    result: PaymentResult
  ): Promise<PaymentAttempt> {
    let current = initial;
    for (let retry = 0; retry < 4; retry += 1) {
      if (result.processedAt.getTime() < current.updatedAt.getTime()) return current;
      if (TERMINAL_STATUSES.has(current.status) && result.status !== "CAPTURED") {
        return current;
      }

      const expectedVersion = current.version;
      const qrChanged = result.vietnamQr
        ? current.updateVietnamQr(result.vietnamQr, result.processedAt)
        : false;
      if (current.status !== result.status) {
        current.transitionTo(result.status, {
          ...(result.providerReference ? { providerReference: result.providerReference } : {}),
          failureCode: result.failureCode,
          at: result.processedAt
        });
      } else if (!qrChanged) {
        return current;
      }
      try {
        return await this.repository.savePaymentAttempt(current, expectedVersion);
      } catch (error) {
        if (!(error instanceof RepositoryConflictError)) throw error;
        const fresh = await this.repository.getPaymentAttempt(initial.id);
        if (!fresh) throw error;
        current = fresh;
      }
    }
    throw new ApplicationError(
      "Payment state changed too many times; retry status retrieval",
      "PAYMENT_STATE_CONFLICT",
      409
    );
  }

  private async queryOrResumeProviderAttempt(attempt: PaymentAttempt): Promise<PaymentResult> {
    const provider = this.providerForName(attempt.provider);
    try {
      return await provider.getStatus(attempt.id);
    } catch (error) {
      if (!(error instanceof PaymentProviderError) || error.code !== "ATTEMPT_NOT_FOUND") {
        throw error;
      }
      return provider.startSale({
        attemptId: attempt.id,
        orderId: attempt.orderId,
        amount: attempt.amount,
        terminalId: attempt.terminalId,
        idempotencyKey: providerPaymentIdempotencyKey(attempt),
        metadata: {
          orderId: attempt.orderId,
          tender: attempt.provider.includes("vietnam-qr") ? "vietnam_qr" : "card"
        }
      });
    }
  }

  private async ensureOrderPaid(
    initial: Order,
    payment: Payment,
    paidAt: Date = this.now()
  ): Promise<Order> {
    let order = initial;
    for (let retry = 0; retry < 4; retry += 1) {
      if (order.status === "PAID" || order.status === "REFUNDED") return order;
      if (order.status !== "OPEN" && order.status !== "PAYMENT_PENDING") {
        throw new ApplicationError(
          `Captured payment cannot complete an order while ${order.status}`,
          "ORDER_PAYMENT_STATE_CONFLICT",
          409
        );
      }
      const expectedVersion = order.version;
      const transitionAt = new Date(Math.max(paidAt.getTime(), order.updatedAt.getTime()));
      if (order.status === "OPEN") order.markPaymentPending(transitionAt);
      order.markPaid(payment.amount, transitionAt);
      try {
        return await this.repository.saveOrder(order, expectedVersion);
      } catch (error) {
        if (!(error instanceof RepositoryConflictError)) throw error;
        const fresh = await this.repository.getOrder(initial.id);
        if (!fresh) throw error;
        order = fresh;
      }
    }
    throw new ApplicationError("Order state changed too many times", "ORDER_STATE_CONFLICT", 409);
  }

  private async reopenOrderAfterFailedPayment(initial: Order, failedAt: Date): Promise<void> {
    let order = initial;
    for (let retry = 0; retry < 4; retry += 1) {
      if (order.status !== "PAYMENT_PENDING") return;
      const expectedVersion = order.version;
      const transitionAt = new Date(Math.max(failedAt.getTime(), order.updatedAt.getTime()));
      order.reopenAfterFailedPayment(transitionAt);
      try {
        await this.repository.saveOrder(order, expectedVersion);
        return;
      } catch (error) {
        if (!(error instanceof RepositoryConflictError)) throw error;
        const fresh = await this.repository.getOrder(initial.id);
        if (!fresh) throw error;
        order = fresh;
      }
    }
  }

  private applyRefundResult(
    refund: Refund,
    payment: Payment,
    result: RefundResult
  ): void {
    if (
      result.refundId !== refund.id ||
      result.paymentId !== payment.providerReference ||
      !result.amount.equals(refund.amount)
    ) {
      throw new ApplicationError(
        "Provider returned refund data that does not match the request",
        "PROVIDER_REFUND_MISMATCH",
        502
      );
    }
    if (result.status === "SUCCEEDED") {
      if (!result.providerRefundId) {
        throw new ApplicationError(
          "Successful provider refund has no reference",
          "MISSING_PROVIDER_REFERENCE",
          502
        );
      }
      refund.markSucceeded(result.providerRefundId, result.processedAt);
    } else if (result.status === "FAILED") {
      refund.markFailed(result.failureCode ?? "REFUND_FAILED", result.processedAt);
    }
  }

  private async repairOrderAfterRefund(payment: Payment): Promise<void> {
    const allRefunds = await this.repository.listRefundsForPayment(payment.id);
    const total = allRefunds
      .filter((candidate) => candidate.status === "SUCCEEDED")
      .reduce((sum, candidate) => sum.add(candidate.amount), Money.zero(payment.amount.currency));
    if (!total.equals(payment.amount)) return;
    const order = await this.getOrder(payment.orderId);
    if (order.status === "PAID") {
      const expectedVersion = order.version;
      order.markRefunded(total, this.now());
      await this.repository.saveOrder(order, expectedVersion);
    }
  }

  private async recordVietnamQrRefundTimeline(
    payment: Payment,
    refund: Refund,
  ): Promise<void> {
    if (!payment.provider.includes("vietnam-qr")) return;
    for (let retry = 0; retry < 4; retry += 1) {
      const attempt = await this.repository.getPaymentAttempt(payment.paymentAttemptId);
      if (!attempt?.vietnamQr) return;
      const expectedVersion = attempt.version;
      const appended = attempt.appendVietnamQrTimelineEvent({
        id: `refund:${refund.id}`,
        type: "REFUNDED",
        description: `Refunded ${refund.amount.minorUnits.toString()} ${refund.amount.currency} minor units`,
        occurredAt: refund.updatedAt,
      });
      if (!appended) return;
      try {
        await this.repository.savePaymentAttempt(attempt, expectedVersion);
        return;
      } catch (error) {
        if (!(error instanceof RepositoryConflictError)) throw error;
      }
    }
    throw new ApplicationError(
      "Vietnam QR timeline changed too many times",
      "PAYMENT_STATE_CONFLICT",
      409,
    );
  }

  private async record(
    aggregateType: string,
    aggregateId: string,
    action: string,
    metadata: Readonly<Record<string, unknown>>,
    actorId: string | null = null
  ): Promise<void> {
    const occurredAt = this.now();
    await Promise.all([
      this.repository.appendAudit(new AuditEntry({
        id: randomUUID(),
        aggregateType,
        aggregateId,
        action,
        actorId,
        metadata,
        occurredAt
      })),
      this.repository.enqueueOutbox(OutboxMessage.create({
        id: randomUUID(),
        topic: action.toLocaleLowerCase().replaceAll("_", "."),
        aggregateId,
        payload: { aggregateType, aggregateId, action, ...metadata },
        occurredAt
      }))
    ]);
  }

  private claimIdempotency(
    input: Pick<IdempotencyRecord, "scope" | "key" | "requestHash" | "state" | "resourceId">
  ): Promise<IdempotencyClaim> {
    const timestamp = this.now();
    return this.repository.claimIdempotency({
      ...input,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(timestamp.getTime() + 24 * 60 * 60 * 1000)
    });
  }

  private completeIdempotency(
    scope: string,
    key: string,
    requestHash: string,
    resourceId: string
  ): Promise<IdempotencyRecord> {
    const timestamp = this.now();
    return this.repository.saveIdempotency({
      scope,
      key,
      requestHash,
      state: "COMPLETED",
      resourceId,
      responseStatus: 200,
      responseBody: { resourceId },
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(timestamp.getTime() + 24 * 60 * 60 * 1000)
    });
  }

  private failIdempotency(
    scope: string,
    key: string,
    requestHash: string,
    message: string,
    responseStatus: number
  ): Promise<IdempotencyRecord> {
    const timestamp = this.now();
    return this.repository.saveIdempotency({
      scope,
      key,
      requestHash,
      state: "FAILED",
      responseStatus,
      responseBody: { message },
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(timestamp.getTime() + 24 * 60 * 60 * 1000)
    });
  }
}

function parseMinor(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new ApplicationError("Money must be an integer minor-unit string", "INVALID_MONEY");
  }
  return BigInt(value);
}

function hashRequest(value: Readonly<Record<string, unknown>>): string {
  const canonical = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`)
    .join(",");
  return createHash("sha256").update(`{${canonical}}`).digest("hex");
}

function assertMatchingHash(record: IdempotencyRecord, requestHash: string): void {
  if (record.requestHash !== requestHash) {
    throw new ApplicationError(
      "The Idempotency-Key was already used for a different request",
      "IDEMPOTENCY_CONFLICT",
      409
    );
  }
}

function idempotencyFailureMessage(record: IdempotencyRecord): string | undefined {
  if (
    record.responseBody !== null &&
    typeof record.responseBody === "object" &&
    "message" in record.responseBody &&
    typeof record.responseBody.message === "string"
  ) {
    return record.responseBody.message;
  }
  return undefined;
}

function providerPaymentIdempotencyKey(attempt: PaymentAttempt): string {
  return `payment:${attempt.orderId}:${attempt.idempotencyKey}`;
}

function providerRefundIdempotencyKey(refund: Refund): string {
  return `refund:${refund.paymentId}:${refund.idempotencyKey}`;
}
