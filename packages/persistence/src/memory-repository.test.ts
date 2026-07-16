import {
  AuditEntry,
  Cart,
  MerchantSettings,
  Money,
  Order,
  OutboxMessage,
  Payment,
  PaymentAttempt,
  Product,
  Refund,
  SettlementBatch
} from "@pos/domain";
import { describe, expect, it } from "vitest";

import { IdempotencyConflictError, RepositoryConflictError } from "./errors.js";
import { createRepository } from "./factory.js";
import { MemoryPosRepository } from "./memory-repository.js";

describe("MemoryPosRepository", () => {
  it("starts with useful demo products through the default factory", async () => {
    const repository = createRepository({ databaseUrl: "" });

    expect(repository).toBeInstanceOf(MemoryPosRepository);
    expect(await repository.listProducts({ activeOnly: true })).toHaveLength(3);
    expect((await repository.listProducts({ search: "coffee" }))[0]?.sku).toBe(
      "COFFEE-001"
    );
  });

  it("enforces product IDs and SKUs", async () => {
    const repository = new MemoryPosRepository();
    const product = productFixture();

    await repository.createProduct(product);

    await expect(repository.createProduct(product)).rejects.toBeInstanceOf(
      RepositoryConflictError
    );
    await expect(
      repository.createProduct(
        new Product({
          id: "another-product",
          sku: product.sku,
          name: "Another",
          unitPrice: Money.fromMinor(200n, "USD")
        })
      )
    ).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it("persists product edits and merchant settings", async () => {
    const repository = new MemoryPosRepository();
    const product = productFixture();
    await repository.createProduct(product);
    const edited = product.withChanges({
      sku: "EDITED-SKU",
      name: "Edited product",
      category: "Prepared food",
      barcode: "123456789012",
      unitPrice: Money.fromMinor(450n, "USD"),
      taxRateBps: 825,
      active: false
    });
    await repository.saveProduct(edited);
    expect(await repository.getProduct(product.id)).toMatchObject({
      category: "Prepared food",
      barcode: "123456789012",
      active: false
    });

    const current = await repository.getMerchantSettings();
    const settings = current.withChanges({
      merchantName: "Vietnam Market",
      locationName: "Phoenix",
      registerName: "Register A",
      currency: "USD",
      receiptHeader: "Sandbox",
      receiptFooter: "Thank you",
      showSkuOnReceipt: true,
      discountsEnabled: true,
      tipsEnabled: false
    });
    await repository.saveMerchantSettings(settings);
    expect(await repository.getMerchantSettings()).toMatchObject({
      merchantName: "Vietnam Market",
      version: 2,
      tipsEnabled: false
    });
    expect(MerchantSettings.rehydrate(settings.toSnapshot())).toEqual(settings);
  });

  it("isolates mutable carts and persists explicit saves", async () => {
    const repository = new MemoryPosRepository();
    const product = productFixture();
    const at = new Date("2026-01-10T12:00:00.000Z");
    const cart = new Cart({ id: "cart-1", currency: "USD", createdAt: at, updatedAt: at });
    cart.addProduct(product, 1, "line-1", at);
    await repository.createCart(cart);

    cart.setQuantity("line-1", 2, new Date("2026-01-10T12:01:00.000Z"));
    expect((await repository.getCart(cart.id))?.lines[0]?.quantity).toBe(1);

    await repository.saveCart(cart);
    expect((await repository.getCart(cart.id))?.lines[0]?.quantity).toBe(2);
  });

  it("protects idempotency keys from request reuse", async () => {
    const repository = new MemoryPosRepository();
    const createdAt = new Date("2026-01-10T12:00:00.000Z");
    const base = {
      scope: "checkout",
      key: "key-1",
      requestHash: "hash-a",
      state: "IN_PROGRESS" as const,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date("2026-01-11T12:00:00.000Z")
    };

    await repository.saveIdempotency(base);
    const finished = await repository.saveIdempotency({
      ...base,
      state: "COMPLETED",
      responseStatus: 201,
      responseBody: { id: "payment-1" },
      resourceId: "payment-1"
    });
    expect(finished.state).toBe("COMPLETED");

    await expect(
      repository.saveIdempotency({ ...base, requestHash: "hash-b" })
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("stores lifecycle data and produces a reconciliation read", async () => {
    const repository = new MemoryPosRepository();
    const at = new Date("2026-01-10T12:00:00.000Z");
    const product = productFixture();
    const cart = new Cart({ id: "cart-1", currency: "USD", createdAt: at, updatedAt: at });
    cart.addProduct(product, 1, "line-1", at);
    await repository.createCart(cart);

    const order = Order.fromCart("order-1", cart, at);
    await repository.createOrder(order);
    const attempt = PaymentAttempt.create({
      id: "attempt-1",
      orderId: order.id,
      provider: "simulated",
      amount: order.total,
      terminalId: "terminal-1",
      idempotencyKey: "sale-1",
      createdAt: at
    });
    await repository.createPaymentAttempt(attempt);
    attempt.transitionTo("CAPTURED", {
      providerReference: "provider-payment-1",
      at: new Date("2026-01-10T12:00:05.000Z")
    });
    await repository.savePaymentAttempt(attempt, 0);

    const payment = new Payment({
      id: "payment-1",
      orderId: order.id,
      paymentAttemptId: attempt.id,
      provider: "simulated",
      providerReference: "provider-payment-1",
      amount: order.total,
      card: { brand: "VISA", last4: "4242", entryMethod: "CONTACTLESS" },
      capturedAt: new Date("2026-01-10T12:00:05.000Z")
    });
    await repository.createPayment(payment);
    expect(
      await repository.findPaymentByProviderReference(
        payment.provider,
        payment.providerReference
      )
    ).toMatchObject({ id: payment.id });

    const refund = Refund.create({
      id: "refund-1",
      paymentId: payment.id,
      provider: "simulated",
      amount: Money.fromMinor(10n, "USD"),
      idempotencyKey: "refund-key-1",
      createdAt: new Date("2026-01-10T13:00:00.000Z")
    });
    await repository.createRefund(refund);
    refund.markSucceeded(
      "provider-refund-1",
      new Date("2026-01-10T13:00:01.000Z")
    );
    await repository.saveRefund(refund, 0);
    expect(
      await repository.findRefundByProviderReference(
        refund.provider,
        "provider-refund-1"
      )
    ).toMatchObject({ id: refund.id });

    const batch = new SettlementBatch({
      id: "batch-1",
      provider: "simulated",
      providerBatchReference: "provider-batch-1",
      currency: "USD",
      status: "OPEN",
      lines: [
        {
          id: "settlement-payment-1",
          batchId: "batch-1",
          kind: "PAYMENT",
          paymentId: payment.id,
          refundId: null,
          providerReference: payment.providerReference,
          grossAmount: Money.fromMinor(100n, "USD"),
          feeAmount: Money.fromMinor(3n, "USD"),
          netAmount: Money.fromMinor(97n, "USD"),
          occurredAt: new Date("2026-01-10T23:00:00.000Z")
        },
        {
          id: "settlement-refund-1",
          batchId: "batch-1",
          kind: "REFUND",
          paymentId: null,
          refundId: refund.id,
          providerReference: "provider-refund-1",
          grossAmount: Money.fromMinor(-10n, "USD"),
          feeAmount: Money.zero("USD"),
          netAmount: Money.fromMinor(-10n, "USD"),
          occurredAt: new Date("2026-01-10T23:00:00.000Z")
        }
      ],
      payoutAmount: Money.fromMinor(87n, "USD"),
      periodStart: new Date("2026-01-10T00:00:00.000Z"),
      periodEnd: new Date("2026-01-10T23:59:00.000Z"),
      createdAt: new Date("2026-01-11T00:00:00.000Z"),
      reconciledAt: null,
      version: 0
    });
    await repository.createSettlementBatch(batch);

    const summary = await repository.reconciliationSummary({
      from: new Date("2026-01-10T00:00:00.000Z"),
      to: new Date("2026-01-11T00:00:00.000Z"),
      currency: "USD",
      provider: "simulated"
    });

    expect(summary.capturedPaymentCount).toBe(1);
    expect(summary.capturedGross.minorUnits).toBe(100n);
    expect(summary.refunded.minorUnits).toBe(10n);
    expect(summary.netSales.minorUnits).toBe(90n);
    expect(summary.settledGross.minorUnits).toBe(90n);
    expect(summary.settlementFees.minorUnits).toBe(3n);
    expect(summary.settledNet.minorUnits).toBe(87n);
    expect(summary.unreconciledPaymentIds).toEqual([]);
    expect(summary.unreconciledRefundIds).toEqual([]);
  });

  it("appends audit entries and publishes outbox messages", async () => {
    const repository = new MemoryPosRepository();
    const at = new Date("2026-01-10T12:00:00.000Z");
    await repository.appendAudit(
      new AuditEntry({
        id: "audit-1",
        aggregateType: "Order",
        aggregateId: "order-1",
        action: "CREATED",
        actorId: "staff-1",
        metadata: { registerId: "register-1" },
        occurredAt: at
      })
    );
    const message = OutboxMessage.create({
      id: "message-1",
      topic: "order.created",
      aggregateId: "order-1",
      payload: { orderId: "order-1" },
      occurredAt: at
    });
    await repository.enqueueOutbox(message);

    expect(await repository.listAudit({ aggregateId: "order-1" })).toHaveLength(1);
    expect(await repository.listPendingOutbox()).toHaveLength(1);
    await repository.markOutboxPublished(message.id, new Date(at.getTime() + 1_000));
    expect(await repository.listPendingOutbox()).toEqual([]);
  });

  it("atomically claims provider events and rolls back failed inbox work", async () => {
    const repository = new MemoryPosRepository();
    const at = new Date("2026-01-10T12:00:00.000Z");
    const providerEvent = {
      provider: "simulated",
      eventId: "event-1",
      eventType: "payment.updated",
      payloadHash: "hash-1",
      metadata: {},
      status: "PROCESSING" as const,
      attempts: 0,
      receivedAt: at,
      updatedAt: at
    };

    await expect(repository.withTransaction(async () => {
      expect((await repository.claimProviderEvent(providerEvent)).claimed).toBe(true);
      await repository.appendAudit(new AuditEntry({
        id: "audit-rollback",
        aggregateType: "ProviderEvent",
        aggregateId: "event-1",
        action: "VERIFIED",
        actorId: null,
        metadata: {},
        occurredAt: at
      }));
      throw new Error("simulate processing failure");
    })).rejects.toThrow("simulate processing failure");

    expect(await repository.listAudit()).toEqual([]);
    expect((await repository.claimProviderEvent(providerEvent)).claimed).toBe(true);
    await repository.completeProviderEvent("simulated", "event-1", at);
    expect((await repository.claimProviderEvent(providerEvent)).claimed).toBe(false);
  });
});

function productFixture(): Product {
  return new Product({
    id: "product-1",
    sku: "SKU-1",
    name: "Test Product",
    unitPrice: Money.fromMinor(100n, "USD")
  });
}
