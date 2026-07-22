import type {
  AuditEntry,
  Cart,
  MerchantSettings,
  Order,
  Payment,
  PaymentAttempt,
  Product,
  Refund,
  VietnamQrDetailsSnapshot
} from "@pos/domain";
import type { PaymentPresentation, WalletPaymentSummary } from "@pos/payment-contract";

function amount(value: { readonly minorUnits: bigint }): string {
  return value.minorUnits.toString();
}

export function auditEntryDto(entry: AuditEntry): Record<string, unknown> {
  return {
    id: entry.id,
    aggregateType: entry.aggregateType,
    aggregateId: entry.aggregateId,
    action: entry.action,
    actorId: entry.actorId,
    metadata: entry.metadata,
    occurredAt: entry.occurredAt.toISOString()
  };
}

export function productDto(product: Product): Record<string, unknown> {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    category: product.category,
    barcode: product.barcode,
    priceMinor: amount(product.unitPrice),
    currency: product.unitPrice.currency,
    taxRateBps: product.taxRateBps,
    active: product.active,
    available: product.active
  };
}

export function cartDto(cart: Cart): Record<string, unknown> {
  return {
    id: cart.id,
    status: cart.status,
    currency: cart.currency,
    lines: cart.lines.map((line) => ({
      id: line.id,
      lineId: line.id,
      productId: line.productId,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitPriceMinor: amount(line.unitPrice),
      discountMinor: amount(line.discount),
      subtotalMinor: amount(line.subtotal),
      taxMinor: amount(line.tax),
      lineTotalMinor: amount(line.total)
    })),
    subtotalMinor: amount(cart.subtotal),
    discountMinor: amount(cart.discountTotal),
    taxMinor: amount(cart.taxTotal),
    tipMinor: amount(cart.tip),
    totalMinor: amount(cart.total),
    createdAt: cart.createdAt.toISOString(),
    updatedAt: cart.updatedAt.toISOString()
  };
}

export function orderDto(order: Order): Record<string, unknown> {
  return {
    id: order.id,
    number: order.id.slice(0, 8).toUpperCase(),
    orderNumber: order.id.slice(0, 8).toUpperCase(),
    cartId: order.cartId,
    status: order.status,
    currency: order.currency,
    lines: order.lines.map((line) => ({
      id: line.lineId,
      lineId: line.lineId,
      productId: line.productId,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitPriceMinor: amount(line.unitPrice),
      discountMinor: amount(line.discount),
      subtotalMinor: amount(line.subtotal),
      taxMinor: amount(line.tax),
      lineTotalMinor: amount(line.total)
    })),
    subtotalMinor: amount(order.subtotal),
    discountMinor: amount(order.discountTotal),
    taxMinor: amount(order.taxTotal),
    tipMinor: amount(order.tipTotal),
    totalMinor: amount(order.total),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    version: order.version
  };
}

export function paymentAttemptDto(
  attempt: PaymentAttempt,
  payment?: Payment,
  presentation?: PaymentPresentation,
  wallet?: WalletPaymentSummary
): Record<string, unknown> {
  const card = payment?.card;
  const isVietnamQr = attempt.provider === "simulated-vietnam-qr";
  const persistedVietnamQr = attempt.vietnamQr;
  const selectedWallet = wallet ?? (persistedVietnamQr?.selectedWallet
    ? {
        wallet: persistedVietnamQr.selectedWallet,
        payerCurrency: persistedVietnamQr.quote.payerCurrency,
        payerAmountMinor: persistedVietnamQr.quote.payerAmountMinor,
        exchangeRate: persistedVietnamQr.quote.exchangeRate,
        settlementFeeBps: persistedVietnamQr.quote.settlementFeeBps,
        settlementFeeMinor: persistedVietnamQr.quote.settlementFeeMinor,
        merchantNetMinor: persistedVietnamQr.quote.merchantNetMinor
      }
    : undefined);
  return {
    id: attempt.id,
    orderId: attempt.orderId,
    provider: attempt.provider,
    providerReference: attempt.providerReference,
    status: attempt.status,
    tender: payment?.provider === "cash" || attempt.provider === "cash"
      ? "cash"
      : isVietnamQr
        ? "vietnam_qr"
        : "card",
    amountMinor: amount(attempt.amount),
    currency: attempt.amount.currency,
    terminalId: attempt.terminalId,
    failureCode: attempt.failureCode,
    failureMessage: attempt.status === "DECLINED"
      ? "Payment was declined. No charge was completed."
      : attempt.failureCode,
    ...(card
      ? {
          cardBrand: card.brand,
          last4: card.last4,
          entryMethod: card.entryMethod
        }
      : {}),
    ...(presentation
      ? {
          presentation: {
            ...presentation,
            expiresAt: presentation.expiresAt.toISOString(),
            quote: quoteDto(presentation.quote)
          }
        }
      : {}),
    ...(selectedWallet ? { wallet: selectedWallet } : {}),
    ...(persistedVietnamQr ? { vietnamQr: vietnamQrDto(persistedVietnamQr) } : {}),
    paymentId: payment?.id,
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: attempt.updatedAt.toISOString()
  };
}

