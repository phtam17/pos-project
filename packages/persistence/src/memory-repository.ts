import type {
  AuditEntry,
  Cart,
  Order,
  OutboxMessage,
  Payment,
  PaymentAttempt,
  Product,
  Refund,
  SettlementBatch
} from "@pos/domain";
import { Money } from "@pos/domain";

import {
  IdempotencyConflictError,
  RepositoryConflictError,
  RepositoryNotFoundError
} from "./errors.js";
import type {
  AuditQuery,
  IdempotencyClaim,
  IdempotencyRecord,
  OrderQuery,
  PosRepository,
  ProductQuery,
  ReconciliationQuery,
  ReconciliationSummary
} from "./repository.js";

type SnapshotAggregate<T> = T & {
  toSnapshot(): unknown;
  constructor: { rehydrate?(snapshot: unknown): T };
};

function cloneAggregate<T>(value: T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    "toSnapshot" in value &&
    typeof (value as { toSnapshot?: unknown }).toSnapshot === "function"
  ) {
    const aggregate = value as SnapshotAggregate<T>;
    if (typeof aggregate.constructor.rehydrate === "function") {
      return aggregate.constructor.rehydrate(aggregate.toSnapshot());
    }
  }

  return structuredClone(value);
}

function cloneIdempotency(record: IdempotencyRecord): IdempotencyRecord {
  const optional = {
    ...(record.responseStatus === undefined
      ? {}
      : { responseStatus: record.responseStatus }),
    ...(record.responseBody === undefined
      ? {}
      : { responseBody: structuredClone(record.responseBody) }),
    ...(record.resourceId === undefined ? {} : { resourceId: record.resourceId })
  };
  return Object.freeze({
    scope: record.scope,
    key: record.key,
    requestHash: record.requestHash,
    state: record.state,
    ...optional,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    expiresAt: new Date(record.expiresAt)
  });
}

function readSnapshot(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") return {};
  const candidate = value as { toSnapshot?: () => unknown };
  const snapshot = typeof candidate.toSnapshot === "function" ? candidate.toSnapshot() : value;
  return snapshot !== null && typeof snapshot === "object"
    ? (snapshot as Record<string, unknown>)
    : {};
}

function idOf(value: unknown): string {
  const id = readSnapshot(value).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("Persisted aggregate must have a non-empty string id");
  }
  return id;
}

function textField(value: unknown, field: string): string | undefined {
  const candidate = readSnapshot(value)[field];
  return typeof candidate === "string" ? candidate : undefined;
}

function dateField(value: unknown, field: string): Date | undefined {
  const candidate = readSnapshot(value)[field];
  if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) {
    return candidate;
  }
  return undefined;
}

function moneyField(value: unknown, field: string): Money | undefined {
  const candidate = readSnapshot(value)[field];
  return candidate instanceof Money ? candidate : undefined;
}

function numberField(value: unknown, field: string): number | undefined {
  const candidate = readSnapshot(value)[field];
  return typeof candidate === "number" ? candidate : undefined;
}

function aggregateSortDate(value: unknown): number {
  return (
    dateField(value, "createdAt") ??
    dateField(value, "occurredAt") ??
    dateField(value, "capturedAt") ??
    new Date(0)
  ).getTime();
}

function isInRange(value: Date | undefined, query: ReconciliationQuery): boolean {
  return value !== undefined && value >= query.from && value < query.to;
}

/**
 * Zero-dependency repository used by local development and unit tests. Domain
 * aggregates are rehydrated on read so callers never mutate repository state.
 */
export class MemoryPosRepository implements PosRepository {
  private readonly products = new Map<string, Product>();
  private readonly carts = new Map<string, Cart>();
  private readonly orders = new Map<string, Order>();
  private readonly paymentAttempts = new Map<string, PaymentAttempt>();
  private readonly payments = new Map<string, Payment>();
  private readonly refunds = new Map<string, Refund>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly auditEntries = new Map<string, AuditEntry>();
  private readonly outboxMessages = new Map<string, OutboxMessage>();
  private readonly publishedOutbox = new Map<string, Date>();
  private readonly outboxLocks = new Map<string, Date>();
  private readonly settlementBatches = new Map<string, SettlementBatch>();

