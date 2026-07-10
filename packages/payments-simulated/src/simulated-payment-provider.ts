import { Money } from "@pos/domain";
import {
  PaymentProviderError,
  type PaymentCapabilities,
  type PaymentProvider,
  type PaymentResult,
  type ProviderEvent,
  type ProviderSettlementItem,
  type ProviderWebhookHeaders,
  type RefundRequest,
  type RefundResult,
  type SettlementPage,
  type StartSaleRequest,
} from "@pos/payment-contract";
import { assertNoSensitiveCardData } from "./sensitive-data.js";

export const SIMULATED_PROVIDER_NAME = "simulated";
export const SIMULATED_WEBHOOK_SECRET = "simulated-webhook-secret";

/** Outcome rules use the last two minor units (the cents for USD). */
export const SIMULATED_OUTCOME_SUFFIXES = Object.freeze({
  DECLINED: 1n,
  UNKNOWN_THEN_CAPTURED: 2n,
});

export interface SimulatedPaymentProviderOptions {
  readonly clock?: () => Date;
  readonly webhookSecret?: string;
  readonly settlementPageSize?: number;
}

interface StoredSale {
  readonly fingerprint: string;
  readonly input: StartSaleRequest;
  readonly providerReference: string;
  readonly eventualPaymentId: string;
  result: PaymentResult;
  settlementRecorded: boolean;
}

interface StoredRefund {
  readonly fingerprint: string;
  readonly result: RefundResult;
}

const CAPABILITIES: PaymentCapabilities = Object.freeze({
  cardBrands: Object.freeze(
    ["VISA", "MASTERCARD", "AMEX", "JCB", "UNIONPAY"] as const,
  ),
  entryMethods: Object.freeze(["CONTACTLESS", "CONTACT_CHIP"] as const),
  supportsCancellation: true,
  supportsPartialRefunds: true,
  supportsWebhooks: true,
  supportsSettlementListing: true,
});

export class SimulatedPaymentProvider implements PaymentProvider {
  readonly name = SIMULATED_PROVIDER_NAME;
  readonly capabilities = CAPABILITIES;

  private readonly clock: () => Date;
  private readonly webhookSecret: string;
  private readonly settlementPageSize: number;
  private readonly salesByAttempt = new Map<string, StoredSale>();
  private readonly attemptByIdempotencyKey = new Map<string, string>();
  private readonly salesByPaymentId = new Map<string, StoredSale>();
  private readonly refundsByIdempotencyKey = new Map<string, StoredRefund>();
  private readonly refundedByPaymentId = new Map<string, bigint>();
  private readonly settlementItems: ProviderSettlementItem[] = [];

  constructor(options: SimulatedPaymentProviderOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.webhookSecret = requireText(
      options.webhookSecret ?? SIMULATED_WEBHOOK_SECRET,
      "webhookSecret",
    );
    const pageSize = options.settlementPageSize ?? 100;
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
      throw new PaymentProviderError(
        "INVALID_REQUEST",
        "settlementPageSize must be a positive safe integer",
      );
    }
    this.settlementPageSize = pageSize;
  }

  async startSale(input: StartSaleRequest): Promise<PaymentResult> {
    assertNoSensitiveCardData(input);
    validateSaleInput(input);
    const fingerprint = fingerprintSale(input);

    const replayAttemptId = this.attemptByIdempotencyKey.get(input.idempotencyKey);
    if (replayAttemptId !== undefined) {
      const replay = this.requireSale(replayAttemptId);
      assertSameFingerprint(replay.fingerprint, fingerprint);
      return copyPaymentResult(replay.result);
    }

    const existingAttempt = this.salesByAttempt.get(input.attemptId);
    if (existingAttempt !== undefined) {
      assertSameFingerprint(existingAttempt.fingerprint, fingerprint);
      return copyPaymentResult(existingAttempt.result);
    }

    const processedAt = this.now();
    const providerReference = `sim_ref_${stableHash(input.attemptId)}`;
    const eventualPaymentId = `sim_pay_${stableHash(input.attemptId)}`;
    const suffix = normalizedSuffix(input.amount.minorUnits);
    const status =
      suffix === SIMULATED_OUTCOME_SUFFIXES.DECLINED
        ? "DECLINED"
        : suffix === SIMULATED_OUTCOME_SUFFIXES.UNKNOWN_THEN_CAPTURED
          ? "UNKNOWN"
          : "CAPTURED";

    const result: PaymentResult = Object.freeze({
      attemptId: input.attemptId,
      status,
      providerPaymentId: status === "CAPTURED" ? eventualPaymentId : null,
      providerReference,
      failureCode: status === "DECLINED" ? "SIMULATED_DECLINE" : null,
      failureMessage: status === "DECLINED" ? "The simulated card was declined" : null,
      card: status === "CAPTURED" ? simulatedCard() : null,
      processedAt,
    });
    const stored: StoredSale = {
      fingerprint,
      input: copySaleInput(input),
      providerReference,
      eventualPaymentId,
      result,
      settlementRecorded: false,
    };
    this.salesByAttempt.set(input.attemptId, stored);
    this.attemptByIdempotencyKey.set(input.idempotencyKey, input.attemptId);

    if (status === "CAPTURED") {
      this.salesByPaymentId.set(eventualPaymentId, stored);
      this.recordCapturedSettlement(stored);
    }
    return copyPaymentResult(result);
  }

  async getStatus(attemptId: string): Promise<PaymentResult> {
    const stored = this.requireSale(requireText(attemptId, "attemptId"));
    if (stored.result.status === "UNKNOWN") {
      stored.result = Object.freeze({
        attemptId: stored.input.attemptId,
        status: "CAPTURED",
        providerPaymentId: stored.eventualPaymentId,
        providerReference: stored.providerReference,
        failureCode: null,
        failureMessage: null,
        card: simulatedCard(),
        processedAt: this.now(),
      });
      this.salesByPaymentId.set(stored.eventualPaymentId, stored);
      this.recordCapturedSettlement(stored);
    }
    return copyPaymentResult(stored.result);
  }

  async cancel(attemptId: string): Promise<PaymentResult> {
    const stored = this.requireSale(requireText(attemptId, "attemptId"));
    if (stored.result.status === "CAPTURED") {
      throw new PaymentProviderError(
        "OPERATION_NOT_ALLOWED",
        "A captured payment cannot be canceled; issue a refund instead",
      );
    }
    if (stored.result.status === "DECLINED" || stored.result.status === "CANCELED") {
      return copyPaymentResult(stored.result);
    }
    stored.result = Object.freeze({
      attemptId: stored.input.attemptId,
      status: "CANCELED",
      providerPaymentId: null,
      providerReference: stored.providerReference,
      failureCode: null,
      failureMessage: null,
      card: null,
      processedAt: this.now(),
    });
    return copyPaymentResult(stored.result);
  }

  async refund(input: RefundRequest): Promise<RefundResult> {
    assertNoSensitiveCardData(input);
    validateRefundInput(input);
    const fingerprint = fingerprintRefund(input);
    const replay = this.refundsByIdempotencyKey.get(input.idempotencyKey);
    if (replay !== undefined) {
      assertSameFingerprint(replay.fingerprint, fingerprint);
      return copyRefundResult(replay.result);
    }

    const sale = this.salesByPaymentId.get(input.paymentId);
    if (sale === undefined || sale.result.status !== "CAPTURED") {
      throw new PaymentProviderError(
        "PAYMENT_NOT_FOUND",
        `Captured payment not found: ${input.paymentId}`,
      );
    }
    sale.input.amount.assertSameCurrency(input.amount);
    const alreadyRefunded = this.refundedByPaymentId.get(input.paymentId) ?? 0n;
    if (alreadyRefunded + input.amount.minorUnits > sale.input.amount.minorUnits) {
      throw new PaymentProviderError(
        "OPERATION_NOT_ALLOWED",
        "Refund amount exceeds the unrefunded captured amount",
      );
    }

    const processedAt = this.now();
    const providerRefundId = `sim_refund_${stableHash(input.refundId)}`;
    const result: RefundResult = Object.freeze({
      refundId: input.refundId,
      paymentId: input.paymentId,
      providerRefundId,
      status: "SUCCEEDED",
      amount: input.amount,
      failureCode: null,
      failureMessage: null,
      processedAt,
    });
    this.refundsByIdempotencyKey.set(input.idempotencyKey, { fingerprint, result });
    this.refundedByPaymentId.set(
      input.paymentId,
      alreadyRefunded + input.amount.minorUnits,
    );
    const negativeAmount = input.amount.multiply(-1);
    this.settlementItems.push(
      Object.freeze({
        id: `sim_settlement_refund_${stableHash(input.refundId)}`,
        kind: "REFUND",
        paymentId: input.paymentId,
        refundId: providerRefundId,
        providerReference: providerRefundId,
        grossAmount: negativeAmount,
        feeAmount: Money.zero(input.amount.currency),
        netAmount: negativeAmount,
        occurredAt: new Date(processedAt.getTime()),
      }),
    );
    return copyRefundResult(result);
  }

  async verifyWebhook(
    rawBody: Uint8Array,
    headers: ProviderWebhookHeaders,
  ): Promise<ProviderEvent> {
    const signature = getHeader(headers, "x-simulated-signature");
    if (signature !== this.webhookSecret) {
      throw new PaymentProviderError(
        "INVALID_WEBHOOK",
        "Invalid simulated webhook signature",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      throw new PaymentProviderError("INVALID_WEBHOOK", "Webhook body is not valid JSON");
    }
    assertNoSensitiveCardData(parsed);
    if (!isRecord(parsed) || !isRecord(parsed.data)) {
      throw new PaymentProviderError(
        "INVALID_WEBHOOK",
        "Webhook must contain an object body and data object",
      );
    }
    const id = requireText(parsed.id, "webhook.id");
    const type = requireText(parsed.type, "webhook.type");
    const occurredAt = new Date(requireText(parsed.occurredAt, "webhook.occurredAt"));
    if (Number.isNaN(occurredAt.getTime())) {
      throw new PaymentProviderError(
        "INVALID_WEBHOOK",
        "webhook.occurredAt must be an ISO date",
      );
    }
    return Object.freeze({
      id,
      type,
      occurredAt,
      data: Object.freeze({ ...parsed.data }),
    });
  }

  async listSettlements(cursor?: string): Promise<SettlementPage> {
    let offset = 0;
    if (cursor !== undefined) {
      if (!/^\d+$/.test(cursor)) {
        throw new PaymentProviderError(
          "INVALID_REQUEST",
          "Settlement cursor must be a non-negative integer string",
        );
      }
      offset = Number(cursor);
      if (!Number.isSafeInteger(offset)) {
        throw new PaymentProviderError("INVALID_REQUEST", "Settlement cursor is too large");
      }
    }
    const end = Math.min(offset + this.settlementPageSize, this.settlementItems.length);
    const items = Object.freeze(
      this.settlementItems.slice(offset, end).map(copySettlementItem),
    );
    return Object.freeze({
      items,
      nextCursor: end < this.settlementItems.length ? String(end) : null,
    });
  }

  private requireSale(attemptId: string): StoredSale {
    const sale = this.salesByAttempt.get(attemptId);
    if (sale === undefined) {
      throw new PaymentProviderError(
        "ATTEMPT_NOT_FOUND",
        `Payment attempt not found: ${attemptId}`,
      );
    }
    return sale;
  }

  private recordCapturedSettlement(sale: StoredSale): void {
    if (sale.settlementRecorded) return;
    sale.settlementRecorded = true;
    const paymentId = sale.eventualPaymentId;
    this.settlementItems.push(
      Object.freeze({
        id: `sim_settlement_payment_${stableHash(sale.input.attemptId)}`,
        kind: "PAYMENT",
        paymentId,
        refundId: null,
        providerReference: sale.providerReference,
        grossAmount: sale.input.amount,
        feeAmount: Money.zero(sale.input.amount.currency),
        netAmount: sale.input.amount,
        occurredAt: new Date(sale.result.processedAt.getTime()),
      }),
    );
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new PaymentProviderError("INVALID_REQUEST", "Simulator clock returned an invalid Date");
    }
    return new Date(value.getTime());
  }
}