export function paymentDto(
  payment: Payment,
  attempt?: PaymentAttempt
): Record<string, unknown> {
  const isVietnamQr = payment.provider === "simulated-vietnam-qr";
  const vietnamQr = isVietnamQr ? attempt?.vietnamQr ?? undefined : undefined;
  const wallet = vietnamQr?.selectedWallet;
  return {
    id: payment.id,
    orderId: payment.orderId,
    paymentAttemptId: payment.paymentAttemptId,
    provider: payment.provider,
    providerReference: payment.providerReference,
    status: "CAPTURED",
    tender: payment.provider === "cash" ? "cash" : isVietnamQr ? "vietnam_qr" : "card",
    amountMinor: amount(payment.amount),
    currency: payment.amount.currency,
    cardBrand: payment.card?.brand,
    last4: payment.card?.last4,
    entryMethod: payment.card?.entryMethod,
    ...(wallet
      ? {
          wallet: {
            wallet,
            payerCurrency: vietnamQr.quote.payerCurrency,
            payerAmountMinor: vietnamQr.quote.payerAmountMinor,
            exchangeRate: vietnamQr.quote.exchangeRate,
            settlementFeeBps: vietnamQr.quote.settlementFeeBps,
            settlementFeeMinor: vietnamQr.quote.settlementFeeMinor,
            merchantNetMinor: vietnamQr.quote.merchantNetMinor
          }
        }
      : {}),
    ...(vietnamQr ? { vietnamQr: vietnamQrDto(vietnamQr) } : {}),
    capturedAt: payment.capturedAt.toISOString()
  };
}

export function refundDto(refund: Refund): Record<string, unknown> {
  return {
    id: refund.id,
    paymentId: refund.paymentId,
    provider: refund.provider,
    providerReference: refund.providerReference,
    status: refund.status,
    amountMinor: amount(refund.amount),
    currency: refund.amount.currency,
    failureCode: refund.failureCode,
    createdAt: refund.createdAt.toISOString(),
    updatedAt: refund.updatedAt.toISOString()
  };
}

export function receiptDto(
  order: Order,
  payment?: Payment,
  refunds: readonly Refund[] = [],
  attempt?: PaymentAttempt,
  settings?: MerchantSettings
): Record<string, unknown> {
  const dto = orderDto(order);
  const succeededRefunds = refunds.filter((refund) => refund.status === "SUCCEEDED");
  const refundedMinor = succeededRefunds.reduce(
    (sum, refund) => sum + refund.amount.minorUnits,
    0n
  );
  const remainingMinor = order.total.minorUnits > refundedMinor
    ? order.total.minorUnits - refundedMinor
    : 0n;
  const refundStatus = refunds.some((refund) => refund.status === "PENDING")
    ? "PENDING"
    : refundedMinor === 0n
      ? "NONE"
      : remainingMinor === 0n
        ? "FULL"
        : "PARTIAL";
  const vietnamQr = payment?.provider === "simulated-vietnam-qr"
    ? attempt?.vietnamQr ?? undefined
    : undefined;
  const wallet = vietnamQr?.selectedWallet;
  return {
    ...dto,
    merchant: settings ? merchantSettingsDto(settings) : undefined,
    orderId: order.id,
    createdAt: payment?.capturedAt.toISOString() ?? new Date().toISOString(),
    issuedAt: payment?.capturedAt.toISOString() ?? new Date().toISOString(),
    tender: payment?.provider === "cash"
      ? "cash"
      : payment?.provider === "simulated-vietnam-qr"
        ? "vietnam_qr"
        : payment
          ? "card"
          : undefined,
    paymentStatus: refundStatus === "FULL"
      ? "REFUNDED"
      : refundStatus === "PARTIAL"
        ? "PARTIALLY_REFUNDED"
        : payment
          ? "CAPTURED"
          : "UNPAID",
    refundStatus,
    refundedMinor: refundedMinor.toString(),
    remainingMinor: remainingMinor.toString(),
    refunds: refunds.map(refundDto),
    payment: payment ? paymentDto(payment, attempt) : undefined,
    cardBrand: payment?.card?.brand,
    last4: payment?.card?.last4,
    ...(wallet ? { wallet } : {}),
    ...(vietnamQr ? { vietnamQr: vietnamQrDto(vietnamQr) } : {})
  };
}

export function orderSummaryDto(
  order: Order,
  payment?: Payment,
  refunds: readonly Refund[] = [],
  attempt?: PaymentAttempt
): Record<string, unknown> {
  const receipt = receiptDto(order, payment, refunds, attempt);
  return {
    ...orderDto(order),
    payment: receipt.payment,
    paymentStatus: receipt.paymentStatus,
    refundStatus: receipt.refundStatus,
    refundedMinor: receipt.refundedMinor,
    remainingMinor: receipt.remainingMinor
  };
}

export function merchantSettingsDto(settings: MerchantSettings): Record<string, unknown> {
  return {
    id: settings.id,
    merchantName: settings.merchantName,
    locationName: settings.locationName,
    registerName: settings.registerName,
    currency: settings.currency,
    receiptHeader: settings.receiptHeader,
    receiptFooter: settings.receiptFooter,
    showSkuOnReceipt: settings.showSkuOnReceipt,
    discountsEnabled: settings.discountsEnabled,
    tipsEnabled: settings.tipsEnabled,
    version: settings.version,
    updatedAt: settings.updatedAt.toISOString()
  };
}

function vietnamQrDto(value: VietnamQrDetailsSnapshot): Record<string, unknown> {
  return {
    quote: quoteDto(value.quote),
    selectedWallet: value.selectedWallet,
    timeline: value.timeline.map((event) => ({
      id: event.id,
      type: event.type,
      description: event.description,
      occurredAt: event.occurredAt.toISOString()
    }))
  };
}

function quoteDto(value: VietnamQrDetailsSnapshot["quote"]): Record<string, unknown> {
  return {
    payerCurrency: value.payerCurrency,
    payerAmountMinor: value.payerAmountMinor,
    exchangeRate: value.exchangeRate,
    settlementFeeBps: value.settlementFeeBps,
    settlementFeeMinor: value.settlementFeeMinor,
    merchantNetMinor: value.merchantNetMinor,
    expiresAt: value.expiresAt.toISOString()
  };
}
