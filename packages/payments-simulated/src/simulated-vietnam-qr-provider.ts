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
  type VietnamQrWallet,
} from "@pos/payment-contract";

import { assertNoSensitiveCardData } from "./sensitive-data.js";

export const SIMULATED_VIETNAM_QR_PROVIDER_NAME = "simulated-vietnam-qr";
export const VIETNAM_QR_WALLETS = Object.freeze(
  ["VCB", "MOMO", "ZALOPAY", "SHOPEEPAY_VN"] as const,
);

export type SandboxVietnamQrOutcome = "APPROVED" | "DECLINED" | "EXPIRED";

interface StoredQrSale {
  readonly input: StartSaleRequest;
  readonly fingerprint: string;
  readonly providerReference: string;
  readonly expiresAt: Date;
  result: PaymentResult;
  settlementRecorded: boolean;
}

interface StoredRefund {
  readonly fingerprint: string;
  readonly result: RefundResult;
}

export interface SimulatedVietnamQrProviderOptions {
  readonly clock?: () => Date;
  readonly expiresInMs?: number;
  readonly settlementFeeBps?: number;
  readonly settlementPageSize?: number;
}

const CAPABILITIES: PaymentCapabilities = Object.freeze({
  paymentMethods: Object.freeze(["VIETNAM_QR"] as const),
  cardBrands: Object.freeze([]),
  entryMethods: Object.freeze([]),
  supportsCancellation: true,
  supportsPartialRefunds: true,
  supportsWebhooks: true,
  supportsSettlementListing: true,
});

export class SimulatedVietnamQrProvider implements PaymentProvider {
  readonly name = SIMULATED_VIETNAM_QR_PROVIDER_NAME;
  readonly capabilities = CAPABILITIES;

  private readonly clock: () => Date;
  private readonly expiresInMs: number;
  private readonly settlementFeeBps: number;
  private readonly settlementPageSize: number;
  private readonly salesByAttempt = new Map<string, StoredQrSale>();
  private readonly attemptByIdempotencyKey = new Map<string, string>();
  private readonly salesByPaymentId = new Map<string, StoredQrSale>();
  private readonly refundsByIdempotencyKey = new Map<string, StoredRefund>();
  private readonly refundedByPaymentId = new Map<string, bigint>();
  private readonly settlementItems: ProviderSettlementItem[] = [];

  constructor(options: SimulatedVietnamQrProviderOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.expiresInMs = positiveInteger(options.expiresInMs ?? 5 * 60_000, "expiresInMs");
    this.settlementFeeBps = nonNegativeInteger(options.settlementFeeBps ?? 250, "settlementFeeBps");
    this.settlementPageSize = positiveInteger(options.settlementPageSize ?? 100, "settlementPageSize");
  }

  async startSale(input: StartSaleRequest): Promise<PaymentResult> {
    assertNoSensitiveCardData(input);
    validateSale(input);
    const fingerprint = saleFingerprint(input);
    const replayAttemptId = this.attemptByIdempotencyKey.get(input.idempotencyKey);
    if (replayAttemptId) {
      const replay = this.requireSale(replayAttemptId);
      assertFingerprint(replay.fingerprint, fingerprint);
      return copyPaymentResult(replay.result);
    }
    const existing = this.salesByAttempt.get(input.attemptId);
    if (existing) {
      assertFingerprint(existing.fingerprint, fingerprint);
      return copyPaymentResult(existing.result);
    }

    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.expiresInMs);
    const providerReference = `vnqr_order_${stableHash(input.attemptId)}`;
    const payload = new URL("https://sandbox.openpos.local/vietnam-qr");
    payload.searchParams.set("attempt", input.attemptId);
    payload.searchParams.set("amount", input.amount.minorUnits.toString());
    payload.searchParams.set("currency", input.amount.currency);

