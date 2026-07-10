import {
  DomainValidationError,
  InvalidStateTransitionError,
} from "./errors.js";
import type {
  AuditEntryId,
  OutboxMessageId,
  PaymentId,
  RefundId,
  SettlementBatchId,
  SettlementLineId,
} from "./ids.js";
import { Money } from "./money.js";
import {
  copyDate,
  readonlyMetadata,
  requireNonEmpty,
} from "./validation.js";

export type SettlementLineKind = "PAYMENT" | "REFUND" | "FEE" | "ADJUSTMENT";

export interface SettlementLineSnapshot {
  readonly id: SettlementLineId;
  readonly batchId: SettlementBatchId;
  readonly kind: SettlementLineKind;
  readonly paymentId: PaymentId | null;
  readonly refundId: RefundId | null;
  readonly providerReference: string;
  /** Signed amount before fees; refunds are conventionally negative. */
  readonly grossAmount: Money;
  /** Signed fee deducted from gross; normally non-negative. */
  readonly feeAmount: Money;
  /** Must equal grossAmount minus feeAmount. */
  readonly netAmount: Money;
  readonly occurredAt: Date;
}

export class SettlementLine implements SettlementLineSnapshot {
  readonly id: SettlementLineId;
  readonly batchId: SettlementBatchId;
  readonly kind: SettlementLineKind;
  readonly paymentId: PaymentId | null;
  readonly refundId: RefundId | null;
  readonly providerReference: string;
  readonly grossAmount: Money;
  readonly feeAmount: Money;
  readonly netAmount: Money;
  readonly occurredAt: Date;

  constructor(input: SettlementLineSnapshot) {
    this.id = requireNonEmpty(input.id, "settlementLine.id");
    this.batchId = requireNonEmpty(input.batchId, "settlementLine.batchId");
    this.kind = input.kind;
    this.paymentId = nullableId(input.paymentId, "settlementLine.paymentId");
    this.refundId = nullableId(input.refundId, "settlementLine.refundId");
    this.providerReference = requireNonEmpty(
      input.providerReference,
      "settlementLine.providerReference",
    );
    this.grossAmount = input.grossAmount;
    this.feeAmount = input.feeAmount;
    this.netAmount = input.netAmount;
    this.grossAmount.assertSameCurrency(this.feeAmount);
    this.grossAmount.assertSameCurrency(this.netAmount);
    if (this.feeAmount.isNegative()) {
      throw new DomainValidationError(
        "settlementLine.feeAmount must be non-negative",
        "INVALID_SETTLEMENT_FEE",
      );
    }
    if (!this.grossAmount.subtract(this.feeAmount).equals(this.netAmount)) {
      throw new DomainValidationError(
        "settlementLine.netAmount must equal grossAmount minus feeAmount",
        "SETTLEMENT_AMOUNT_MISMATCH",
      );
    }
    if (this.kind === "PAYMENT" && this.paymentId === null) {
      throw new DomainValidationError(
        "Payment settlement lines require paymentId",
        "MISSING_SETTLEMENT_PAYMENT",
      );
    }
    if (this.kind === "REFUND" && this.refundId === null) {
      throw new DomainValidationError(
        "Refund settlement lines require refundId",
        "MISSING_SETTLEMENT_REFUND",
      );
    }
    this.occurredAt = copyDate(input.occurredAt, "settlementLine.occurredAt");
    Object.freeze(this);
  }

  static rehydrate(snapshot: SettlementLineSnapshot): SettlementLine {
    return new SettlementLine(snapshot);
  }

  toSnapshot(): SettlementLineSnapshot {
    return Object.freeze({
      id: this.id,
      batchId: this.batchId,
      kind: this.kind,
      paymentId: this.paymentId,
      refundId: this.refundId,
      providerReference: this.providerReference,
      grossAmount: this.grossAmount,
      feeAmount: this.feeAmount,
      netAmount: this.netAmount,
      occurredAt: new Date(this.occurredAt.getTime()),
    });
  }
}

export type SettlementBatchStatus = "OPEN" | "RECONCILED";

export interface SettlementBatchSnapshot {
  readonly id: SettlementBatchId;
  readonly provider: string;
  readonly providerBatchReference: string;
  readonly currency: string;
  readonly status: SettlementBatchStatus;
  readonly lines: readonly SettlementLineSnapshot[];
  readonly payoutAmount: Money;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly createdAt: Date;
  readonly reconciledAt: Date | null;
  readonly version: number;
}

export class SettlementBatch {
  readonly id: SettlementBatchId;
  readonly provider: string;
  readonly providerBatchReference: string;
  readonly currency: string;
  readonly lines: readonly SettlementLine[];
  readonly payoutAmount: Money;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly createdAt: Date;
  private statusValue: SettlementBatchStatus;
  private reconciledAtValue: Date | null;
  private versionValue: number;

