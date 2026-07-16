import {
  DomainValidationError,
  InvalidStateTransitionError,
} from "./errors.js";
import type {
  OrderId,
  PaymentAttemptId,
  PaymentId,
  RefundId,
  TerminalId,
} from "./ids.js";
import { Money } from "./money.js";
import { copyDate, requireNonEmpty } from "./validation.js";

export type PaymentAttemptStatus =
  | "CREATED"
  | "AWAITING_CARD"
  | "PROCESSING"
  | "CAPTURED"
  | "DECLINED"
  | "CANCELED"
  | "UNKNOWN";

export type CardBrand =
  | "VISA"
  | "MASTERCARD"
  | "AMEX"
  | "JCB"
  | "UNIONPAY"
  | "UNKNOWN";

export type CardEntryMethod = "CONTACTLESS" | "CONTACT_CHIP" | "UNKNOWN";

export interface CardSummary {
  readonly brand: CardBrand;
  readonly last4: string;
  readonly entryMethod: CardEntryMethod;
}

export type VietnamQrWallet = "VCB" | "MOMO" | "ZALOPAY" | "SHOPEEPAY_VN";

export type PaymentTimelineEventType =
  | "QR_CREATED"
  | "CUSTOMER_OPENED"
  | "CUSTOMER_APPROVED"
  | "PROVIDER_CONFIRMED"
  | "SETTLED"
  | "REFUNDED"
  | "CALLBACK_SCHEDULED"
  | "DUPLICATE_CALLBACK_IGNORED"
  | "DECLINED"
  | "EXPIRED";

export interface PaymentTimelineEventSnapshot {
  readonly id: string;
  readonly type: PaymentTimelineEventType;
  readonly description: string;
  readonly occurredAt: Date;
}

export interface VietnamQrQuoteSnapshot {
  readonly payerCurrency: "VND";
  /** VND has no fractional minor unit in this sandbox, so this is the displayed VND amount. */
  readonly payerAmountMinor: string;
  /** Illustrative VND received per one unit of merchant currency. */
  readonly exchangeRate: string;
  readonly settlementFeeBps: number;
  readonly settlementFeeMinor: string;
  readonly merchantNetMinor: string;
  readonly expiresAt: Date;
}

export interface VietnamQrDetailsSnapshot {
  readonly quote: VietnamQrQuoteSnapshot;
  readonly selectedWallet: VietnamQrWallet | null;
  readonly timeline: readonly PaymentTimelineEventSnapshot[];
}

export interface PaymentAttemptSnapshot {
  readonly id: PaymentAttemptId;
  readonly orderId: OrderId;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly amount: Money;
  readonly status: PaymentAttemptStatus;
  readonly terminalId: TerminalId;
  readonly idempotencyKey: string;
  readonly failureCode: string | null;
  readonly vietnamQr?: VietnamQrDetailsSnapshot | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface CreatePaymentAttemptInput {
  readonly id: PaymentAttemptId;
  readonly orderId: OrderId;
  readonly provider: string;
  readonly amount: Money;
  readonly terminalId: TerminalId;
  readonly idempotencyKey: string;
  readonly createdAt?: Date;
}

const PAYMENT_ATTEMPT_TRANSITIONS: Readonly<
  Record<PaymentAttemptStatus, readonly PaymentAttemptStatus[]>
> = {
  CREATED: [
    "AWAITING_CARD",
    "PROCESSING",
    "CAPTURED",
    "DECLINED",
    "CANCELED",
    "UNKNOWN",
  ],
  AWAITING_CARD: ["PROCESSING", "CAPTURED", "DECLINED", "CANCELED", "UNKNOWN"],
  PROCESSING: ["CAPTURED", "DECLINED", "CANCELED", "UNKNOWN"],
  UNKNOWN: ["PROCESSING", "CAPTURED", "DECLINED", "CANCELED"],
  CAPTURED: [],
  // A later provider capture is a financial fact and must dominate an
  // earlier contradictory decline/cancel notification.
  DECLINED: ["CAPTURED"],
  CANCELED: ["CAPTURED"],
};

export class PaymentAttempt {
  readonly id: PaymentAttemptId;
  readonly orderId: OrderId;
  readonly provider: string;
  readonly amount: Money;
  readonly terminalId: TerminalId;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  private providerReferenceValue: string | null;
  private statusValue: PaymentAttemptStatus;
  private failureCodeValue: string | null;
  private vietnamQrValue: VietnamQrDetailsSnapshot | null;
  private updatedAtValue: Date;
  private versionValue: number;