  async healthCheck(): Promise<void> {}

  constructor(initialProducts: readonly Product[] = []) {
    for (const product of initialProducts) {
      const id = idOf(product);
      if (this.products.has(id)) throw new RepositoryConflictError("Product", id);
      this.products.set(id, cloneAggregate(product));
    }
  }

  async listProducts(query: ProductQuery = {}): Promise<readonly Product[]> {
    const search = query.search?.trim().toLocaleLowerCase();
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(0, query.limit ?? 500);
    return [...this.products.values()]
      .filter((product) => !query.activeOnly || readSnapshot(product).active === true)
      .filter((product) => {
        if (!search) return true;
        const snapshot = readSnapshot(product);
        return [snapshot.name, snapshot.sku].some(
          (candidate) =>
            typeof candidate === "string" && candidate.toLocaleLowerCase().includes(search)
        );
      })
      .sort((left, right) => {
        const leftName = textField(left, "name") ?? "";
        const rightName = textField(right, "name") ?? "";
        return leftName.localeCompare(rightName) || idOf(left).localeCompare(idOf(right));
      })
      .slice(offset, offset + limit)
      .map(cloneAggregate);
  }

  async getProduct(id: string): Promise<Product | undefined> {
    const product = this.products.get(id);
    return product === undefined ? undefined : cloneAggregate(product);
  }

  async createProduct(product: Product): Promise<Product> {
    const id = idOf(product);
    if (this.products.has(id)) throw new RepositoryConflictError("Product", id);
    const sku = textField(product, "sku");
    if (
      sku !== undefined &&
      [...this.products.values()].some((candidate) => textField(candidate, "sku") === sku)
    ) {
      throw new RepositoryConflictError("Product SKU", sku);
    }
    this.products.set(id, cloneAggregate(product));
    return cloneAggregate(product);
  }

  async createCart(cart: Cart): Promise<Cart> {
    return this.create(this.carts, "Cart", cart);
  }

  async getCart(id: string): Promise<Cart | undefined> {
    return this.get(this.carts, id);
  }

  async saveCart(cart: Cart, expectedVersion?: number): Promise<Cart> {
    const id = idOf(cart);
    const current = this.carts.get(id);
    if (!current) throw new RepositoryNotFoundError("Cart", id);
    if (expectedVersion !== undefined && numberField(current, "version") !== expectedVersion) {
      throw new RepositoryConflictError("Cart", id);
    }
    this.carts.set(id, cloneAggregate(cart));
    return cloneAggregate(cart);
  }

  async createOrder(order: Order): Promise<Order> {
    const cartId = textField(order, "cartId");
    if (
      cartId !== undefined &&
      [...this.orders.values()].some((candidate) => textField(candidate, "cartId") === cartId)
    ) {
      throw new RepositoryConflictError("Order cart", cartId);
    }
    return this.create(this.orders, "Order", order);
  }

  async listOrders(query: OrderQuery = {}): Promise<readonly Order[]> {
    const search = query.search?.trim().toLocaleLowerCase();
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(0, query.limit ?? 100);
    return [...this.orders.values()]
      .filter((order) => !query.status || textField(order, "status") === query.status)
      .filter((order) => {
        if (!search) return true;
        const snapshot = readSnapshot(order);
        const lines = Array.isArray(snapshot.lines) ? snapshot.lines : [];
        return [snapshot.id, ...lines.flatMap((line) => {
          const candidate = readSnapshot(line);
          return [candidate.name, candidate.sku];
        })].some(
          (candidate) =>
            typeof candidate === "string" && candidate.toLocaleLowerCase().includes(search)
        );
      })
      .sort((left, right) => aggregateSortDate(right) - aggregateSortDate(left))
      .slice(offset, offset + limit)
      .map(cloneAggregate);
  }