function validateSaleInput(input: StartSaleRequest): void {
  requireText(input.attemptId, "attemptId");
  requireText(input.orderId, "orderId");
  requireText(input.terminalId, "terminalId");
  requireText(input.idempotencyKey, "idempotencyKey");
  if (!(input.amount instanceof Money) || input.amount.minorUnits <= 0n) {
    throw new PaymentProviderError("INVALID_REQUEST", "Sale amount must be positive Money");
  }
}

function validateRefundInput(input: RefundRequest): void {
  requireText(input.refundId, "refundId");
  requireText(input.paymentId, "paymentId");
  requireText(input.idempotencyKey, "idempotencyKey");
  if (!(input.amount instanceof Money) || input.amount.minorUnits <= 0n) {
    throw new PaymentProviderError("INVALID_REQUEST", "Refund amount must be positive Money");
  }
}

function fingerprintSale(input: StartSaleRequest): string {
  return stableSerialize({
    attemptId: input.attemptId,
    orderId: input.orderId,
    amount: input.amount.toJSON(),
    terminalId: input.terminalId,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata ?? {},
  });
}

function fingerprintRefund(input: RefundRequest): string {
  return stableSerialize({
    refundId: input.refundId,
    paymentId: input.paymentId,
    amount: input.amount.toJSON(),
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata ?? {},
  });
}

