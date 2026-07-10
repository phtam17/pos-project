import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { buildApp } from "../apps/api/src/app.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const app = await buildApp({
  logger: process.env.SMOKE_DEBUG === "true",
  config: {
    host: "127.0.0.1",
    port: 3000,
    databaseUrl,
    simulatedWebhookSecret: "postgres-smoke-secret",
    corsOrigins: []
  }
});

try {
  const productsResponse = await app.inject({ method: "GET", url: "/v1/products" });
  assert.equal(productsResponse.statusCode, 200, productsResponse.body);
  const products = productsResponse.json<{ products: Array<{ id: string }> }>().products;
  assert.ok(products.length > 0, "seeded products should be available");

  const cartResponse = await app.inject({ method: "POST", url: "/v1/carts", payload: {} });
  assert.equal(cartResponse.statusCode, 201);
  const cartId = cartResponse.json<{ id: string }>().id;

  const lineResponse = await app.inject({
    method: "POST",
    url: `/v1/carts/${cartId}/lines`,
    payload: { productId: products[0]!.id, quantity: 1 }
  });
  assert.equal(lineResponse.statusCode, 201);

  const checkoutResponse = await app.inject({
    method: "POST",
    url: `/v1/carts/${cartId}/checkout`,
    headers: { "idempotency-key": `checkout-${randomUUID()}` }
  });
  assert.equal(checkoutResponse.statusCode, 201);
  const orderId = checkoutResponse.json<{ id: string }>().id;

  const paymentResponse = await app.inject({
    method: "POST",
    url: `/v1/orders/${orderId}/payment-attempts`,
    headers: { "idempotency-key": `payment-${randomUUID()}` },
    payload: { tender: "cash" }
  });
  assert.equal(paymentResponse.statusCode, 201);
  assert.equal(paymentResponse.json<{ status: string }>().status, "CAPTURED");

  const receiptResponse = await app.inject({
    method: "GET",
    url: `/v1/orders/${orderId}/receipt`
  });
  assert.equal(receiptResponse.statusCode, 200);
  assert.equal(receiptResponse.json<{ paymentStatus: string }>().paymentStatus, "CAPTURED");

  console.info(JSON.stringify({
    status: "ok",
    persistence: "postgres",
    productCount: products.length,
    orderId
  }));
} finally {
  await app.close();
}