  constructor(input: SettlementBatchSnapshot) {
    this.id = requireNonEmpty(input.id, "settlementBatch.id");
    this.provider = requireNonEmpty(input.provider, "settlementBatch.provider");
    this.providerBatchReference = requireNonEmpty(
      input.providerBatchReference,
      "settlementBatch.providerBatchReference",
    );
    this.currency = Money.zero(input.currency).currency;
    this.lines = Object.freeze(input.lines.map(SettlementLine.rehydrate));
    for (const line of this.lines) {
      if (line.batchId !== this.id) {
        throw new DomainValidationError(
          `Settlement line ${line.id} belongs to another batch`,
          "SETTLEMENT_BATCH_MISMATCH",
        );
      }
      Money.zero(this.currency).assertSameCurrency(line.netAmount);
    }
    this.payoutAmount = input.payoutAmount;
    Money.zero(this.currency).assertSameCurrency(this.payoutAmount);
    const calculatedPayout = this.lines.reduce(
      (sum, line) => sum.add(line.netAmount),
      Money.zero(this.currency),
    );
    if (!calculatedPayout.equals(this.payoutAmount)) {
      throw new DomainValidationError(
        "Settlement payoutAmount must equal the sum of line net amounts",
        "SETTLEMENT_PAYOUT_MISMATCH",
      );
    }
    this.periodStart = copyDate(input.periodStart, "settlementBatch.periodStart");
    this.periodEnd = copyDate(input.periodEnd, "settlementBatch.periodEnd");
    this.createdAt = copyDate(input.createdAt, "settlementBatch.createdAt");
    if (this.periodEnd.getTime() < this.periodStart.getTime()) {
      throw new DomainValidationError(
        "settlementBatch.periodEnd cannot be before periodStart",
        "INVALID_SETTLEMENT_PERIOD",
      );
    }
    this.statusValue = input.status;
    this.reconciledAtValue =
      input.reconciledAt === null
        ? null
        : copyDate(input.reconciledAt, "settlementBatch.reconciledAt");
    if (this.statusValue === "RECONCILED" && this.reconciledAtValue === null) {
      throw new DomainValidationError(
        "Reconciled settlement batches require reconciledAt",
        "MISSING_RECONCILED_AT",
      );
    }
    if (this.statusValue === "OPEN" && this.reconciledAtValue !== null) {
      throw new DomainValidationError(
        "Open settlement batches cannot have reconciledAt",
        "UNEXPECTED_RECONCILED_AT",
      );
    }
    if (!Number.isSafeInteger(input.version) || input.version < 0) {
      throw new DomainValidationError(
        "settlementBatch.version must be a non-negative safe integer",
        "INVALID_SETTLEMENT_VERSION",
      );
    }
    this.versionValue = input.version;
  }

  static rehydrate(snapshot: SettlementBatchSnapshot): SettlementBatch {
    return new SettlementBatch(snapshot);
  }

  get status(): SettlementBatchStatus {
    return this.statusValue;
  }

  get reconciledAt(): Date | null {
    return this.reconciledAtValue === null
      ? null
      : new Date(this.reconciledAtValue.getTime());
  }

  get version(): number {
    return this.versionValue;
  }

  markReconciled(at: Date = new Date()): void {
    if (this.statusValue !== "OPEN") {
      throw new InvalidStateTransitionError(
        "SettlementBatch",
        this.statusValue,
        "RECONCILED",
      );
    }
    const timestamp = copyDate(at, "settlementBatch.reconciledAt");
    if (timestamp.getTime() < this.createdAt.getTime()) {
      throw new DomainValidationError(
        "settlementBatch.reconciledAt cannot be before createdAt",
        "INVALID_SETTLEMENT_TIMESTAMP",
      );
    }
    this.statusValue = "RECONCILED";
    this.reconciledAtValue = timestamp;
    this.versionValue += 1;
  }

  toSnapshot(): SettlementBatchSnapshot {
    return Object.freeze({
      id: this.id,
      provider: this.provider,
      providerBatchReference: this.providerBatchReference,
      currency: this.currency,
      status: this.status,
      lines: Object.freeze(this.lines.map((line) => line.toSnapshot())),
      payoutAmount: this.payoutAmount,
      periodStart: new Date(this.periodStart.getTime()),
      periodEnd: new Date(this.periodEnd.getTime()),
      createdAt: new Date(this.createdAt.getTime()),
      reconciledAt: this.reconciledAt,
      version: this.version,
    });
  }
}

export interface AuditEntrySnapshot {
  readonly id: AuditEntryId;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

export class AuditEntry implements AuditEntrySnapshot {
  readonly id: AuditEntryId;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;

  constructor(input: AuditEntrySnapshot) {
    this.id = requireNonEmpty(input.id, "auditEntry.id");
    this.aggregateType = requireNonEmpty(
      input.aggregateType,
      "auditEntry.aggregateType",
    );
    this.aggregateId = requireNonEmpty(input.aggregateId, "auditEntry.aggregateId");
    this.action = requireNonEmpty(input.action, "auditEntry.action");
    this.actorId = nullableId(input.actorId, "auditEntry.actorId");
    this.metadata = readonlyMetadata(input.metadata);
    this.occurredAt = copyDate(input.occurredAt, "auditEntry.occurredAt");
    Object.freeze(this);
  }