    const result: PaymentResult = Object.freeze({
      attemptId: input.attemptId,
      status: "PROCESSING",
      providerPaymentId: null,
      providerReference,
      failureCode: null,
      failureMessage: null,
      card: null,
      presentation: Object.freeze({
        type: "QR_CODE",
        payload: payload.toString(),
        expiresAt,
        supportedWallets: VIETNAM_QR_WALLETS,
        sandbox: true,
      }),
      processedAt: now,
    });
    const stored: StoredQrSale = {
      input: copySaleInput(input),
      fingerprint,
      providerReference,
      expiresAt,
      result,
      settlementRecorded: false,
    };
    this.salesByAttempt.set(input.attemptId, stored);
    this.attemptByIdempotencyKey.set(input.idempotencyKey, input.attemptId);
    return copyPaymentResult(result);
  }

  async getStatus(attemptId: string): Promise<PaymentResult> {
    const stored = this.requireSale(requireText(attemptId, "attemptId"));
    if (stored.result.status === "PROCESSING" && this.now().getTime() >= stored.expiresAt.getTime()) {
      this.applyOutcome(stored, "VCB", "EXPIRED");
    }
    return copyPaymentResult(stored.result);
  }

  async completeSandboxPayment(
    attemptId: string,
    wallet: VietnamQrWallet,
    outcome: SandboxVietnamQrOutcome,
  ): Promise<PaymentResult> {
    if (!VIETNAM_QR_WALLETS.includes(wallet)) {
      throw new PaymentProviderError("INVALID_REQUEST", `Unsupported sandbox wallet: ${wallet}`);
    }
    const stored = this.requireSale(requireText(attemptId, "attemptId"));
    if (stored.result.status !== "PROCESSING") return copyPaymentResult(stored.result);
    this.applyOutcome(stored, wallet, outcome);
    return copyPaymentResult(stored.result);
  }

  async cancel(attemptId: string): Promise<PaymentResult> {
    return this.completeSandboxPayment(attemptId, "VCB", "EXPIRED");
  }

  async refund(input: RefundRequest): Promise<RefundResult> {
    assertNoSensitiveCardData(input);
    validateRefund(input);
    const fingerprint = refundFingerprint(input);
    const replay = this.refundsByIdempotencyKey.get(input.idempotencyKey);
    if (replay) {
      assertFingerprint(replay.fingerprint, fingerprint);
      return copyRefundResult(replay.result);
    }
    const sale = this.salesByPaymentId.get(input.paymentId);
    if (!sale || sale.result.status !== "CAPTURED") {
      throw new PaymentProviderError("PAYMENT_NOT_FOUND", `Vietnam QR payment not found: ${input.paymentId}`);
    }
    sale.input.amount.assertSameCurrency(input.amount);
    const alreadyRefunded = this.refundedByPaymentId.get(input.paymentId) ?? 0n;
    if (alreadyRefunded + input.amount.minorUnits > sale.input.amount.minorUnits) {
      throw new PaymentProviderError("OPERATION_NOT_ALLOWED", "Refund exceeds the captured Vietnam QR amount");
    }
    const processedAt = this.now();
    const providerRefundId = `vnqr_refund_${stableHash(input.refundId)}`;
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
    this.refundedByPaymentId.set(input.paymentId, alreadyRefunded + input.amount.minorUnits);
    const negative = input.amount.multiply(-1);
    this.settlementItems.push(Object.freeze({
      id: `vnqr_settlement_refund_${stableHash(input.refundId)}`,
      kind: "REFUND",
      paymentId: input.paymentId,
      refundId: providerRefundId,
      providerReference: providerRefundId,
      grossAmount: negative,
      feeAmount: Money.zero(input.amount.currency),
      netAmount: negative,
      occurredAt: processedAt,
    }));
    return copyRefundResult(result);
  }

  async verifyWebhook(rawBody: Uint8Array, headers: ProviderWebhookHeaders): Promise<ProviderEvent> {
    if (header(headers, "x-vietnam-qr-sandbox-signature") !== "vietnam-qr-sandbox-secret") {
      throw new PaymentProviderError("INVALID_WEBHOOK", "Invalid Vietnam QR sandbox signature");
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      throw new PaymentProviderError("INVALID_WEBHOOK", "Vietnam QR webhook is not valid JSON");
    }
    if (!isRecord(value) || !isRecord(value.data)) {
      throw new PaymentProviderError("INVALID_WEBHOOK", "Vietnam QR webhook must contain data");
    }
    return Object.freeze({
      id: requireText(value.id, "webhook.id"),
      type: requireText(value.type, "webhook.type"),
      occurredAt: this.now(),
      data: Object.freeze({ ...value.data }),
    });
  }

  async listSettlements(cursor?: string): Promise<SettlementPage> {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new PaymentProviderError("INVALID_REQUEST", "Settlement cursor must be a non-negative integer");
    }
    const end = Math.min(offset + this.settlementPageSize, this.settlementItems.length);
    return Object.freeze({
      items: Object.freeze(this.settlementItems.slice(offset, end).map(copySettlementItem)),
      nextCursor: end < this.settlementItems.length ? String(end) : null,
    });
  }

  private applyOutcome(
    stored: StoredQrSale,
    wallet: VietnamQrWallet,
    outcome: SandboxVietnamQrOutcome,
  ): void {
    const processedAt = this.now();
    if (outcome === "APPROVED") {
      const providerPaymentId = `vnqr_pay_${wallet.toLowerCase()}_${stableHash(stored.input.attemptId)}`;
      stored.result = Object.freeze({
        attemptId: stored.input.attemptId,
        status: "CAPTURED",
        providerPaymentId,
        providerReference: providerPaymentId,
        failureCode: null,
        failureMessage: null,
        card: null,
        wallet: walletSummary(wallet, stored.input.amount),
        processedAt,
      });
      this.salesByPaymentId.set(providerPaymentId, stored);
      this.recordSettlement(stored, providerPaymentId);
      return;
    }
    stored.result = Object.freeze({
      attemptId: stored.input.attemptId,
      status: outcome === "DECLINED" ? "DECLINED" : "CANCELED",
      providerPaymentId: null,
      providerReference: stored.providerReference,
      failureCode: outcome === "DECLINED" ? "SANDBOX_CUSTOMER_DECLINED" : "QR_EXPIRED",
      failureMessage: outcome === "DECLINED"
        ? "The sandbox customer declined the Vietnam QR payment"
        : "The sandbox Vietnam QR code expired",
      card: null,
      processedAt,
    });
  }

  private recordSettlement(stored: StoredQrSale, paymentId: string): void {
    if (stored.settlementRecorded) return;
    stored.settlementRecorded = true;
    const feeMinor = (stored.input.amount.minorUnits * BigInt(this.settlementFeeBps) + 5_000n) / 10_000n;
    const fee = Money.fromMinor(feeMinor, stored.input.amount.currency);
    this.settlementItems.push(Object.freeze({
      id: `vnqr_settlement_payment_${stableHash(stored.input.attemptId)}`,
      kind: "PAYMENT",
      paymentId,
      refundId: null,
      providerReference: paymentId,
      grossAmount: stored.input.amount,
      feeAmount: fee,
      netAmount: stored.input.amount.subtract(fee),
      occurredAt: stored.result.processedAt,
    }));
  }

  private requireSale(attemptId: string): StoredQrSale {
    const sale = this.salesByAttempt.get(attemptId);
    if (!sale) throw new PaymentProviderError("ATTEMPT_NOT_FOUND", `Vietnam QR attempt not found: ${attemptId}`);
    return sale;
  }

  private now(): Date {
    const value = this.clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new PaymentProviderError("INVALID_REQUEST", "Sandbox clock returned an invalid date");
    }
    return new Date(value.getTime());
  }
}