  constructor(snapshot: PaymentAttemptSnapshot) {
    this.id = requireNonEmpty(snapshot.id, "paymentAttempt.id");
    this.orderId = requireNonEmpty(snapshot.orderId, "paymentAttempt.orderId");
    this.provider = requireNonEmpty(snapshot.provider, "paymentAttempt.provider");
    if (!(snapshot.amount instanceof Money) || snapshot.amount.minorUnits <= 0n) {
      throw new DomainValidationError(
        "paymentAttempt.amount must be positive Money",
        "INVALID_PAYMENT_AMOUNT",
      );
    }
    this.amount = snapshot.amount;
    this.terminalId = requireNonEmpty(snapshot.terminalId, "paymentAttempt.terminalId");
    this.idempotencyKey = requireNonEmpty(
      snapshot.idempotencyKey,
      "paymentAttempt.idempotencyKey",
    );
    this.providerReferenceValue = normalizeNullableString(
      snapshot.providerReference,
      "paymentAttempt.providerReference",
    );
    this.statusValue = snapshot.status;
    this.failureCodeValue = normalizeNullableString(
      snapshot.failureCode,
      "paymentAttempt.failureCode",
    );
    this.vietnamQrValue = snapshot.vietnamQr
      ? normalizeVietnamQrDetails(snapshot.vietnamQr)
      : null;
    this.createdAt = copyDate(snapshot.createdAt, "paymentAttempt.createdAt");
    this.updatedAtValue = copyDate(snapshot.updatedAt, "paymentAttempt.updatedAt");
    if (this.updatedAtValue.getTime() < this.createdAt.getTime()) {
      throw new DomainValidationError(
        "paymentAttempt.updatedAt cannot be before createdAt",
        "INVALID_PAYMENT_TIMESTAMP",
      );
    }
    if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 0) {
      throw new DomainValidationError(
        "paymentAttempt.version must be a non-negative safe integer",
        "INVALID_PAYMENT_VERSION",
      );
    }
    this.versionValue = snapshot.version;
  }

  static create(input: CreatePaymentAttemptInput): PaymentAttempt {
    const createdAt = copyDate(
      input.createdAt ?? new Date(),
      "paymentAttempt.createdAt",
    );
    return new PaymentAttempt({
      id: input.id,
      orderId: input.orderId,
      provider: input.provider,
      providerReference: null,
      amount: input.amount,
      status: "CREATED",
      terminalId: input.terminalId,
      idempotencyKey: input.idempotencyKey,
      failureCode: null,
      vietnamQr: null,
      createdAt,
      updatedAt: createdAt,
      version: 0,
    });
  }

  static rehydrate(snapshot: PaymentAttemptSnapshot): PaymentAttempt {
    return new PaymentAttempt(snapshot);
  }

  get providerReference(): string | null {
    return this.providerReferenceValue;
  }

  get status(): PaymentAttemptStatus {
    return this.statusValue;
  }

  get failureCode(): string | null {
    return this.failureCodeValue;
  }