function copySaleInput(input: StartSaleRequest): StartSaleRequest {
  const base = {
    attemptId: input.attemptId,
    orderId: input.orderId,
    amount: input.amount,
    terminalId: input.terminalId,
    idempotencyKey: input.idempotencyKey,
  };
  return input.metadata === undefined
    ? Object.freeze(base)
    : Object.freeze({ ...base, metadata: Object.freeze({ ...input.metadata }) });
}

function copyPaymentResult(result: PaymentResult): PaymentResult {
  return Object.freeze({
    ...result,
    card: result.card === null ? null : Object.freeze({ ...result.card }),
    processedAt: new Date(result.processedAt.getTime()),
  });
}

function copyRefundResult(result: RefundResult): RefundResult {
  return Object.freeze({
    ...result,
    processedAt: new Date(result.processedAt.getTime()),
  });
}

function copySettlementItem(item: ProviderSettlementItem): ProviderSettlementItem {
  return Object.freeze({
    ...item,
    occurredAt: new Date(item.occurredAt.getTime()),
  });
}

function simulatedCard() {
  return Object.freeze({
    brand: "VISA" as const,
    last4: "4242",
    entryMethod: "CONTACTLESS" as const,
  });
}

function normalizedSuffix(minorUnits: bigint): bigint {
  const remainder = minorUnits % 100n;
  return remainder < 0n ? remainder + 100n : remainder;
}

function assertSameFingerprint(existing: string, incoming: string): void {
  if (existing !== incoming) {
    throw new PaymentProviderError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key or attempt id was reused with different request data",
    );
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PaymentProviderError("INVALID_REQUEST", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function getHeader(headers: ProviderWebhookHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (current: unknown): string => {
    if (current === null) return "null";
    if (typeof current === "string") return JSON.stringify(current);
    if (typeof current === "boolean") return current ? "true" : "false";
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new PaymentProviderError("INVALID_REQUEST", "Metadata numbers must be finite");
      }
      return JSON.stringify(current);
    }
    if (typeof current === "bigint") return `{"$bigint":${JSON.stringify(current.toString())}}`;
    if (typeof current === "undefined") return `{"$undefined":true}`;
    if (typeof current === "function" || typeof current === "symbol") {
      throw new PaymentProviderError(
        "INVALID_REQUEST",
        "Metadata must be serializable provider data",
      );
    }
    if (current instanceof Date) return `{"$date":${JSON.stringify(current.toISOString())}}`;
    if (seen.has(current)) {
      throw new PaymentProviderError("INVALID_REQUEST", "Metadata must not be circular");
    }
    seen.add(current);
    if (Array.isArray(current)) {
      return `[${current.map(visit).join(",")}]`;
    }
    const record = current as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${visit(record[key])}`)
      .join(",")}}`;
  };
  return visit(value);
}

/** Stable 64-bit FNV-1a identifier, suitable for deterministic test IDs. */
function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