  async getOrder(id: string): Promise<Order | undefined> {
    return this.get(this.orders, id);
  }

  async findOrderByCartId(cartId: string): Promise<Order | undefined> {
    const order = [...this.orders.values()].find(
      (candidate) => textField(candidate, "cartId") === cartId
    );
    return order === undefined ? undefined : cloneAggregate(order);
  }

  async saveOrder(order: Order, expectedVersion?: number): Promise<Order> {
    const id = idOf(order);
    const current = this.orders.get(id);
    if (!current) throw new RepositoryNotFoundError("Order", id);
    if (expectedVersion !== undefined && numberField(current, "version") !== expectedVersion) {
      throw new RepositoryConflictError("Order", id);
    }
    this.orders.set(id, cloneAggregate(order));
    return cloneAggregate(order);
  }

  async createPaymentAttempt(attempt: PaymentAttempt): Promise<PaymentAttempt> {
    const key = textField(attempt, "idempotencyKey");
    const orderId = textField(attempt, "orderId");
    if (
      key !== undefined &&
      [...this.paymentAttempts.values()].some(
        (candidate) =>
          textField(candidate, "orderId") === orderId &&
          textField(candidate, "idempotencyKey") === key
      )
    ) {
      throw new RepositoryConflictError("PaymentAttempt idempotency key", key);
    }
    this.assertUniqueProviderReference(
      this.paymentAttempts,
      "PaymentAttempt provider reference",
      attempt
    );
    return this.create(this.paymentAttempts, "PaymentAttempt", attempt);
  }

  async reservePaymentAttempt(
    order: Order,
    attempt: PaymentAttempt,
    expectedOrderVersion: number
  ): Promise<PaymentAttempt> {
    const orderId = idOf(order);
    const currentOrder = this.orders.get(orderId);
    if (!currentOrder) throw new RepositoryNotFoundError("Order", orderId);
    if (numberField(currentOrder, "version") !== expectedOrderVersion) {
      throw new RepositoryConflictError("Order", orderId);
    }

    const attemptId = idOf(attempt);
    if (this.paymentAttempts.has(attemptId)) {
      throw new RepositoryConflictError("PaymentAttempt", attemptId);
    }
    const key = textField(attempt, "idempotencyKey");
    if (
      key !== undefined &&
      [...this.paymentAttempts.values()].some(
        (candidate) =>
          textField(candidate, "orderId") === orderId &&
          textField(candidate, "idempotencyKey") === key
      )
    ) {
      throw new RepositoryConflictError("PaymentAttempt idempotency key", key);
    }
    this.assertUniqueProviderReference(
      this.paymentAttempts,
      "PaymentAttempt provider reference",
      attempt
    );

    // No awaits occur between these writes, so the in-memory adapter exposes
    // the order reservation and attempt creation as one atomic operation.
    this.orders.set(orderId, cloneAggregate(order));
    this.paymentAttempts.set(attemptId, cloneAggregate(attempt));
    return cloneAggregate(attempt);
  }

  async getPaymentAttempt(id: string): Promise<PaymentAttempt | undefined> {
    return this.get(this.paymentAttempts, id);
  }

  async savePaymentAttempt(
    attempt: PaymentAttempt,
    expectedVersion?: number
  ): Promise<PaymentAttempt> {
    const id = idOf(attempt);
    const current = this.paymentAttempts.get(id);
    if (!current) throw new RepositoryNotFoundError("PaymentAttempt", id);
    if (expectedVersion !== undefined && numberField(current, "version") !== expectedVersion) {
      throw new RepositoryConflictError("PaymentAttempt", id);
    }
    this.assertUniqueProviderReference(
      this.paymentAttempts,
      "PaymentAttempt provider reference",
      attempt,
      id
    );
    this.paymentAttempts.set(id, cloneAggregate(attempt));
    return cloneAggregate(attempt);
  }

