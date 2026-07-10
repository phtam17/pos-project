import { Cart, type CartLineSnapshot } from "./cart.js";
import {
  DomainValidationError,
  InvalidStateTransitionError,
} from "./errors.js";
import type { CartId, OrderId, ProductId } from "./ids.js";
import { Money } from "./money.js";
import { copyDate, requireNonEmpty } from "./validation.js";

export type OrderStatus =
  | "OPEN"
  | "PAYMENT_PENDING"
  | "PAID"
  | "CANCELED"
  | "REFUNDED";

export interface OrderLineSnapshot {
  readonly lineId: string;
  readonly productId: ProductId;
  readonly sku: string;
  readonly name: string;
  readonly unitPrice: Money;
  readonly quantity: number;
  readonly taxRateBps: number;
  readonly discount: Money;
  readonly subtotal: Money;
  readonly tax: Money;
  readonly total: Money;
}

export interface OrderSnapshot {
  readonly id: OrderId;
  readonly cartId: CartId;
  readonly currency: string;
  readonly status: OrderStatus;
  readonly lines: readonly OrderLineSnapshot[];
  readonly subtotal: Money;
  readonly discountTotal: Money;
  readonly taxTotal: Money;
  readonly total: Money;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface OrderInput extends OrderSnapshot {}

const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  OPEN: ["PAYMENT_PENDING", "CANCELED"],
  PAYMENT_PENDING: ["OPEN", "PAID", "CANCELED"],
  PAID: ["REFUNDED"],
  CANCELED: [],
  REFUNDED: [],
};

/**
 * Order lines and monetary totals are immutable checkout-time snapshots. Only
 * lifecycle status, updatedAt, and version may change.
 */
export class Order {
  readonly id: OrderId;
  readonly cartId: CartId;
  readonly currency: string;
  readonly lines: readonly OrderLineSnapshot[];
  readonly subtotal: Money;
  readonly discountTotal: Money;
  readonly taxTotal: Money;
  readonly total: Money;
  readonly createdAt: Date;
  private statusValue: OrderStatus;
  private updatedAtValue: Date;
  private versionValue: number;

  constructor(input: OrderInput) {
    this.id = requireNonEmpty(input.id, "order.id");
    this.cartId = requireNonEmpty(input.cartId, "order.cartId");
    this.currency = Money.zero(input.currency).currency;
    if (input.lines.length === 0) {
      throw new DomainValidationError(
        "An order must contain at least one line",
        "EMPTY_ORDER",
      );
    }
    this.lines = Object.freeze(input.lines.map(copyOrderLine));
    this.subtotal = input.subtotal;
    this.discountTotal = input.discountTotal;
    this.taxTotal = input.taxTotal;
    this.total = input.total;
    this.assertTotals();
    this.statusValue = input.status;
    this.createdAt = copyDate(input.createdAt, "order.createdAt");
    this.updatedAtValue = copyDate(input.updatedAt, "order.updatedAt");
    if (this.updatedAtValue.getTime() < this.createdAt.getTime()) {
      throw new DomainValidationError(
        "order.updatedAt cannot be before createdAt",
        "INVALID_ORDER_TIMESTAMP",
      );
    }
    if (!Number.isSafeInteger(input.version) || input.version <= 0) {
      throw new DomainValidationError(
        "order.version must be a positive safe integer",
        "INVALID_ORDER_VERSION",
      );
    }
    this.versionValue = input.version;
  }

  static fromCart(id: OrderId, cart: Cart, at: Date = new Date()): Order {
    const snapshot = cart.toSnapshot();
    if (snapshot.lines.length === 0) {
      throw new DomainValidationError(
        "An empty cart cannot be converted to an order",
        "EMPTY_ORDER",
      );
    }
    const timestamp = copyDate(at, "order.createdAt");
    return new Order({
      id,
      cartId: cart.id,
      currency: cart.currency,
      status: "OPEN",
      lines: snapshot.lines.map(orderLineFromCartLine),
      subtotal: snapshot.subtotal,
      discountTotal: snapshot.discountTotal,
      taxTotal: snapshot.taxTotal,
      total: snapshot.total,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    });
  }

  static rehydrate(snapshot: OrderSnapshot): Order {
    return new Order(snapshot);
  }

