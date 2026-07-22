import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { buildApp } from "../apps/api/src/app.js";
import { runWorkerOnce } from "../apps/worker/src/worker.js";
import { SimulatedPaymentProvider } from "@pos/payments-simulated";
import { createRepository } from "@pos/persistence";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const repository = createRepository({ databaseUrl });
const provider = new SimulatedPaymentProvider({ webhookSecret: "postgres-smoke-secret" });
const app = await buildApp({
  logger: process.env.SMOKE_DEBUG === "true",
  repository,
  paymentProvider: provider,
  config: {
    host: "127.0.0.1",
    port: 3000,
    databaseUrl,
    simulatedWebhookSecret: "postgres-smoke-secret",
    managerApiKey: "postgres-smoke-manager",
    corsOrigins: [],
    authEnabled: false,
    rateLimitEnabled: false
  }
});

interface MerchantSettingsPayload {
  merchantName: string;
  locationName: string;
  registerName: string;
  currency: string;
  receiptHeader: string;
  receiptFooter: string;
  showSkuOnReceipt: boolean;
  discountsEnabled: boolean;
  tipsEnabled: boolean;
}

let originalMerchantSettings: MerchantSettingsPayload | undefined;

try {
  const originalMerchantResponse = await app.inject({ method: "GET", url: "/v1/merchant-settings" });
  assert.equal(originalMerchantResponse.statusCode, 200, originalMerchantResponse.body);
  originalMerchantSettings = originalMerchantResponse.json<MerchantSettingsPayload>();
  const merchantResponse = await app.inject({
    method: "PUT",
    url: "/v1/merchant-settings",
    payload: {
      merchantName: "Open POS PostgreSQL Demo",
      locationName: "Downtown",
      registerName: "Register 01",
      currency: "USD",
      receiptHeader: "Durable sandbox demonstration",
      receiptFooter: "Thank you for testing Open POS.",
      showSkuOnReceipt: true,
      discountsEnabled: true,
      tipsEnabled: true
    }
  });
  assert.equal(merchantResponse.statusCode, 200, merchantResponse.body);
  const productsResponse = await app.inject({ method: "GET", url: "/v1/products" });
  assert.equal(productsResponse.statusCode, 200, productsResponse.body);
  const products = productsResponse.json<{ products: Array<{ id: string }> }>().products;
  assert.ok(products.length > 0, "seeded products should be available");
  const sharedPaymentKey = `payment-${randomUUID()}`;

  const cartResponse = await app.inject({ method: "POST", url: "/v1/carts", payload: {} });
  assert.equal(cartResponse.statusCode, 201);
  const cartId = cartResponse.json<{ id: string }>().id;
  assert.ok(await repository.getCart(cartId, "shared"));
  assert.equal(await repository.getCart(cartId, "guest:another-session"), undefined);

  const lineResponse = await app.inject({
    method: "POST",
    url: `/v1/carts/${cartId}/lines`,
    payload: { productId: products[0]!.id, quantity: 1 }
  });
  assert.equal(lineResponse.statusCode, 201);
  const lineId = lineResponse.json<{ lines: Array<{ id: string }> }>().lines[0]!.id;
  const discountResponse = await app.inject({
    method: "PUT",
    url: `/v1/carts/${cartId}/lines/${encodeURIComponent(lineId)}/discount`,
    payload: { amountMinor: "10" }
  });
  assert.equal(discountResponse.statusCode, 200, discountResponse.body);
  const tipResponse = await app.inject({
    method: "PUT",
    url: `/v1/carts/${cartId}/tip`,
    payload: { amountMinor: "15" }
  });
  assert.equal(tipResponse.statusCode, 200, tipResponse.body);

  const checkoutResponse = await app.inject({
    method: "POST",
    url: `/v1/carts/${cartId}/checkout`,
    headers: { "idempotency-key": `checkout-${randomUUID()}` }
  });
  assert.equal(checkoutResponse.statusCode, 201);
  const orderId = checkoutResponse.json<{ id: string }>().id;
  assert.ok(await repository.getOrder(orderId, "shared"));
  assert.equal(await repository.getOrder(orderId, "guest:another-session"), undefined);

  const paymentResponse = await app.inject({
    method: "POST",
    url: `/v1/orders/${orderId}/payment-attempts`,
    headers: { "idempotency-key": sharedPaymentKey },
    payload: { tender: "cash" }
  });
  assert.equal(paymentResponse.statusCode, 201);
  assert.equal(paymentResponse.json<{ status: string }>().status, "CAPTURED");

  const orderHistoryResponse = await app.inject({
    method: "GET",
    url: `/v1/orders?status=PAID&search=${encodeURIComponent(orderId.slice(0, 8))}`
  });
  assert.equal(orderHistoryResponse.statusCode, 200, orderHistoryResponse.body);
  assert.ok(orderHistoryResponse.json<{
    orders: Array<{
      id: string;
      payment: { tender: string };
      refundStatus: string;
      refundedMinor: string;
    }>;
  }>().orders.some((order) => order.id === orderId
    && order.payment.tender === "cash"
    && order.refundStatus === "NONE"
    && order.refundedMinor === "0"),
  "captured order summary should persist its tender and refund totals");

  const receiptResponse = await app.inject({
    method: "GET",
    url: `/v1/orders/${orderId}/receipt`
  });
  assert.equal(receiptResponse.statusCode, 200);
  assert.equal(receiptResponse.json<{ paymentStatus: string }>().paymentStatus, "CAPTURED");
  assert.equal(receiptResponse.json<{ discountMinor: string }>().discountMinor, "10");
  assert.equal(receiptResponse.json<{ tipMinor: string }>().tipMinor, "15");
  assert.equal(
    receiptResponse.json<{ merchant: { merchantName: string } }>().merchant.merchantName,
    "Open POS PostgreSQL Demo"
  );

  // A second cart with the same product protects against globally-colliding
  // cart/order line identifiers in the normalized PostgreSQL tables.
  const secondCartId = (await app.inject({ method: "POST", url: "/v1/carts", payload: {} }))
    .json<{ id: string }>().id;
  assert.equal((await app.inject({
    method: "POST",
    url: `/v1/carts/${secondCartId}/lines`,
    payload: { productId: products[0]!.id, quantity: 1 }
  })).statusCode, 201);
  const secondOrderId = (await app.inject({
    method: "POST",
    url: `/v1/carts/${secondCartId}/checkout`,
    headers: { "idempotency-key": `checkout-${randomUUID()}` }
  })).json<{ id: string }>().id;
  const cardPaymentResponse = await app.inject({
    method: "POST",
    url: `/v1/orders/${secondOrderId}/payment-attempts`,
    // Client keys are scoped to an order; migration 002 enforces the same
    // boundary in PostgreSQL rather than treating keys as globally unique.
    headers: { "idempotency-key": sharedPaymentKey },
    payload: { tender: "card", terminalId: "postgres-smoke-reader" }
  });
  assert.equal(cardPaymentResponse.statusCode, 201, cardPaymentResponse.body);
  const cardPayment = cardPaymentResponse.json<{
    paymentId: string;
    amountMinor: string;
    status: string;
  }>();
  assert.equal(cardPayment.status, "CAPTURED");
  const refundResponse = await app.inject({
    method: "POST",
    url: `/v1/payments/${cardPayment.paymentId}/refunds`,
    headers: {
      "idempotency-key": `refund-${randomUUID()}`,
      "x-manager-id": "postgres-smoke-manager",
      "x-manager-key": "postgres-smoke-manager"
    },
    payload: { amountMinor: cardPayment.amountMinor, reason: "PostgreSQL smoke refund" }
  });
  assert.equal(refundResponse.statusCode, 201, refundResponse.body);
  const refundedSaleResponse = await app.inject({
    method: "GET",
    url: `/v1/orders/${secondOrderId}/sale`
  });
  assert.equal(refundedSaleResponse.statusCode, 200, refundedSaleResponse.body);
  assert.equal(
    refundedSaleResponse.json<{ order: { status: string }; refunds: unknown[] }>().order.status,
    "REFUNDED"
  );
  assert.equal(
    refundedSaleResponse.json<{ order: { status: string }; refunds: unknown[] }>().refunds.length,
    1
  );
  const refundedReceiptResponse = await app.inject({
    method: "GET",
    url: `/v1/orders/${secondOrderId}/receipt`
  });
  assert.equal(refundedReceiptResponse.statusCode, 200, refundedReceiptResponse.body);
  assert.equal(refundedReceiptResponse.json<{ refundStatus: string }>().refundStatus, "FULL");

  const qrCartId = (await app.inject({ method: "POST", url: "/v1/carts", payload: {} }))
    .json<{ id: string }>().id;
  assert.equal((await app.inject({
    method: "POST",
    url: `/v1/carts/${qrCartId}/lines`,
    payload: { productId: products[0]!.id, quantity: 1 }
  })).statusCode, 201);
  const qrOrderId = (await app.inject({
    method: "POST",
    url: `/v1/carts/${qrCartId}/checkout`,
    headers: { "idempotency-key": `checkout-${randomUUID()}` }
  })).json<{ id: string }>().id;
  const qrStarted = await app.inject({
    method: "POST",
    url: `/v1/orders/${qrOrderId}/payment-attempts`,
    headers: { "idempotency-key": `payment-${randomUUID()}` },
    payload: { tender: "vietnam_qr" }
  });
  assert.equal(qrStarted.statusCode, 201, qrStarted.body);
  const qrAttemptId = qrStarted.json<{ id: string }>().id;
  assert.equal((await app.inject({
    method: "POST",
    url: `/v1/sandbox/vietnam-qr/${qrAttemptId}/scan`,
    payload: { wallet: "MOMO" }
  })).statusCode, 200);
  const qrCaptured = await app.inject({
    method: "POST",
    url: `/v1/sandbox/vietnam-qr/${qrAttemptId}/complete`,
    payload: { wallet: "MOMO", outcome: "APPROVED", duplicate: true }
  });
  assert.equal(qrCaptured.statusCode, 200, qrCaptured.body);
  const persistedQrAttempt = await repository.getPaymentAttempt(qrAttemptId);
  assert.equal(persistedQrAttempt?.vietnamQr?.selectedWallet, "MOMO");
  assert.equal(persistedQrAttempt?.vietnamQr?.quote.exchangeRate, "25500");
  assert.equal(persistedQrAttempt?.vietnamQr?.quote.settlementFeeBps, 250);
  assert.ok(
    persistedQrAttempt?.vietnamQr?.timeline.some(
      (event) => event.type === "DUPLICATE_CALLBACK_IGNORED"
    ),
    "PostgreSQL snapshot should persist the Vietnam QR timeline"
  );
  const qrReceipt = await app.inject({ method: "GET", url: `/v1/orders/${qrOrderId}/receipt` });
  assert.equal(qrReceipt.statusCode, 200, qrReceipt.body);
  assert.equal(qrReceipt.json<{ vietnamQr: { selectedWallet: string } }>().vietnamQr.selectedWallet, "MOMO");

  const webhookPayload = {
    id: `postgres-webhook-${randomUUID()}`,
    type: "payment.updated",
    occurredAt: new Date().toISOString(),
    data: {}
  };
  const webhookRequest = {
    method: "POST" as const,
    url: "/v1/providers/simulated/webhooks",
    headers: { "x-simulated-signature": "postgres-smoke-secret" },
    payload: webhookPayload
  };
  assert.equal(
    (await app.inject(webhookRequest)).json<{ replayed: boolean }>().replayed,
    false,
    "first PostgreSQL webhook delivery should be claimed"
  );
  assert.equal(
    (await app.inject(webhookRequest)).json<{ replayed: boolean }>().replayed,
    true,
    "duplicate PostgreSQL webhook delivery should be ignored"
  );

  const worker = await runWorkerOnce({
    repository,
    provider,
    publish: async () => undefined
  });
  assert.equal(worker.unmatchedSettlementItems.length, 0);
  assert.equal(worker.settlementLines, 2);
  const reconciliation = await repository.reconciliationSummary({
    from: new Date(Date.now() - 60_000),
    to: new Date(Date.now() + 60_000),
    currency: "USD",
    provider: provider.name
  });
  assert.equal(reconciliation.unreconciledPaymentIds.length, 0);
  assert.equal(reconciliation.unreconciledRefundIds.length, 0);

  console.info(JSON.stringify({
    status: "ok",
    persistence: "postgres",
    productCount: products.length,
    orderId,
    secondOrderId,
    qrOrderId,
    settlementLines: worker.settlementLines
  }));
} finally {
  if (originalMerchantSettings) {
    const restored = await app.inject({
      method: "PUT",
      url: "/v1/merchant-settings",
      payload: {
        merchantName: originalMerchantSettings.merchantName,
        locationName: originalMerchantSettings.locationName,
        registerName: originalMerchantSettings.registerName,
        currency: originalMerchantSettings.currency,
        receiptHeader: originalMerchantSettings.receiptHeader,
        receiptFooter: originalMerchantSettings.receiptFooter,
        showSkuOnReceipt: originalMerchantSettings.showSkuOnReceipt,
        discountsEnabled: originalMerchantSettings.discountsEnabled,
        tipsEnabled: originalMerchantSettings.tipsEnabled
      }
    });
    assert.equal(restored.statusCode, 200, restored.body);
  }
  await app.close();
}