  async createPayment(payment: Payment): Promise<Payment> {
    const snapshot = readSnapshot(payment);
    const provider = snapshot.provider;
    const providerPaymentId = snapshot.providerReference;
    if (
      typeof provider === "string" &&
      typeof providerPaymentId === "string" &&
      [...this.payments.values()].some((candidate) => {
        const other = readSnapshot(candidate);
        return other.provider === provider && other.providerReference === providerPaymentId;
      })
    ) {
      throw new RepositoryConflictError(
        "Provider payment",
        `${provider}/${providerPaymentId}`
      );
    }
    return this.create(this.payments, "Payment", payment);
  }

  async getPayment(id: string): Promise<Payment | undefined> {
    return this.get(this.payments, id);
  }

  async findPaymentByProviderReference(
    provider: string,
    providerReference: string
  ): Promise<Payment | undefined> {
    const payment = [...this.payments.values()].find(
      (candidate) =>
        textField(candidate, "provider") === provider &&
        textField(candidate, "providerReference") === providerReference
    );
    return payment === undefined ? undefined : cloneAggregate(payment);
  }

  async listPaymentsForOrder(orderId: string): Promise<readonly Payment[]> {
    return [...this.payments.values()]
      .filter((payment) => textField(payment, "orderId") === orderId)
      .sort((left, right) => aggregateSortDate(left) - aggregateSortDate(right))
      .map(cloneAggregate);
  }

  async createRefund(refund: Refund): Promise<Refund> {
    const snapshot = readSnapshot(refund);
    const provider = snapshot.provider;
    const providerRefundId = snapshot.providerReference;
    if (
      typeof provider === "string" &&
      typeof providerRefundId === "string" &&
      [...this.refunds.values()].some((candidate) => {
        const other = readSnapshot(candidate);
        return other.provider === provider && other.providerReference === providerRefundId;
      })
    ) {
      throw new RepositoryConflictError(
        "Provider refund",
        `${provider}/${providerRefundId}`
      );
    }
    const idempotencyKey = textField(refund, "idempotencyKey");
    const paymentId = textField(refund, "paymentId");
    if (
      idempotencyKey !== undefined &&
      [...this.refunds.values()].some(
        (candidate) =>
          textField(candidate, "paymentId") === paymentId &&
          textField(candidate, "idempotencyKey") === idempotencyKey
      )
    ) {
      throw new RepositoryConflictError("Refund idempotency key", idempotencyKey);
    }
    return this.create(this.refunds, "Refund", refund);
  }

  async reserveRefund(refund: Refund): Promise<Refund> {
    const snapshot = readSnapshot(refund);
    const paymentId = textField(refund, "paymentId");
    const payment = paymentId ? this.payments.get(paymentId) : undefined;
    const captured = payment ? moneyField(payment, "amount") : undefined;
    const requested = moneyField(refund, "amount");
    if (!paymentId || !captured || !requested) {
      throw new RepositoryNotFoundError("Payment", paymentId ?? "unknown");
    }
    let reserved = Money.zero(captured.currency);
    for (const candidate of this.refunds.values()) {
      if (
        textField(candidate, "paymentId") === paymentId &&
        ["PENDING", "SUCCEEDED"].includes(textField(candidate, "status") ?? "")
      ) {
        reserved = reserved.add(moneyField(candidate, "amount") ?? Money.zero(captured.currency));
      }
    }
    if (reserved.add(requested).compare(captured) > 0) {
      throw new RepositoryConflictError("Refund capacity", paymentId);
    }
    return this.createRefund(refund);
  }

  async listRefundsForPayment(paymentId: string): Promise<readonly Refund[]> {
    return [...this.refunds.values()]
      .filter((refund) => textField(refund, "paymentId") === paymentId)
      .sort((left, right) => aggregateSortDate(left) - aggregateSortDate(right))
      .map(cloneAggregate);
  }

