export type AmountMinor = string;
export type Tender = "cash" | "card" | "vietnam_qr";
export type VietnamQrWallet = "VCB" | "MOMO" | "ZALOPAY" | "SHOPEEPAY_VN";
export type SandboxQrOutcome = "APPROVED" | "DECLINED" | "EXPIRED";

export interface QrPresentationDto {
  type: "QR_CODE";
  payload: string;
  expiresAt: string;
  supportedWallets: VietnamQrWallet[];
  sandbox: boolean;
  quote: VietnamQrQuoteDto;
}

export interface VietnamQrQuoteDto {
  payerCurrency: "VND";
  payerAmountMinor: AmountMinor;
  exchangeRate: string;
  settlementFeeBps: number;
  settlementFeeMinor: AmountMinor;
  merchantNetMinor: AmountMinor;
  expiresAt: string;
}

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

export interface PaymentTimelineEventDto {
  id: string;
  type: PaymentTimelineEventType;
  description: string;
  occurredAt: string;
}

export interface VietnamQrDetailsDto {
  quote: VietnamQrQuoteDto;
  selectedWallet?: VietnamQrWallet;
  timeline: PaymentTimelineEventDto[];
}

export interface ProductDto {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  category: string;
  priceMinor: AmountMinor;
  currency: string;
  available: boolean;
}

export interface RuntimeStatusDto {
  mode: "sandbox";
  api: { connected: boolean; ready: boolean };
  persistence: {
    mode: "memory" | "postgres";
    ready: boolean;
    ephemeral: boolean;
  };
  simulators: {
    card: { ready: boolean; provider?: string };
    vietnamQr: { ready: boolean; provider?: string };
  };
  warnings: string[];
  checkedAt: string;
}

export interface CartLineDto {
  id: string;
  productId: string;
  name: string;
  sku?: string;
  quantity: number;
  unitPriceMinor: AmountMinor;
  lineTotalMinor: AmountMinor;
}

export interface CartDto {
  id: string;
  status: string;
  currency: string;
  lines: CartLineDto[];
  subtotalMinor: AmountMinor;
  taxMinor: AmountMinor;
  totalMinor: AmountMinor;
}

export interface OrderDto {
  id: string;
  number: string;
  status: string;
  currency: string;
  lines: CartLineDto[];
  subtotalMinor: AmountMinor;
  taxMinor: AmountMinor;
  totalMinor: AmountMinor;
  createdAt?: string;
}

export interface PaymentAttemptDto {
  id: string;
  orderId: string;
  status: string;
  tender: Tender;
  amountMinor: AmountMinor;
  cardBrand?: string;
  last4?: string;
  failureMessage?: string;
  provider?: string;
  presentation?: QrPresentationDto;
  wallet?: VietnamQrWallet;
  payerAmountMinor?: AmountMinor;
  payerCurrency?: string;
  exchangeRate?: string;
  settlementFeeBps?: number;
  settlementFeeMinor?: AmountMinor;
  merchantNetMinor?: AmountMinor;
  vietnamQr?: VietnamQrDetailsDto;
  createdAt?: string;
}