  get vietnamQr(): VietnamQrDetailsSnapshot | null {
    return this.vietnamQrValue === null ? null : copyVietnamQrDetails(this.vietnamQrValue);
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtValue.getTime());
  }

  get version(): number {
    return this.versionValue;
  }

  transitionTo(
    next: PaymentAttemptStatus,
    input: {
      readonly providerReference?: string;
      readonly failureCode?: string | null;
      readonly at?: Date;
    } = {},
  ): void {
    if (!PAYMENT_ATTEMPT_TRANSITIONS[this.statusValue].includes(next)) {
      throw new InvalidStateTransitionError("PaymentAttempt", this.statusValue, next);
    }
    const at = copyDate(input.at ?? new Date(), "paymentAttempt.updatedAt");
    if (at.getTime() < this.updatedAtValue.getTime()) {
      throw new DomainValidationError(
        "paymentAttempt.updatedAt cannot move backwards",
        "INVALID_PAYMENT_TIMESTAMP",
      );
    }
    if (input.providerReference !== undefined) {
      this.providerReferenceValue = requireNonEmpty(
        input.providerReference,
        "paymentAttempt.providerReference",
      );
    }
    if (input.failureCode !== undefined) {
      this.failureCodeValue = normalizeNullableString(
        input.failureCode,
        "paymentAttempt.failureCode",
      );
    }
    if (next === "DECLINED" && this.failureCodeValue === null) {
      this.failureCodeValue = "DECLINED";
    }
    if (next === "CAPTURED") {
      this.failureCodeValue = null;
    }
    this.statusValue = next;
    this.updatedAtValue = at;
    this.versionValue += 1;
  }

  updateVietnamQr(
    details: VietnamQrDetailsSnapshot,
    at: Date = new Date(),
  ): boolean {
    const normalized = normalizeVietnamQrDetails(details);
    if (sameVietnamQrDetails(this.vietnamQrValue, normalized)) return false;
    const timestamp = copyDate(at, "paymentAttempt.updatedAt");
    if (timestamp.getTime() < this.updatedAtValue.getTime()) {
      throw new DomainValidationError(
        "paymentAttempt.updatedAt cannot move backwards",
        "INVALID_PAYMENT_TIMESTAMP",
      );
    }
    this.vietnamQrValue = normalized;
    this.updatedAtValue = timestamp;
    this.versionValue += 1;
    return true;
  }

  appendVietnamQrTimelineEvent(event: PaymentTimelineEventSnapshot): boolean {
    if (this.vietnamQrValue === null) return false;
    const normalizedEvent = normalizeTimelineEvent(event);
    if (this.vietnamQrValue.timeline.some((candidate) => candidate.id === normalizedEvent.id)) {
      return false;
    }
    const at = new Date(Math.max(
      this.updatedAtValue.getTime(),
      normalizedEvent.occurredAt.getTime(),
    ));
    return this.updateVietnamQr({
      ...this.vietnamQrValue,
      timeline: [...this.vietnamQrValue.timeline, normalizedEvent],
    }, at);
  }

  toSnapshot(): PaymentAttemptSnapshot {
    return Object.freeze({
      id: this.id,
      orderId: this.orderId,
      provider: this.provider,
      providerReference: this.providerReference,
      amount: this.amount,
      status: this.status,
      terminalId: this.terminalId,
      idempotencyKey: this.idempotencyKey,
      failureCode: this.failureCode,
      vietnamQr: this.vietnamQr,
      createdAt: new Date(this.createdAt.getTime()),
      updatedAt: this.updatedAt,
      version: this.version,
    });
  }
}

export interface PaymentSnapshot {
  readonly id: PaymentId;
  readonly orderId: OrderId;
  readonly paymentAttemptId: PaymentAttemptId;
  readonly provider: string;
  readonly providerReference: string;
  readonly amount: Money;
  readonly card: CardSummary | null;
  readonly capturedAt: Date;
}

export class Payment implements PaymentSnapshot {
  readonly id: PaymentId;
  readonly orderId: OrderId;
  readonly paymentAttemptId: PaymentAttemptId;
  readonly provider: string;
  readonly providerReference: string;
  readonly amount: Money;
  readonly card: CardSummary | null;
  readonly capturedAt: Date;

  constructor(input: PaymentSnapshot) {
    this.id = requireNonEmpty(input.id, "payment.id");
    this.orderId = requireNonEmpty(input.orderId, "payment.orderId");
    this.paymentAttemptId = requireNonEmpty(
      input.paymentAttemptId,
      "payment.paymentAttemptId",
    );
    this.provider = requireNonEmpty(input.provider, "payment.provider");
    this.providerReference = requireNonEmpty(
      input.providerReference,
      "payment.providerReference",
    );
    if (!(input.amount instanceof Money) || input.amount.minorUnits <= 0n) {
      throw new DomainValidationError(
        "payment.amount must be positive Money",
        "INVALID_PAYMENT_AMOUNT",
      );
    }
    this.amount = input.amount;
    this.card = input.card === null ? null : copyCardSummary(input.card);
    this.capturedAt = copyDate(input.capturedAt, "payment.capturedAt");
    Object.freeze(this);
  }

  static rehydrate(snapshot: PaymentSnapshot): Payment {
    return new Payment(snapshot);
  }

  toSnapshot(): PaymentSnapshot {
    return Object.freeze({
      id: this.id,
      orderId: this.orderId,
      paymentAttemptId: this.paymentAttemptId,
      provider: this.provider,
      providerReference: this.providerReference,
      amount: this.amount,
      card: this.card,
      capturedAt: new Date(this.capturedAt.getTime()),
    });
  }
}

export type RefundStatus = "PENDING" | "SUCCEEDED" | "FAILED";