  async findRefundByProviderReference(
    provider: string,
    providerReference: string
  ): Promise<Refund | undefined> {
    const refund = [...this.refunds.values()].find(
      (candidate) =>
        textField(candidate, "provider") === provider &&
        textField(candidate, "providerReference") === providerReference
    );
    return refund === undefined ? undefined : cloneAggregate(refund);
  }

  async saveRefund(refund: Refund, expectedVersion?: number): Promise<Refund> {
    const id = idOf(refund);
    const current = this.refunds.get(id);
    if (!current) throw new RepositoryNotFoundError("Refund", id);
    if (expectedVersion !== undefined && numberField(current, "version") !== expectedVersion) {
      throw new RepositoryConflictError("Refund", id);
    }
    this.assertUniqueProviderReference(
      this.refunds,
      "Refund provider reference",
      refund,
      id
    );
    this.refunds.set(id, cloneAggregate(refund));
    return cloneAggregate(refund);
  }

  async getIdempotency(
    scope: string,
    key: string
  ): Promise<IdempotencyRecord | undefined> {
    const record = this.idempotency.get(`${scope}\0${key}`);
    return record === undefined ? undefined : cloneIdempotency(record);
  }

  async claimIdempotency(record: IdempotencyRecord): Promise<IdempotencyClaim> {
    const mapKey = `${record.scope}\0${record.key}`;
    const existing = this.idempotency.get(mapKey);
    if (existing) {
      if (existing.requestHash !== record.requestHash) {
        throw new IdempotencyConflictError(record.scope, record.key);
      }
      return { record: cloneIdempotency(existing), claimed: false };
    }
    const saved = cloneIdempotency(record);
    this.idempotency.set(mapKey, saved);
    return { record: cloneIdempotency(saved), claimed: true };
  }

