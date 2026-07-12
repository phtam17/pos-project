import type {
  CardBrand,
  CardEntryMethod,
  CardSummary,
  Money,
  PaymentAttemptStatus,
} from "@pos/domain";

export type PaymentResultStatus = Exclude<PaymentAttemptStatus, "CREATED">;

export type PaymentMethodKind = "CARD" | "VIETNAM_QR";
export type VietnamQrWallet = "VCB" | "MOMO" | "ZALOPAY" | "SHOPEEPAY_VN";

export interface QrPaymentPresentation {
  readonly type: "QR_CODE";
  readonly payload: string;
  readonly expiresAt: Date;
  readonly supportedWallets: readonly VietnamQrWallet[];
  readonly sandbox: boolean;
}

export type PaymentPresentation = QrPaymentPresentation;

export interface WalletPaymentSummary {
  readonly wallet: VietnamQrWallet;
  readonly payerCurrency: "VND";
  readonly payerAmountMinor: string;
  readonly exchangeRate: string;
}

export interface PaymentCapabilities {
  readonly paymentMethods?: readonly PaymentMethodKind[];
  readonly cardBrands: readonly CardBrand[];
  readonly entryMethods: readonly Exclude<CardEntryMethod, "UNKNOWN">[];
  readonly supportsCancellation: boolean;
  readonly supportsPartialRefunds: boolean;
  readonly supportsWebhooks: boolean;
  readonly supportsSettlementListing: boolean;
}

/**
 * The request intentionally contains no PAN, CVV, track, PIN, or EMV fields.
 * Card collection must happen on the provider's certified reader.
 */
export interface StartSaleRequest {
  readonly attemptId: string;
  readonly orderId: string;
  readonly amount: Money;
  readonly terminalId: string;
  readonly idempotencyKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PaymentResult {
  readonly attemptId: string;
  readonly status: PaymentResultStatus;
  readonly providerPaymentId: string | null;
  readonly providerReference: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  /** Masked, non-sensitive display data only. */
  readonly card: CardSummary | null;
  readonly presentation?: QrPaymentPresentation;
  readonly wallet?: WalletPaymentSummary;
  readonly processedAt: Date;
}

export interface RefundRequest {
  readonly refundId: string;
  readonly paymentId: string;
  readonly amount: Money;
  readonly idempotencyKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ProviderRefundStatus = "PENDING" | "SUCCEEDED" | "FAILED";

export interface RefundResult {
  readonly refundId: string;
  readonly paymentId: string;
  readonly providerRefundId: string | null;
  readonly status: ProviderRefundStatus;
  readonly amount: Money;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly processedAt: Date;
}

export interface ProviderEvent {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly data: Readonly<Record<string, unknown>>;
}

export type ProviderWebhookHeaders = Readonly<Record<string, string | undefined>>;

export type ProviderSettlementKind = "PAYMENT" | "REFUND" | "FEE" | "ADJUSTMENT";

export interface ProviderSettlementItem {
  readonly id: string;
  readonly kind: ProviderSettlementKind;
  readonly paymentId: string | null;
  readonly refundId: string | null;
  readonly providerReference: string;
  readonly grossAmount: Money;
  readonly feeAmount: Money;
  readonly netAmount: Money;
  readonly occurredAt: Date;
}

export interface SettlementPage {
  readonly items: readonly ProviderSettlementItem[];
  readonly nextCursor: string | null;
}

/** A processor/terminal-neutral boundary used by application checkout flows. */
export interface PaymentProvider {
  readonly name: string;
  readonly capabilities: PaymentCapabilities;

  startSale(input: StartSaleRequest): Promise<PaymentResult>;
  getStatus(attemptId: string): Promise<PaymentResult>;
  cancel(attemptId: string): Promise<PaymentResult>;
  refund(input: RefundRequest): Promise<RefundResult>;
  verifyWebhook(
    rawBody: Uint8Array,
    headers: ProviderWebhookHeaders,
  ): Promise<ProviderEvent>;
  listSettlements(cursor?: string): Promise<SettlementPage>;
}

export type PaymentProviderErrorCode =
  | "ATTEMPT_NOT_FOUND"
  | "PAYMENT_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_REQUEST"
  | "INVALID_WEBHOOK"
  | "OPERATION_NOT_ALLOWED"
  | "SENSITIVE_CARD_DATA"
  | "PROVIDER_UNAVAILABLE";

export class PaymentProviderError extends Error {
  constructor(
    readonly code: PaymentProviderErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

export class SensitiveCardDataError extends PaymentProviderError {
  constructor(message = "Raw card data is not accepted by the payment adapter") {
    super("SENSITIVE_CARD_DATA", message, false);
    this.name = "SensitiveCardDataError";
  }
}

export type {
  CardBrand,
  CardEntryMethod,
  CardSummary,
  Money,
  PaymentAttemptStatus,
};