export interface RefundSnapshot {
  readonly id: RefundId;
  readonly paymentId: PaymentId;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly amount: Money;
  readonly status: RefundStatus;
  readonly idempotencyKey: string;
  readonly failureCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface CreateRefundInput {
  readonly id: RefundId;
  readonly paymentId: PaymentId;
  readonly provider: string;
  readonly amount: Money;
  readonly idempotencyKey: string;
  readonly createdAt?: Date;
}

export class Refund {
  readonly id: RefundId;
  readonly paymentId: PaymentId;
  readonly provider: string;
  readonly amount: Money;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  private providerReferenceValue: string | null;
  private statusValue: RefundStatus;
  private failureCodeValue: string | null;
  private updatedAtValue: Date;
  private versionValue: number;

  constructor(snapshot: RefundSnapshot) {
    this.id = requireNonEmpty(snapshot.id, "refund.id");
    this.paymentId = requireNonEmpty(snapshot.paymentId, "refund.paymentId");
    this.provider = requireNonEmpty(snapshot.provider, "refund.provider");
    if (!(snapshot.amount instanceof Money) || snapshot.amount.minorUnits <= 0n) {
      throw new DomainValidationError(
        "refund.amount must be positive Money",
        "INVALID_REFUND_AMOUNT",
      );
    }
    this.amount = snapshot.amount;
    this.idempotencyKey = requireNonEmpty(snapshot.idempotencyKey, "refund.idempotencyKey");
    this.providerReferenceValue = normalizeNullableString(
      snapshot.providerReference,
      "refund.providerReference",
    );
    this.statusValue = snapshot.status;
    this.failureCodeValue = normalizeNullableString(
      snapshot.failureCode,
      "refund.failureCode",
    );
    this.createdAt = copyDate(snapshot.createdAt, "refund.createdAt");
    this.updatedAtValue = copyDate(snapshot.updatedAt, "refund.updatedAt");
    if (this.updatedAtValue.getTime() < this.createdAt.getTime()) {
      throw new DomainValidationError(
        "refund.updatedAt cannot be before createdAt",
        "INVALID_REFUND_TIMESTAMP",
      );
    }
    if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 0) {
      throw new DomainValidationError(
        "refund.version must be a non-negative safe integer",
        "INVALID_REFUND_VERSION",
      );
    }
    this.versionValue = snapshot.version;
  }

  static create(input: CreateRefundInput): Refund {
    const createdAt = copyDate(input.createdAt ?? new Date(), "refund.createdAt");
    return new Refund({
      id: input.id,
      paymentId: input.paymentId,
      provider: input.provider,
      providerReference: null,
      amount: input.amount,
      status: "PENDING",
      idempotencyKey: input.idempotencyKey,
      failureCode: null,
      createdAt,
      updatedAt: createdAt,
      version: 0,
    });
  }

  static rehydrate(snapshot: RefundSnapshot): Refund {
    return new Refund(snapshot);
  }

  get providerReference(): string | null {
    return this.providerReferenceValue;
  }

  get status(): RefundStatus {
    return this.statusValue;
  }

  get failureCode(): string | null {
    return this.failureCodeValue;
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtValue.getTime());
  }

  get version(): number {
    return this.versionValue;
  }

  markSucceeded(providerReference: string, at: Date = new Date()): void {
    this.assertPending("SUCCEEDED");
    this.providerReferenceValue = requireNonEmpty(
      providerReference,
      "refund.providerReference",
    );
    this.failureCodeValue = null;
    this.finish("SUCCEEDED", at);
  }

  markFailed(failureCode: string, at: Date = new Date()): void {
    this.assertPending("FAILED");
    this.failureCodeValue = requireNonEmpty(failureCode, "refund.failureCode");
    this.finish("FAILED", at);
  }

  toSnapshot(): RefundSnapshot {
    return Object.freeze({
      id: this.id,
      paymentId: this.paymentId,
      provider: this.provider,
      providerReference: this.providerReference,
      amount: this.amount,
      status: this.status,
      idempotencyKey: this.idempotencyKey,
      failureCode: this.failureCode,
      createdAt: new Date(this.createdAt.getTime()),
      updatedAt: this.updatedAt,
      version: this.version,
    });
  }

  private assertPending(next: RefundStatus): void {
    if (this.statusValue !== "PENDING") {
      throw new InvalidStateTransitionError("Refund", this.statusValue, next);
    }
  }

  private finish(next: RefundStatus, at: Date): void {
    const timestamp = copyDate(at, "refund.updatedAt");
    if (timestamp.getTime() < this.updatedAtValue.getTime()) {
      throw new DomainValidationError(
        "refund.updatedAt cannot move backwards",
        "INVALID_REFUND_TIMESTAMP",
      );
    }
    this.statusValue = next;
    this.updatedAtValue = timestamp;
    this.versionValue += 1;
  }
}

