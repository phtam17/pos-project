import { describe, expect, it } from "vitest";
import {
  AuditEntry,
  Cart,
  DomainValidationError,
  InvalidStateTransitionError,
  Money,
  Order,
  OutboxMessage,
  PaymentAttempt,
  Product,
  SettlementBatch,
  SettlementLine,
} from "./index.js";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-01T00:00:01.000Z");
const T2 = new Date("2026-01-01T00:00:02.000Z");

describe("Money", () => {
  it("uses bigint minor units and rejects cross-currency arithmetic", () => {
    const usd = Money.fromMinor(1_050n, "usd");
    expect(usd.add(Money.fromMinor(50n, "USD")).minorUnits).toBe(1_100n);
    expect(usd.multiply(2).minorUnits).toBe(2_100n);
    expect(() => usd.add(Money.fromMinor(1n, "EUR"))).toThrowError(
      DomainValidationError,
    );
    expect(usd.toJSON()).toEqual({ minorUnits: "1050", currency: "USD" });
  });
});

describe("cart and order totals", () => {
  it("calculates discount and line-rounded tax and freezes checkout snapshots", () => {
    const product = new Product({
      id: "coffee",
      sku: "COFFEE",
      name: "Coffee",
      unitPrice: new Money(1_000n, "USD"),
      taxRateBps: 825,
    });
    const cart = new Cart({ id: "cart-1", currency: "USD", createdAt: T0 });
    cart.addProduct(product, 2, "line-1", T1);
    cart.applyLineDiscount("line-1", new Money(100n, "USD"), T1);

    expect(cart.subtotal.minorUnits).toBe(2_000n);
    expect(cart.discountTotal.minorUnits).toBe(100n);
    expect(cart.taxTotal.minorUnits).toBe(157n);
    expect(cart.total.minorUnits).toBe(2_057n);

    const order = Order.fromCart("order-1", cart, T1);
    expect(Object.isFrozen(order.lines)).toBe(true);
    expect(Object.isFrozen(order.lines[0])).toBe(true);
    expect(order.total.minorUnits).toBe(2_057n);

    cart.setQuantity("line-1", 3, T2);
    expect(cart.total.minorUnits).not.toBe(order.total.minorUnits);
    expect(order.lines[0]?.quantity).toBe(2);
  });

  it("validates order payment lifecycle and exact captured total", () => {
    const product = new Product({
      id: "p1",
      sku: "P1",
      name: "Item",
      unitPrice: new Money(500n, "USD"),
    });
    const cart = new Cart({ id: "cart-2", currency: "USD", createdAt: T0 });
    cart.addProduct(product, 1, "line-p1", T1);
    const order = Order.fromCart("order-2", cart, T1);

    expect(() => order.markPaid(new Money(500n, "USD"), T2)).toThrowError(
      InvalidStateTransitionError,
    );
    order.markPaymentPending(T2);
    expect(() => order.markPaid(new Money(499n, "USD"), T2)).toThrowError(
      DomainValidationError,
    );
    order.markPaid(new Money(500n, "USD"), T2);
    expect(order.status).toBe("PAID");
    expect(() => order.cancel(T2)).toThrowError(InvalidStateTransitionError);
  });
});

describe("payment lifecycle", () => {
  it("supports UNKNOWN recovery but prevents terminal-state rewrites", () => {
    const attempt = PaymentAttempt.create({
      id: "attempt-1",
      orderId: "order-1",
      provider: "simulated",
      amount: new Money(1_002n, "USD"),
      terminalId: "terminal-1",
      idempotencyKey: "sale:order-1:1",
      createdAt: T0,
    });
    attempt.transitionTo("PROCESSING", { at: T1 });
    attempt.transitionTo("UNKNOWN", {
      providerReference: "provider-ref-1",
      at: T1,
    });
    attempt.transitionTo("CAPTURED", { at: T2 });

    expect(attempt.status).toBe("CAPTURED");
    expect(attempt.providerReference).toBe("provider-ref-1");
    expect(() => attempt.transitionTo("DECLINED", { at: T2 })).toThrowError(
      InvalidStateTransitionError,
    );
  });

  it("allows a later capture to supersede a contradictory terminal result", () => {
    const attempt = PaymentAttempt.create({
      id: "attempt-late-capture",
      orderId: "order-late-capture",
      provider: "simulated",
      amount: new Money(1_000n, "USD"),
      terminalId: "terminal-1",
      idempotencyKey: "sale:order-late-capture:1",
      createdAt: T0,
    });
    attempt.transitionTo("DECLINED", { failureCode: "DECLINED", at: T1 });
    attempt.transitionTo("CAPTURED", {
      providerReference: "provider-late-capture",
      at: T2,
    });

    expect(attempt.status).toBe("CAPTURED");
    expect(attempt.failureCode).toBeNull();
  });
});

describe("operational records", () => {
  it("validates settlements and basic audit/outbox state", () => {
    const line = new SettlementLine({
      id: "sl-1",
      batchId: "sb-1",
      kind: "PAYMENT",
      paymentId: "payment-1",
      refundId: null,
      providerReference: "provider-payment-1",
      grossAmount: new Money(1_000n, "USD"),
      feeAmount: new Money(25n, "USD"),
      netAmount: new Money(975n, "USD"),
      occurredAt: T0,
    });
    const batch = new SettlementBatch({
      id: "sb-1",
      provider: "simulated",
      providerBatchReference: "batch-1",
      currency: "USD",
      status: "OPEN",
      lines: [line.toSnapshot()],
      payoutAmount: new Money(975n, "USD"),
      periodStart: T0,
      periodEnd: T1,
      createdAt: T1,
      reconciledAt: null,
      version: 0,
    });
    batch.markReconciled(T2);
    expect(batch.status).toBe("RECONCILED");

    const audit = new AuditEntry({
      id: "audit-1",
      aggregateType: "Order",
      aggregateId: "order-1",
      action: "ORDER_PAID",
      actorId: "staff-1",
      metadata: { registerId: "register-1" },
      occurredAt: T1,
    });
    expect(audit.metadata).toEqual({ registerId: "register-1" });

    const outbox = OutboxMessage.create({
      id: "outbox-1",
      topic: "order.paid",
      aggregateId: "order-1",
      payload: { orderId: "order-1" },
      occurredAt: T1,
    });
    outbox.markFailed("temporary failure");
    outbox.retry();
    outbox.markPublished(T2);
    expect(outbox.status).toBe("PUBLISHED");
    expect(outbox.attempts).toBe(2);
  });
});