function walletSummary(wallet: VietnamQrWallet, amount: Money) {
  const exchangeRate = 25_500n;
  const payerAmount = amount.minorUnits * exchangeRate / 100n;
  return Object.freeze({
    wallet,
    payerCurrency: "VND" as const,
    payerAmountMinor: payerAmount.toString(),
    exchangeRate: exchangeRate.toString(),
  });
}

function validateSale(input: StartSaleRequest): void {
  requireText(input.attemptId, "attemptId");
  requireText(input.orderId, "orderId");
  requireText(input.terminalId, "terminalId");
  requireText(input.idempotencyKey, "idempotencyKey");
  if (!(input.amount instanceof Money) || input.amount.minorUnits <= 0n) {
    throw new PaymentProviderError("INVALID_REQUEST", "Vietnam QR amount must be positive");
  }
}

function validateRefund(input: RefundRequest): void {
  requireText(input.refundId, "refundId");
  requireText(input.paymentId, "paymentId");
  requireText(input.idempotencyKey, "idempotencyKey");
  if (!(input.amount instanceof Money) || input.amount.minorUnits <= 0n) {
    throw new PaymentProviderError("INVALID_REQUEST", "Refund amount must be positive");
  }
}

function saleFingerprint(input: StartSaleRequest): string {
  return JSON.stringify({
    attemptId: input.attemptId,
    orderId: input.orderId,
    amount: input.amount.toJSON(),
    terminalId: input.terminalId,
    idempotencyKey: input.idempotencyKey,
  });
}

function refundFingerprint(input: RefundRequest): string {
  return JSON.stringify({
    refundId: input.refundId,
    paymentId: input.paymentId,
    amount: input.amount.toJSON(),
    idempotencyKey: input.idempotencyKey,
  });
}

function copySaleInput(input: StartSaleRequest): StartSaleRequest {
  return Object.freeze({
    attemptId: input.attemptId,
    orderId: input.orderId,
    amount: input.amount,
    terminalId: input.terminalId,
    idempotencyKey: input.idempotencyKey,
    ...(input.metadata ? { metadata: Object.freeze({ ...input.metadata }) } : {}),
  });
}

function copyPaymentResult(result: PaymentResult): PaymentResult {
  return Object.freeze({
    ...result,
    card: result.card ? Object.freeze({ ...result.card }) : null,
    ...(result.presentation
      ? {
          presentation: Object.freeze({
            ...result.presentation,
            expiresAt: new Date(result.presentation.expiresAt.getTime()),
            supportedWallets: Object.freeze([...result.presentation.supportedWallets]),
          }),
        }
      : {}),
    ...(result.wallet ? { wallet: Object.freeze({ ...result.wallet }) } : {}),
    processedAt: new Date(result.processedAt.getTime()),
  });
}

function copyRefundResult(result: RefundResult): RefundResult {
  return Object.freeze({ ...result, processedAt: new Date(result.processedAt.getTime()) });
}

function copySettlementItem(item: ProviderSettlementItem): ProviderSettlementItem {
  return Object.freeze({ ...item, occurredAt: new Date(item.occurredAt.getTime()) });
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PaymentProviderError("INVALID_REQUEST", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertFingerprint(existing: string, incoming: string): void {
  if (existing !== incoming) {
    throw new PaymentProviderError("IDEMPOTENCY_CONFLICT", "Sandbox request was replayed with different data");
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PaymentProviderError("INVALID_REQUEST", `${field} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PaymentProviderError("INVALID_REQUEST", `${field} must be a non-negative integer`);
  }
  return value;
}

function header(headers: ProviderWebhookHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