  async saveIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    const mapKey = `${record.scope}\0${record.key}`;
    const existing = this.idempotency.get(mapKey);
    if (existing && existing.requestHash !== record.requestHash) {
      throw new IdempotencyConflictError(record.scope, record.key);
    }
    const saved = cloneIdempotency(record);
    this.idempotency.set(mapKey, saved);
    return cloneIdempotency(saved);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    const id = idOf(entry);
    if (this.auditEntries.has(id)) throw new RepositoryConflictError("AuditEntry", id);
    this.auditEntries.set(id, cloneAggregate(entry));
  }

  async listAudit(query: AuditQuery = {}): Promise<readonly AuditEntry[]> {
    return [...this.auditEntries.values()]
      .filter(
        (entry) =>
          query.aggregateType === undefined ||
          textField(entry, "aggregateType") === query.aggregateType
      )
      .filter(
        (entry) =>
          query.aggregateId === undefined ||
          textField(entry, "aggregateId") === query.aggregateId
      )
      .sort((left, right) => aggregateSortDate(right) - aggregateSortDate(left))
      .slice(0, Math.max(0, query.limit ?? 100))
      .map(cloneAggregate);
  }

  async enqueueOutbox(message: OutboxMessage): Promise<void> {
    const id = idOf(message);
    if (this.outboxMessages.has(id)) {
      throw new RepositoryConflictError("OutboxMessage", id);
    }
    this.outboxMessages.set(id, cloneAggregate(message));
  }

  async listPendingOutbox(
    limit = 100,
    now = new Date()
  ): Promise<readonly OutboxMessage[]> {
    return [...this.outboxMessages.values()]
      .filter((message) => !this.publishedOutbox.has(idOf(message)))
      .filter((message) => {
        const nextAttemptAt = dateField(message, "nextAttemptAt");
        return nextAttemptAt === undefined || nextAttemptAt <= now;
      })
      .sort((left, right) => aggregateSortDate(left) - aggregateSortDate(right))
      .slice(0, Math.max(0, limit))
      .map(cloneAggregate);
  }

  async claimPendingOutbox(
    limit = 100,
    now = new Date(),
    lockedUntil = new Date(now.getTime() + 30_000)
  ): Promise<readonly OutboxMessage[]> {
    const claimed = [...this.outboxMessages.values()]
      .filter((message) => !this.publishedOutbox.has(idOf(message)))
      .filter((message) => (this.outboxLocks.get(idOf(message))?.getTime() ?? 0) <= now.getTime())
      .sort((left, right) => aggregateSortDate(left) - aggregateSortDate(right))
      .slice(0, Math.max(0, limit));
    for (const message of claimed) this.outboxLocks.set(idOf(message), new Date(lockedUntil));
    return claimed.map(cloneAggregate);
  }

  async markOutboxPublished(id: string, publishedAt = new Date()): Promise<void> {
    if (!this.outboxMessages.has(id)) {
      throw new RepositoryNotFoundError("OutboxMessage", id);
    }
    this.publishedOutbox.set(id, new Date(publishedAt));
    this.outboxLocks.delete(id);
  }

  async markOutboxFailed(
    id: string,
    error: string,
    retryAt = new Date(Date.now() + 30_000)
  ): Promise<void> {
    const message = this.outboxMessages.get(id);
    if (!message) throw new RepositoryNotFoundError("OutboxMessage", id);
    const updated = cloneAggregate(message);
    updated.markFailed(error);
    this.outboxMessages.set(id, cloneAggregate(updated));
    this.outboxLocks.set(id, new Date(retryAt));
  }

  async createSettlementBatch(batch: SettlementBatch): Promise<SettlementBatch> {
    return this.create(this.settlementBatches, "SettlementBatch", batch);
  }

  async getSettlementBatch(id: string): Promise<SettlementBatch | undefined> {
    return this.get(this.settlementBatches, id);
  }

  async hasSettlementLine(id: string): Promise<boolean> {
    for (const batch of this.settlementBatches.values()) {
      const lines = readSnapshot(batch).lines;
      if (
        Array.isArray(lines) &&
        lines.some((line) => readSnapshot(line).id === id)
      ) return true;
    }
    return false;
  }

  async reconciliationSummary(
    query: ReconciliationQuery
  ): Promise<ReconciliationSummary> {
    const currency = query.currency.toUpperCase();
    const eligibleOrders = new Set(
      [...this.orders.values()]
        .filter(
          (order) =>
            query.locationId === undefined ||
            (textField(order, "locationId") ?? "default") === query.locationId
        )
        .map(idOf)
    );
    const payments = [...this.payments.values()].filter((payment) => {
      const status = textField(payment, "status");
      const amount = moneyField(payment, "amount");
      return (
        status !== "VOIDED" &&
        amount?.currency === currency &&
        isInRange(dateField(payment, "capturedAt") ?? dateField(payment, "createdAt"), query) &&
        (query.provider === undefined || textField(payment, "provider") === query.provider) &&
        (query.locationId === undefined || eligibleOrders.has(textField(payment, "orderId") ?? ""))
      );
    });
    const allPaymentsById = new Map(
      [...this.payments.values()].map((payment) => [idOf(payment), payment] as const)
    );
    const refunds = [...this.refunds.values()].filter((refund) => {
      const amount = moneyField(refund, "amount");
      const payment = allPaymentsById.get(textField(refund, "paymentId") ?? "");
      const orderId = payment ? textField(payment, "orderId") : undefined;
      return (
        textField(refund, "status") === "SUCCEEDED" &&
        amount?.currency === currency &&
        isInRange(dateField(refund, "processedAt") ?? dateField(refund, "updatedAt"), query) &&
        (query.provider === undefined || textField(refund, "provider") === query.provider) &&
        (query.locationId === undefined || (orderId !== undefined && eligibleOrders.has(orderId)))
      );
    });

    let capturedGross = Money.zero(currency);
    for (const payment of payments) {
      capturedGross = capturedGross.add(moneyField(payment, "amount") ?? Money.zero(currency));
    }
    let refunded = Money.zero(currency);
    for (const refund of refunds) {
      refunded = refunded.add(moneyField(refund, "amount") ?? Money.zero(currency));
    }

    let settledGross = Money.zero(currency);
    let settlementFees = Money.zero(currency);
    let settledNet = Money.zero(currency);
    const settledPaymentIds = new Set<string>();
    const settledRefundIds = new Set<string>();
    for (const batch of this.settlementBatches.values()) {
      const snapshot = readSnapshot(batch);
      if (
        snapshot.currency !== currency ||
        (query.provider !== undefined && snapshot.provider !== query.provider)
      ) {
        continue;
      }
      const lines = Array.isArray(snapshot.lines) ? snapshot.lines : [];
      for (const line of lines) {
        const lineSnapshot = readSnapshot(line);
        if (!isInRange(dateField(line, "occurredAt"), query)) continue;

        if (query.locationId !== undefined) {
          const directPaymentId =
            typeof lineSnapshot.paymentId === "string" ? lineSnapshot.paymentId : undefined;
          const refund =
            typeof lineSnapshot.refundId === "string"
              ? this.refunds.get(lineSnapshot.refundId)
              : undefined;
          const refundPaymentId = refund ? textField(refund, "paymentId") : undefined;
          const payment = allPaymentsById.get(directPaymentId ?? refundPaymentId ?? "");
          const orderId = payment ? textField(payment, "orderId") : undefined;
          if (orderId === undefined || !eligibleOrders.has(orderId)) continue;
        }

        const gross = moneyField(line, "grossAmount");
        const fee = moneyField(line, "feeAmount");
        const net = moneyField(line, "netAmount");
        if (gross) settledGross = settledGross.add(gross);
        if (fee) settlementFees = settlementFees.add(fee);
        if (net) settledNet = settledNet.add(net);
        if (typeof lineSnapshot.paymentId === "string") {
          settledPaymentIds.add(lineSnapshot.paymentId);
        }
        if (typeof lineSnapshot.refundId === "string") {
          settledRefundIds.add(lineSnapshot.refundId);
        }
      }
    }

    return Object.freeze({
      from: new Date(query.from),
      to: new Date(query.to),
      currency,
      capturedPaymentCount: payments.length,
      capturedGross,
      succeededRefundCount: refunds.length,
      refunded,
      netSales: capturedGross.subtract(refunded),
      settledGross,
      settlementFees,
      settledNet,
      unreconciledPaymentIds: Object.freeze(
        payments.map(idOf).filter((id) => !settledPaymentIds.has(id))
      ),
      unreconciledRefundIds: Object.freeze(
        refunds.map(idOf).filter((id) => !settledRefundIds.has(id))
      )
    });
  }

  async close(): Promise<void> {
    // The in-memory adapter owns no external resources.
  }

  private async create<T>(map: Map<string, T>, entity: string, value: T): Promise<T> {
    const id = idOf(value);
    if (map.has(id)) throw new RepositoryConflictError(entity, id);
    map.set(id, cloneAggregate(value));
    return cloneAggregate(value);
  }

  private async get<T>(map: Map<string, T>, id: string): Promise<T | undefined> {
    const value = map.get(id);
    return value === undefined ? undefined : cloneAggregate(value);
  }

  private async replace<T>(map: Map<string, T>, entity: string, value: T): Promise<T> {
    const id = idOf(value);
    if (!map.has(id)) throw new RepositoryNotFoundError(entity, id);
    map.set(id, cloneAggregate(value));
    return cloneAggregate(value);
  }

  private assertUniqueProviderReference<T>(
    map: Map<string, T>,
    entity: string,
    value: T,
    excludedId?: string
  ): void {
    const provider = textField(value, "provider");
    const reference = textField(value, "providerReference");
    if (provider === undefined || reference === undefined) return;
    const duplicate = [...map.values()].some(
      (candidate) =>
        idOf(candidate) !== excludedId &&
        textField(candidate, "provider") === provider &&
        textField(candidate, "providerReference") === reference
    );
    if (duplicate) {
      throw new RepositoryConflictError(entity, `${provider}/${reference}`);
    }
  }
}