export interface RefundDto {
  id: string;
  paymentId: string;
  provider: string;
  status: string;
  amountMinor: AmountMinor;
  currency: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaleDetailDto {
  order: OrderDto;
  payments: PaymentAttemptDto[];
  refunds: RefundDto[];
  refundedMinor: AmountMinor;
  remainingMinor: AmountMinor;
}

export interface ReceiptDto {
  orderId: string;
  orderNumber: string;
  currency: string;
  createdAt: string;
  lines: CartLineDto[];
  subtotalMinor: AmountMinor;
  taxMinor: AmountMinor;
  totalMinor: AmountMinor;
  tender?: Tender;
  paymentStatus?: string;
  cardBrand?: string;
  last4?: string;
  wallet?: VietnamQrWallet;
  vietnamQr?: VietnamQrDetailsDto;
  refundStatus: "NONE" | "PENDING" | "PARTIAL" | "FULL";
  refundedMinor: AmountMinor;
  remainingMinor: AmountMinor;
  refunds: RefundDto[];
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function envelope(value: unknown, keys: string[]): unknown {
  let current = value;

  if (isRecord(current) && "data" in current) {
    current = current.data;
  }

  if (isRecord(current)) {
    for (const key of keys) {
      if (key in current) return current[key];
    }
  }

  return current;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function amount(value: unknown, fallback = "0"): AmountMinor {
  const candidate = text(value, fallback);
  return /^-?\d+$/.test(candidate) ? candidate : fallback;
}

function numeric(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalText(value: unknown): string | undefined {
  const candidate = text(value);
  return candidate.length > 0 ? candidate : undefined;
}

function normalizeProduct(value: unknown): ProductDto {
  const source = record(value);
  const optionalBarcode = optionalText(source.barcode);

  return {
    id: text(source.id),
    name: text(source.name, "Unnamed product"),
    sku: text(source.sku, "—"),
    ...(optionalBarcode ? { barcode: optionalBarcode } : {}),
    category: text(source.category, "Other"),
    priceMinor: amount(source.priceMinor ?? source.unitPriceMinor),
    currency: text(source.currency, "USD").toUpperCase(),
    available: source.available !== false && source.active !== false
  };
}

function normalizeRuntimeStatus(value: unknown): RuntimeStatusDto {
  const source = record(value);
  const apiStatus = record(source.api);
  const persistence = record(source.persistence);
  const simulators = record(source.simulators);
  const card = record(simulators.card);
  const vietnamQr = record(simulators.vietnamQr);
  const persistenceMode = text(persistence.mode).toLowerCase() === "postgres"
    ? "postgres"
    : "memory";
  const cardProvider = optionalText(card.provider);
  const vietnamQrProvider = optionalText(vietnamQr.provider);

  return {
    mode: "sandbox",
    api: {
      connected: apiStatus.connected === true,
      ready: apiStatus.ready === true
    },
    persistence: {
      mode: persistenceMode,
      ready: persistence.ready === true,
      ephemeral: persistence.ephemeral === true || persistenceMode === "memory"
    },
    simulators: {
      card: {
        ready: card.ready === true,
        ...(cardProvider ? { provider: cardProvider } : {})
      },
      vietnamQr: {
        ready: vietnamQr.ready === true,
        ...(vietnamQrProvider ? { provider: vietnamQrProvider } : {})
      }
    },
    warnings: Array.isArray(source.warnings)
      ? source.warnings.map((warning) => text(warning)).filter(Boolean)
      : [],
    checkedAt: text(source.checkedAt, new Date().toISOString())
  };
}

function normalizeLine(value: unknown): CartLineDto {
  const source = record(value);
  const product = record(source.product);
  const quantity = numeric(source.quantity, 1);
  const unitPriceMinor = amount(source.unitPriceMinor ?? source.priceMinor ?? product.priceMinor);
  const computedTotal = String(Math.round(Number(unitPriceMinor) * quantity));
  const optionalSku = optionalText(source.sku ?? product.sku);

  return {
    id: text(source.id ?? source.lineId),
    productId: text(source.productId ?? product.id),
    name: text(source.name ?? source.productName ?? product.name, "Item"),
    ...(optionalSku ? { sku: optionalSku } : {}),
    quantity,
    unitPriceMinor,
    lineTotalMinor: amount(source.lineTotalMinor ?? source.totalMinor, computedTotal)
  };
}

function normalizeCart(value: unknown): CartDto {
  const source = record(envelope(value, ["cart"]));
  const lines = Array.isArray(source.lines) ? source.lines.map(normalizeLine) : [];
  const computedSubtotal = lines.reduce((sum, line) => sum + Number(line.lineTotalMinor), 0);
  const subtotalMinor = amount(source.subtotalMinor, String(computedSubtotal));
  const taxMinor = amount(source.taxMinor);
  const computedTotal = String(Number(subtotalMinor) + Number(taxMinor));

  return {
    id: text(source.id),
    status: text(source.status, "OPEN").toUpperCase(),
    currency: text(source.currency, "USD").toUpperCase(),
    lines,
    subtotalMinor,
    taxMinor,
    totalMinor: amount(source.totalMinor, computedTotal)
  };
}

function normalizeOrder(value: unknown): OrderDto {
  const source = record(envelope(value, ["order"]));
  const cartShape = normalizeCart(source);
  const optionalCreatedAt = optionalText(source.createdAt ?? source.capturedAt);

  return {
    id: text(source.id),
    number: text(source.number ?? source.orderNumber, text(source.id).slice(0, 8).toUpperCase()),
    status: text(source.status, "AWAITING_PAYMENT").toUpperCase(),
    currency: cartShape.currency,
    lines: cartShape.lines,
    subtotalMinor: cartShape.subtotalMinor,
    taxMinor: cartShape.taxMinor,
    totalMinor: cartShape.totalMinor,
    ...(optionalCreatedAt ? { createdAt: optionalCreatedAt } : {})
  };
}

function normalizeRefund(value: unknown): RefundDto {
  const source = record(value);
  return {
    id: text(source.id),
    paymentId: text(source.paymentId),
    provider: text(source.provider),
    status: text(source.status, "UNKNOWN").toUpperCase(),
    amountMinor: amount(source.amountMinor),
    currency: text(source.currency, "USD").toUpperCase(),
    ...(optionalText(source.failureCode) ? { failureCode: text(source.failureCode) } : {}),
    createdAt: text(source.createdAt, new Date().toISOString()),
    updatedAt: text(source.updatedAt ?? source.createdAt, new Date().toISOString())
  };
}

function normalizeSaleDetail(value: unknown): SaleDetailDto {
  const source = record(value);
  const order = normalizeOrder(source.order);
  const payments = Array.isArray(source.payments) ? source.payments.map(normalizePayment) : [];
  const refunds = Array.isArray(source.refunds) ? source.refunds.map(normalizeRefund) : [];
  const refunded = refunds
    .filter((refund) => refund.status === "SUCCEEDED")
    .reduce((sum, refund) => sum + BigInt(refund.amountMinor), 0n);
  const total = BigInt(order.totalMinor);
  return {
    order,
    payments,
    refunds,
    refundedMinor: refunded.toString(),
    remainingMinor: (total > refunded ? total - refunded : 0n).toString()
  };
}

function normalizePayment(value: unknown): PaymentAttemptDto {
  const source = record(envelope(value, ["paymentAttempt", "attempt", "payment"]));
  const optionalBrand = optionalText(source.cardBrand ?? source.brand);
  const optionalLast4 = optionalText(source.last4);
  const optionalFailure = optionalText(source.failureMessage ?? source.message);
  const optionalCreatedAt = optionalText(source.createdAt);
  const tenderValue = text(source.tender, "card").toLowerCase();
  const presentation = record(source.presentation);
  const walletDetails = record(source.wallet);
  const vietnamQr = normalizeVietnamQr(source.vietnamQr, presentation.quote);
  const walletValue = optionalText(
    walletDetails.wallet ?? vietnamQr?.selectedWallet ?? source.wallet
  )?.toUpperCase();
  const supportedWallets = Array.isArray(presentation.supportedWallets)
    ? presentation.supportedWallets
        .map((wallet) => text(wallet).toUpperCase())
        .filter(isVietnamQrWallet)
    : [];
  const presentationPayload = optionalText(presentation.payload);
  const presentationExpiresAt = optionalText(presentation.expiresAt);

  return {
    id: text(source.id),
    orderId: text(source.orderId),
    status: text(source.status, "UNKNOWN").toUpperCase(),
    tender: tenderValue === "cash" ? "cash" : tenderValue === "vietnam_qr" ? "vietnam_qr" : "card",
    amountMinor: amount(source.amountMinor),
    ...(optionalText(source.provider) ? { provider: text(source.provider) } : {}),
    ...(optionalBrand ? { cardBrand: optionalBrand } : {}),
    ...(optionalLast4 ? { last4: optionalLast4 } : {}),
    ...(optionalFailure ? { failureMessage: optionalFailure } : {}),
    ...(presentationPayload && presentationExpiresAt
      ? {
          presentation: {
            type: "QR_CODE",
            payload: presentationPayload,
            expiresAt: presentationExpiresAt,
            supportedWallets,
            sandbox: presentation.sandbox === true,
            quote: vietnamQr?.quote ?? normalizeVietnamQrQuote(presentation.quote, presentationExpiresAt)
          }
        }
      : {}),
    ...(walletValue && isVietnamQrWallet(walletValue) ? { wallet: walletValue } : {}),
    ...(optionalText(walletDetails.payerAmountMinor)
      ? { payerAmountMinor: amount(walletDetails.payerAmountMinor) }
      : vietnamQr ? { payerAmountMinor: vietnamQr.quote.payerAmountMinor } : {}),
    ...(optionalText(walletDetails.payerCurrency)
      ? { payerCurrency: text(walletDetails.payerCurrency).toUpperCase() }
      : vietnamQr ? { payerCurrency: vietnamQr.quote.payerCurrency } : {}),
    ...(optionalText(walletDetails.exchangeRate)
      ? { exchangeRate: text(walletDetails.exchangeRate) }
      : vietnamQr ? { exchangeRate: vietnamQr.quote.exchangeRate } : {}),
    ...(Number.isSafeInteger(walletDetails.settlementFeeBps)
      ? { settlementFeeBps: numeric(walletDetails.settlementFeeBps) }
      : vietnamQr ? { settlementFeeBps: vietnamQr.quote.settlementFeeBps } : {}),
    ...(optionalText(walletDetails.settlementFeeMinor)
      ? { settlementFeeMinor: amount(walletDetails.settlementFeeMinor) }
      : vietnamQr ? { settlementFeeMinor: vietnamQr.quote.settlementFeeMinor } : {}),
    ...(optionalText(walletDetails.merchantNetMinor)
      ? { merchantNetMinor: amount(walletDetails.merchantNetMinor) }
      : vietnamQr ? { merchantNetMinor: vietnamQr.quote.merchantNetMinor } : {}),
    ...(vietnamQr ? { vietnamQr } : {}),
    ...(optionalCreatedAt ? { createdAt: optionalCreatedAt } : {})
  };
}

function normalizeVietnamQr(
  value: unknown,
  presentationQuote?: unknown
): VietnamQrDetailsDto | undefined {
  const source = record(value);
  const quoteSource = Object.keys(record(source.quote)).length > 0
    ? source.quote
    : presentationQuote;
  const expiresAt = optionalText(record(quoteSource).expiresAt);
  if (!expiresAt) return undefined;
  const selectedWalletValue = optionalText(source.selectedWallet)?.toUpperCase();
  const timeline = Array.isArray(source.timeline)
    ? source.timeline.map(normalizeTimelineEvent).filter((event): event is PaymentTimelineEventDto => event !== undefined)
    : [];
  return {
    quote: normalizeVietnamQrQuote(quoteSource, expiresAt),
    ...(selectedWalletValue && isVietnamQrWallet(selectedWalletValue)
      ? { selectedWallet: selectedWalletValue }
      : {}),
    timeline
  };
}

function normalizeVietnamQrQuote(value: unknown, fallbackExpiresAt: string): VietnamQrQuoteDto {
  const source = record(value);
  return {
    payerCurrency: "VND",
    payerAmountMinor: amount(source.payerAmountMinor),
    exchangeRate: text(source.exchangeRate, "25500"),
    settlementFeeBps: numeric(source.settlementFeeBps, 250),
    settlementFeeMinor: amount(source.settlementFeeMinor),
    merchantNetMinor: amount(source.merchantNetMinor),
    expiresAt: text(source.expiresAt, fallbackExpiresAt)
  };
}

function normalizeTimelineEvent(value: unknown): PaymentTimelineEventDto | undefined {
  const source = record(value);
  const typeValue = text(source.type).toUpperCase();
  if (!isPaymentTimelineEventType(typeValue)) return undefined;
  return {
    id: text(source.id),
    type: typeValue,
    description: text(source.description, typeValue),
    occurredAt: text(source.occurredAt, new Date().toISOString())
  };
}

function normalizeReceipt(value: unknown): ReceiptDto {
  const source = record(envelope(value, ["receipt"]));
  const payment = record(source.payment);
  const order = normalizeOrder(source);
  const optionalTender = optionalText(source.tender ?? payment.tender)?.toLowerCase();
  const optionalPaymentStatus = optionalText(source.paymentStatus ?? payment.status);
  const optionalBrand = optionalText(source.cardBrand ?? payment.cardBrand);
  const optionalLast4 = optionalText(source.last4 ?? payment.last4);
  const vietnamQr = normalizeVietnamQr(source.vietnamQr ?? payment.vietnamQr);
  const optionalWallet = optionalText(
    source.wallet ?? record(payment.wallet).wallet ?? vietnamQr?.selectedWallet
  )?.toUpperCase();
  const refundStatusValue = text(source.refundStatus, "NONE").toUpperCase();
  const refundStatus = refundStatusValue === "PENDING" || refundStatusValue === "PARTIAL" || refundStatusValue === "FULL"
    ? refundStatusValue
    : "NONE";
  const refunds = Array.isArray(source.refunds) ? source.refunds.map(normalizeRefund) : [];

  return {
    orderId: text(source.orderId ?? source.id),
    orderNumber: text(source.orderNumber ?? source.number, order.number),
    currency: order.currency,
    createdAt: text(source.createdAt, new Date().toISOString()),
    lines: order.lines,
    subtotalMinor: order.subtotalMinor,
    taxMinor: order.taxMinor,
    totalMinor: order.totalMinor,
    ...(optionalTender === "cash" || optionalTender === "card" || optionalTender === "vietnam_qr"
      ? { tender: optionalTender }
      : {}),
    ...(optionalPaymentStatus ? { paymentStatus: optionalPaymentStatus } : {}),
    ...(optionalBrand ? { cardBrand: optionalBrand } : {}),
    ...(optionalLast4 ? { last4: optionalLast4 } : {}),
    ...(optionalWallet && isVietnamQrWallet(optionalWallet) ? { wallet: optionalWallet } : {}),
    ...(vietnamQr ? { vietnamQr } : {}),
    refundStatus,
    refundedMinor: amount(source.refundedMinor),
    remainingMinor: amount(source.remainingMinor, order.totalMinor),
    refunds
  };
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError("The register could not reach the POS service. Check the connection and try again.", 0, "NETWORK_ERROR");
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body: unknown = response.status === 204
    ? undefined
    : contentType.includes("application/json")
      ? await response.json().catch(() => undefined)
      : await response.text().catch(() => undefined);

  if (!response.ok) {
    const error = record(body);
    const nestedError = record(error.error);
    const message = text(error.message ?? nestedError.message, `The request failed (${response.status}).`);
    const code = optionalText(error.code ?? nestedError.code);
    throw new ApiError(message, response.status, code);
  }

  return body;
}

export const api = {
  async getRuntimeStatus(): Promise<RuntimeStatusDto> {
    return normalizeRuntimeStatus(await request("/v1/runtime-status"));
  },

  async listProducts(): Promise<ProductDto[]> {
    const body = await request("/v1/products");
    const products = envelope(body, ["products"]);
    return Array.isArray(products) ? products.map(normalizeProduct).filter((product) => product.id.length > 0) : [];
  },

  async createCart(): Promise<CartDto> {
    return normalizeCart(await request("/v1/carts", { method: "POST" }));
  },

  async getCart(cartId: string): Promise<CartDto> {
    return normalizeCart(await request(`/v1/carts/${encodeURIComponent(cartId)}`));
  },

  async addCartLine(cartId: string, productId: string, quantity = 1): Promise<CartDto> {
    return normalizeCart(await request(`/v1/carts/${encodeURIComponent(cartId)}/lines`, {
      method: "POST",
      body: JSON.stringify({ productId, quantity })
    }));
  },

  async removeCartLine(cartId: string, lineId: string): Promise<CartDto> {
    const body = await request(`/v1/carts/${encodeURIComponent(cartId)}/lines/${encodeURIComponent(lineId)}`, {
      method: "DELETE"
    });
    return body === undefined ? this.getCart(cartId) : normalizeCart(body);
  },

  async checkoutCart(cartId: string, idempotencyKey: string): Promise<OrderDto> {
    return normalizeOrder(await request(`/v1/carts/${encodeURIComponent(cartId)}/checkout`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey }
    }));
  },

  async listOrders(options: {
    search?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<OrderDto[]> {
    const query = new URLSearchParams();
    if (options.search?.trim()) query.set("search", options.search.trim());
    if (options.status) query.set("status", options.status);
    query.set("limit", String(options.limit ?? 50));
    query.set("offset", String(options.offset ?? 0));
    const body = await request(`/v1/orders?${query.toString()}`);
    const orders = envelope(body, ["orders"]);
    return Array.isArray(orders) ? orders.map(normalizeOrder) : [];
  },

  async getSaleDetail(orderId: string): Promise<SaleDetailDto> {
    return normalizeSaleDetail(
      await request(`/v1/orders/${encodeURIComponent(orderId)}/sale`)
    );
  },

  async createPaymentAttempt(
    orderId: string,
    tender: Tender,
    idempotencyKey: string,
    terminalId?: string
  ): Promise<PaymentAttemptDto> {
    const body = tender === "card" && terminalId ? { tender, terminalId } : { tender };
    return normalizePayment(await request(`/v1/orders/${encodeURIComponent(orderId)}/payment-attempts`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body)
    }));
  },

  async completeSandboxVietnamQr(
    attemptId: string,
    wallet: VietnamQrWallet,
    outcome: SandboxQrOutcome,
    options: { delayMs?: number; duplicate?: boolean } = {}
  ): Promise<PaymentAttemptDto> {
    return normalizePayment(await request(`/v1/sandbox/vietnam-qr/${encodeURIComponent(attemptId)}/complete`, {
      method: "POST",
      body: JSON.stringify({ wallet, outcome, ...options })
    }));
  },

  async scanSandboxVietnamQr(
    attemptId: string,
    wallet: VietnamQrWallet
  ): Promise<PaymentAttemptDto> {
    return normalizePayment(await request(`/v1/sandbox/vietnam-qr/${encodeURIComponent(attemptId)}/scan`, {
      method: "POST",
      body: JSON.stringify({ wallet })
    }));
  },

  async getPaymentAttempt(attemptId: string): Promise<PaymentAttemptDto> {
    return normalizePayment(await request(`/v1/payment-attempts/${encodeURIComponent(attemptId)}?refresh=true`));
  },

  async getReceipt(orderId: string): Promise<ReceiptDto> {
    return normalizeReceipt(await request(`/v1/orders/${encodeURIComponent(orderId)}/receipt`));
  },

  async refundPayment(
    paymentId: string,
    amountMinor: AmountMinor,
    reason: string,
    managerId: string,
    managerKey: string,
    idempotencyKey: string
  ): Promise<RefundDto> {
    return normalizeRefund(await request(`/v1/payments/${encodeURIComponent(paymentId)}/refunds`, {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "X-Manager-Id": managerId,
        "X-Manager-Key": managerKey
      },
      body: JSON.stringify({ amountMinor, reason })
    }));
  }
};

function isVietnamQrWallet(value: string): value is VietnamQrWallet {
  return value === "VCB" || value === "MOMO" || value === "ZALOPAY" || value === "SHOPEEPAY_VN";
}

function isPaymentTimelineEventType(value: string): value is PaymentTimelineEventType {
  return value === "QR_CREATED"
    || value === "CUSTOMER_OPENED"
    || value === "CUSTOMER_APPROVED"
    || value === "PROVIDER_CONFIRMED"
    || value === "SETTLED"
    || value === "REFUNDED"
    || value === "CALLBACK_SCHEDULED"
    || value === "DUPLICATE_CALLBACK_IGNORED"
    || value === "DECLINED"
    || value === "EXPIRED";
}
