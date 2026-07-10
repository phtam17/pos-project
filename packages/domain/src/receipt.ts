import { DomainValidationError } from "./errors.js";
import type { OrderId, PaymentId, ReceiptId } from "./ids.js";
import { Money } from "./money.js";
import { copyDate, requireNonEmpty } from "./validation.js";

export type ReceiptChannel = "PRINT" | "EMAIL";

export interface ReceiptSnapshot {
  readonly id: ReceiptId;
  readonly orderId: OrderId;
  readonly paymentId: PaymentId | null;
  readonly number: string;
  readonly amount: Money;
  readonly channel: ReceiptChannel;
  readonly destination: string | null;
  readonly issuedAt: Date;
}

export class Receipt implements ReceiptSnapshot {
  readonly id: ReceiptId;
  readonly orderId: OrderId;
  readonly paymentId: PaymentId | null;
  readonly number: string;
  readonly amount: Money;
  readonly channel: ReceiptChannel;
  readonly destination: string | null;
  readonly issuedAt: Date;

  constructor(input: ReceiptSnapshot) {
    this.id = requireNonEmpty(input.id, "receipt.id");
    this.orderId = requireNonEmpty(input.orderId, "receipt.orderId");
    this.paymentId =
      input.paymentId === null
        ? null
        : requireNonEmpty(input.paymentId, "receipt.paymentId");
    this.number = requireNonEmpty(input.number, "receipt.number");
    if (!(input.amount instanceof Money) || input.amount.isNegative()) {
      throw new DomainValidationError(
        "receipt.amount must be non-negative Money",
        "INVALID_RECEIPT_AMOUNT",
      );
    }
    this.amount = input.amount;
    this.channel = input.channel;
    this.destination =
      input.destination === null
        ? null
        : requireNonEmpty(input.destination, "receipt.destination");
    if (this.channel === "EMAIL" && this.destination === null) {
      throw new DomainValidationError(
        "Email receipts require a destination",
        "MISSING_RECEIPT_DESTINATION",
      );
    }
    this.issuedAt = copyDate(input.issuedAt, "receipt.issuedAt");
    Object.freeze(this);
  }

  static rehydrate(snapshot: ReceiptSnapshot): Receipt {
    return new Receipt(snapshot);
  }

  toSnapshot(): ReceiptSnapshot {
    return Object.freeze({
      id: this.id,
      orderId: this.orderId,
      paymentId: this.paymentId,
      number: this.number,
      amount: this.amount,
      channel: this.channel,
      destination: this.destination,
      issuedAt: new Date(this.issuedAt.getTime()),
    });
  }
}