function copyCardSummary(card: CardSummary): CardSummary {
  if (!/^\d{4}$/.test(card.last4)) {
    throw new DomainValidationError(
      "card.last4 must contain exactly four digits",
      "INVALID_CARD_SUMMARY",
    );
  }
  return Object.freeze({ ...card });
}

function normalizeNullableString(value: string | null, field: string): string | null {
  return value === null ? null : requireNonEmpty(value, field);
}

function normalizeVietnamQrDetails(
  value: VietnamQrDetailsSnapshot,
): VietnamQrDetailsSnapshot {
  const quote = value.quote;
  const payerAmountMinor = requireDigits(quote.payerAmountMinor, "vietnamQr.payerAmountMinor");
  const exchangeRate = requireDigits(quote.exchangeRate, "vietnamQr.exchangeRate");
  const settlementFeeMinor = requireDigits(
    quote.settlementFeeMinor,
    "vietnamQr.settlementFeeMinor",
  );
  const merchantNetMinor = requireDigits(quote.merchantNetMinor, "vietnamQr.merchantNetMinor");
  if (!Number.isSafeInteger(quote.settlementFeeBps) || quote.settlementFeeBps < 0) {
    throw new DomainValidationError(
      "vietnamQr.settlementFeeBps must be a non-negative safe integer",
      "INVALID_VIETNAM_QR_QUOTE",
    );
  }
  const selectedWallet = value.selectedWallet;
  if (selectedWallet !== null && !isVietnamQrWallet(selectedWallet)) {
    throw new DomainValidationError(
      "vietnamQr.selectedWallet is unsupported",
      "INVALID_VIETNAM_QR_WALLET",
    );
  }
  return Object.freeze({
    quote: Object.freeze({
      payerCurrency: "VND",
      payerAmountMinor,
      exchangeRate,
      settlementFeeBps: quote.settlementFeeBps,
      settlementFeeMinor,
      merchantNetMinor,
      expiresAt: copyDate(quote.expiresAt, "vietnamQr.expiresAt"),
    }),
    selectedWallet,
    timeline: Object.freeze(value.timeline.map(normalizeTimelineEvent)),
  });
}

function normalizeTimelineEvent(
  event: PaymentTimelineEventSnapshot,
): PaymentTimelineEventSnapshot {
  return Object.freeze({
    id: requireNonEmpty(event.id, "paymentTimelineEvent.id"),
    type: event.type,
    description: requireNonEmpty(event.description, "paymentTimelineEvent.description"),
    occurredAt: copyDate(event.occurredAt, "paymentTimelineEvent.occurredAt"),
  });
}

function copyVietnamQrDetails(value: VietnamQrDetailsSnapshot): VietnamQrDetailsSnapshot {
  return normalizeVietnamQrDetails(value);
}

function sameVietnamQrDetails(
  left: VietnamQrDetailsSnapshot | null,
  right: VietnamQrDetailsSnapshot,
): boolean {
  if (left === null) return false;
  return JSON.stringify(vietnamQrComparable(left)) === JSON.stringify(vietnamQrComparable(right));
}

function vietnamQrComparable(value: VietnamQrDetailsSnapshot): unknown {
  return {
    quote: { ...value.quote, expiresAt: value.quote.expiresAt.toISOString() },
    selectedWallet: value.selectedWallet,
    timeline: value.timeline.map((event) => ({
      ...event,
      occurredAt: event.occurredAt.toISOString(),
    })),
  };
}

function requireDigits(value: string, field: string): string {
  const normalized = requireNonEmpty(value, field);
  if (!/^\d+$/.test(normalized)) {
    throw new DomainValidationError(`${field} must contain digits`, "INVALID_VIETNAM_QR_QUOTE");
  }
  return normalized;
}

function isVietnamQrWallet(value: string): value is VietnamQrWallet {
  return value === "VCB" || value === "MOMO" || value === "ZALOPAY" || value === "SHOPEEPAY_VN";
}