  get status(): OrderStatus {
    return this.statusValue;
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtValue.getTime());
  }

  get version(): number {
    return this.versionValue;
  }

  markPaymentPending(at: Date = new Date()): void {
    this.transitionTo("PAYMENT_PENDING", at);
  }

  reopenAfterFailedPayment(at: Date = new Date()): void {
    this.transitionTo("OPEN", at);
  }

  markPaid(amount: Money, at: Date = new Date()): void {
    if (!amount.equals(this.total)) {
      throw new DomainValidationError(
        "Captured payment amount must equal the order total",
        "PAYMENT_AMOUNT_MISMATCH",
      );
    }
    this.transitionTo("PAID", at);
  }

  cancel(at: Date = new Date()): void {
    this.transitionTo("CANCELED", at);
  }

  markRefunded(refundedAmount: Money, at: Date = new Date()): void {
    if (!refundedAmount.equals(this.total)) {
      throw new DomainValidationError(
        "Only a fully refunded order can be marked REFUNDED",
        "REFUND_AMOUNT_MISMATCH",
      );
    }
    this.transitionTo("REFUNDED", at);
  }

  toSnapshot(): OrderSnapshot {
    return Object.freeze({
      id: this.id,
      cartId: this.cartId,
      currency: this.currency,
      status: this.status,
      lines: Object.freeze(this.lines.map(copyOrderLine)),
      subtotal: this.subtotal,
      discountTotal: this.discountTotal,
      taxTotal: this.taxTotal,
      total: this.total,
      createdAt: new Date(this.createdAt.getTime()),
      updatedAt: this.updatedAt,
      version: this.version,
    });
  }

  private transitionTo(next: OrderStatus, at: Date): void {
    if (!ORDER_TRANSITIONS[this.statusValue].includes(next)) {
      throw new InvalidStateTransitionError("Order", this.statusValue, next);
    }
    const timestamp = copyDate(at, "order.updatedAt");
    if (timestamp.getTime() < this.updatedAtValue.getTime()) {
      throw new DomainValidationError(
        "order.updatedAt cannot move backwards",
        "INVALID_ORDER_TIMESTAMP",
      );
    }
    this.statusValue = next;
    this.updatedAtValue = timestamp;
    this.versionValue += 1;
  }

  private assertTotals(): void {
    const zero = Money.zero(this.currency);
    let subtotal = zero;
    let discount = zero;
    let tax = zero;
    let total = zero;
    for (const line of this.lines) {
      zero.assertSameCurrency(line.unitPrice);
      zero.assertSameCurrency(line.subtotal);
      zero.assertSameCurrency(line.discount);
      zero.assertSameCurrency(line.tax);
      zero.assertSameCurrency(line.total);
      const expectedSubtotal = line.unitPrice.multiply(line.quantity);
      const expectedTax = expectedSubtotal
        .subtract(line.discount)
        .percentageBasisPoints(line.taxRateBps);
      const expectedTotal = expectedSubtotal.subtract(line.discount).add(expectedTax);
      if (
        !line.subtotal.equals(expectedSubtotal) ||
        !line.tax.equals(expectedTax) ||
        !line.total.equals(expectedTotal)
      ) {
        throw new DomainValidationError(
          `Order line totals do not match for ${line.lineId}`,
          "ORDER_LINE_TOTAL_MISMATCH",
        );
      }
      subtotal = subtotal.add(line.subtotal);
      discount = discount.add(line.discount);
      tax = tax.add(line.tax);
      total = total.add(line.total);
    }
    if (
      !subtotal.equals(this.subtotal) ||
      !discount.equals(this.discountTotal) ||
      !tax.equals(this.taxTotal) ||
      !total.equals(this.total)
    ) {
      throw new DomainValidationError(
        "Order totals do not match its immutable line snapshots",
        "ORDER_TOTAL_MISMATCH",
      );
    }
  }
}

function orderLineFromCartLine(line: CartLineSnapshot): OrderLineSnapshot {
  return copyOrderLine({
    lineId: line.id,
    productId: line.productId,
    sku: line.sku,
    name: line.name,
    unitPrice: line.unitPrice,
    quantity: line.quantity,
    taxRateBps: line.taxRateBps,
    discount: line.discount,
    subtotal: line.subtotal,
    tax: line.tax,
    total: line.total,
  });
}

function copyOrderLine(line: OrderLineSnapshot): OrderLineSnapshot {
  return Object.freeze({ ...line });
}