  static rehydrate(snapshot: AuditEntrySnapshot): AuditEntry {
    return new AuditEntry(snapshot);
  }

  toSnapshot(): AuditEntrySnapshot {
    return Object.freeze({
      id: this.id,
      aggregateType: this.aggregateType,
      aggregateId: this.aggregateId,
      action: this.action,
      actorId: this.actorId,
      metadata: this.metadata,
      occurredAt: new Date(this.occurredAt.getTime()),
    });
  }
}

export type OutboxMessageStatus = "PENDING" | "PUBLISHED" | "FAILED";

export interface OutboxMessageSnapshot {
  readonly id: OutboxMessageId;
  readonly topic: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: OutboxMessageStatus;
  readonly attempts: number;
  readonly occurredAt: Date;
  readonly publishedAt: Date | null;
  readonly lastError: string | null;
}

export class OutboxMessage {
  readonly id: OutboxMessageId;
  readonly topic: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  private statusValue: OutboxMessageStatus;
  private attemptsValue: number;
  private publishedAtValue: Date | null;
  private lastErrorValue: string | null;

  constructor(input: OutboxMessageSnapshot) {
    this.id = requireNonEmpty(input.id, "outboxMessage.id");
    this.topic = requireNonEmpty(input.topic, "outboxMessage.topic");
    this.aggregateId = requireNonEmpty(input.aggregateId, "outboxMessage.aggregateId");
    this.payload = readonlyMetadata(input.payload);
    this.statusValue = input.status;
    if (!Number.isSafeInteger(input.attempts) || input.attempts < 0) {
      throw new DomainValidationError(
        "outboxMessage.attempts must be a non-negative safe integer",
        "INVALID_OUTBOX_ATTEMPTS",
      );
    }
    this.attemptsValue = input.attempts;
    this.occurredAt = copyDate(input.occurredAt, "outboxMessage.occurredAt");
    this.publishedAtValue =
      input.publishedAt === null
        ? null
        : copyDate(input.publishedAt, "outboxMessage.publishedAt");
    this.lastErrorValue =
      input.lastError === null
        ? null
        : requireNonEmpty(input.lastError, "outboxMessage.lastError");
    if (this.statusValue === "PUBLISHED" && this.publishedAtValue === null) {
      throw new DomainValidationError(
        "Published outbox messages require publishedAt",
        "MISSING_OUTBOX_PUBLISHED_AT",
      );
    }
  }

  static create(input: {
    readonly id: OutboxMessageId;
    readonly topic: string;
    readonly aggregateId: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly occurredAt?: Date;
  }): OutboxMessage {
    return new OutboxMessage({
      id: input.id,
      topic: input.topic,
      aggregateId: input.aggregateId,
      payload: input.payload,
      status: "PENDING",
      attempts: 0,
      occurredAt: input.occurredAt ?? new Date(),
      publishedAt: null,
      lastError: null,
    });
  }

  static rehydrate(snapshot: OutboxMessageSnapshot): OutboxMessage {
    return new OutboxMessage(snapshot);
  }

  get status(): OutboxMessageStatus {
    return this.statusValue;
  }

  get attempts(): number {
    return this.attemptsValue;
  }

  get publishedAt(): Date | null {
    return this.publishedAtValue === null
      ? null
      : new Date(this.publishedAtValue.getTime());
  }

  get lastError(): string | null {
    return this.lastErrorValue;
  }

  markPublished(at: Date = new Date()): void {
    if (this.statusValue === "PUBLISHED") {
      throw new InvalidStateTransitionError("OutboxMessage", "PUBLISHED", "PUBLISHED");
    }
    this.statusValue = "PUBLISHED";
    this.attemptsValue += 1;
    this.publishedAtValue = copyDate(at, "outboxMessage.publishedAt");
    this.lastErrorValue = null;
  }

  markFailed(error: string): void {
    if (this.statusValue === "PUBLISHED") {
      throw new InvalidStateTransitionError("OutboxMessage", "PUBLISHED", "FAILED");
    }
    this.statusValue = "FAILED";
    this.attemptsValue += 1;
    this.lastErrorValue = requireNonEmpty(error, "outboxMessage.lastError");
  }

  retry(): void {
    if (this.statusValue !== "FAILED") {
      throw new InvalidStateTransitionError("OutboxMessage", this.statusValue, "PENDING");
    }
    this.statusValue = "PENDING";
    this.lastErrorValue = null;
  }

  toSnapshot(): OutboxMessageSnapshot {
    return Object.freeze({
      id: this.id,
      topic: this.topic,
      aggregateId: this.aggregateId,
      payload: this.payload,
      status: this.status,
      attempts: this.attempts,
      occurredAt: new Date(this.occurredAt.getTime()),
      publishedAt: this.publishedAt,
      lastError: this.lastError,
    });
  }
}

function nullableId(value: string | null, field: string): string | null {
  return value === null ? null : requireNonEmpty(value, field);
}
