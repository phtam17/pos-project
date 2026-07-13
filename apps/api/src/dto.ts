import type { Cart, Order, Payment, PaymentAttempt, Product, Refund } from "@pos/domain";
import type { PaymentPresentation, WalletPaymentSummary } from "@pos/payment-contract";

function amount(value: { readonly minorUnits: bigint }): string {
  return value.minorUnits.toString();
}

export function productDto(product: Product): Record<string, unknown> {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    category: "Other",
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
            expiresAt: presentation.expiresAt.toISOString()
          }
        }
      : {}),
    ...(wallet ? { wallet } : {}),
    paymentId: payment?.id,
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: attempt.updatedAt.toISOString()
  };
}

export function paymentDto(payment: Payment): Record<string, unknown> {
  const isVietnamQr = payment.provider === "simulated-vietnam-qr";
  const wallet = isVietnamQr ? walletFromReference(payment.providerReference) : undefined;
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
    ...(wallet ? { wallet: { wallet } } : {}),
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
  refunds: readonly Refund[] = []
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
  const wallet = payment?.provider === "simulated-vietnam-qr"
    ? walletFromReference(payment.providerReference)
    : undefined;
  return {
    ...dto,
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
    payment: payment ? paymentDto(payment) : undefined,
    cardBrand: payment?.card?.brand,
    last4: payment?.card?.last4,
    ...(wallet ? { wallet } : {})
  };
}

function walletFromReference(reference: string): string | undefined {
  const match = /^vnqr_pay_(vcb|momo|zalopay|shopeepay_vn)_/.exec(reference);
  return match?.[1]?.toUpperCase();
}
