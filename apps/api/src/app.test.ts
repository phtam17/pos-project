import { afterEach, describe, expect, it } from "vitest";
import { PaymentProviderError, type StartSaleRequest } from "@pos/payment-contract";
import { SimulatedPaymentProvider } from "@pos/payments-simulated";

import { buildApp } from "./app.js";
import type { ApiConfig } from "./config.js";

const config: ApiConfig = {
  host: "127.0.0.1",
  port: 3000,
  simulatedWebhookSecret: "test-webhook-secret",
  corsOrigins: []
};

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function app(paymentProvider?: SimulatedPaymentProvider) {
  const instance = await buildApp({
    config,
    logger: false,
    ...(paymentProvider ? { paymentProvider } : {})
  });
  openApps.push(instance);
  return instance;
}

describe("POS API vertical slice", () => {
  it("creates a cart, checks out, captures a simulated card, and returns a receipt", async () => {
    const instance = await app();

    const productsResponse = await instance.inject({ method: "GET", url: "/v1/products" });
    expect(productsResponse.statusCode).toBe(200);
    const products = productsResponse.json<{ products: Array<{ id: string }> }>().products;
    expect(products.length).toBeGreaterThan(0);

    const cartResponse = await instance.inject({ method: "POST", url: "/v1/carts", payload: {} });
    const cartId = cartResponse.json<{ id: string }>().id;
    expect(cartResponse.statusCode).toBe(201);

    const lineResponse = await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/lines`,
      payload: { productId: products[0]!.id, quantity: 2 }
    });
    expect(lineResponse.statusCode).toBe(201);
    expect(lineResponse.json<{ lines: unknown[] }>().lines).toHaveLength(1);

    const checkoutResponse = await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/checkout`,
      headers: { "idempotency-key": "checkout-test-0001" }
    });
    expect(checkoutResponse.statusCode).toBe(201);
    const orderId = checkoutResponse.json<{ id: string }>().id;
    const checkoutReplay = await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/checkout`,
      headers: { "idempotency-key": "checkout-test-0001" }
    });
    expect(checkoutReplay.json<{ id: string }>().id).toBe(orderId);

    const paymentResponse = await instance.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "sale-test-0001" },
      payload: { tender: "card", terminalId: "simulated-reader-1" }
    });
    expect(paymentResponse.statusCode).toBe(201);
    const payment = paymentResponse.json<{
      status: string;
      paymentId: string;
      last4: string;
    }>();
    expect(payment.status).toBe("CAPTURED");
    expect(payment.paymentId).toBeTruthy();
    expect(payment.last4).toBe("4242");

    const receiptResponse = await instance.inject({
      method: "GET",
      url: `/v1/orders/${orderId}/receipt`
    });
    expect(receiptResponse.statusCode).toBe(200);
    const receipt = receiptResponse.json<{ paymentStatus: string; cardBrand: string }>();
    expect(receipt.paymentStatus).toBe("CAPTURED");
    expect(receipt.cardBrand).toBe("VISA");
  });

  it("resolves an UNKNOWN attempt by replaying the original idempotent request", async () => {
    const instance = await app();
    const productResponse = await instance.inject({
      method: "POST",
      url: "/v1/products",
      payload: {
        sku: "UNKNOWN-TEST",
        name: "Unknown outcome test",
        priceMinor: "102",
        currency: "USD",
        taxRateBps: 0
      }
    });
    const productId = productResponse.json<{ id: string }>().id;
    const cartId = (await instance.inject({ method: "POST", url: "/v1/carts", payload: {} }))
      .json<{ id: string }>().id;
    await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/lines`,
      payload: { productId, quantity: 1 }
    });
    const orderId = (await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/checkout`,
      headers: { "idempotency-key": "checkout-unknown-0001" }
    })).json<{ id: string }>().id;
    const request = {
      method: "POST" as const,
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "unknown-test-0001" },
      payload: { tender: "card", terminalId: "simulated-reader-1" }
    };

    const first = await instance.inject(request);
    expect(first.statusCode).toBe(201);
    expect(first.json<{ status: string }>().status).toBe("UNKNOWN");

    const replay = await instance.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json<{ status: string }>().status).toBe("CAPTURED");
  });

  it("rejects reuse of an idempotency key with different payment input", async () => {
    const instance = await app();
    const productId = (await instance.inject({ method: "GET", url: "/v1/products" }))
      .json<{ products: Array<{ id: string }> }>().products[0]!.id;
    const cartId = (await instance.inject({ method: "POST", url: "/v1/carts", payload: {} }))
      .json<{ id: string }>().id;
    await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/lines`,
      payload: { productId, quantity: 1 }
    });
    const orderId = (await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/checkout`,
      headers: { "idempotency-key": "checkout-conflict-0001" }
    })).json<{ id: string }>().id;

    await instance.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "conflict-test-001" },
      payload: { tender: "card", terminalId: "reader-one" }
    });
    const conflict = await instance.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "conflict-test-001" },
      payload: { tender: "card", terminalId: "reader-two" }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rejects raw card-like fields at the HTTP boundary", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST",
      url: "/v1/orders/not-an-order/payment-attempts",
      headers: { "idempotency-key": "sensitive-test-01" },
      payload: {
        tender: "card",
        terminalId: "simulated-reader-1",
        cardNumber: "4242424242424242"
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("INVALID_REQUEST");
  });

  it("returns 400 for malformed JSON without echoing the request body", async () => {
    const instance = await app();
    const response = await instance.inject({
      method: "POST",
      url: "/v1/carts",
      headers: { "content-type": "application/json" },
      payload: "{"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string; message: string } }>().error).toEqual({
      code: "INVALID_JSON",
      message: "Request body is not valid JSON"
    });
  });

  it("atomically claims concurrent checkout idempotency keys", async () => {
    const instance = await app();
    const productId = (await instance.inject({ method: "GET", url: "/v1/products" }))
      .json<{ products: Array<{ id: string }> }>().products[0]!.id;
    const cartId = (await instance.inject({ method: "POST", url: "/v1/carts", payload: {} }))
      .json<{ id: string }>().id;
    await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/lines`,
      payload: { productId, quantity: 1 }
    });
    const checkout = {
      method: "POST" as const,
      url: `/v1/carts/${cartId}/checkout`,
      headers: { "idempotency-key": "checkout-concurrent-0001" }
    };

    const concurrent = await Promise.all([
      instance.inject(checkout),
      instance.inject(checkout)
    ]);
    expect(concurrent.every((response) => [201, 409].includes(response.statusCode))).toBe(true);
    const successfulIds = concurrent
      .filter((response) => response.statusCode === 201)
      .map((response) => response.json<{ id: string }>().id);
    expect(new Set(successfulIds).size).toBeLessThanOrEqual(1);

    const replay = await instance.inject(checkout);
    expect(replay.statusCode).toBe(201);
    expect(successfulIds).toContain(replay.json<{ id: string }>().id);
  });

  it("recovers a capture when the provider accepted it but the first response was lost", async () => {
    class LostResponseProvider extends SimulatedPaymentProvider {
      private loseNextResponse = true;

      override async startSale(input: StartSaleRequest) {
        const result = await super.startSale(input);
        if (this.loseNextResponse) {
          this.loseNextResponse = false;
          throw new PaymentProviderError(
            "PROVIDER_UNAVAILABLE",
            "Simulated response was lost after provider acceptance",
            true
          );
        }
        return result;
      }
    }

    const instance = await app(new LostResponseProvider());
    const productId = (await instance.inject({ method: "GET", url: "/v1/products" }))
      .json<{ products: Array<{ id: string }> }>().products[0]!.id;
    const cartId = (await instance.inject({ method: "POST", url: "/v1/carts", payload: {} }))
      .json<{ id: string }>().id;
    await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/lines`,
      payload: { productId, quantity: 1 }
    });
    const orderId = (await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/checkout`,
      headers: { "idempotency-key": "checkout-lost-response" }
    })).json<{ id: string }>().id;
    const paymentRequest = {
      method: "POST" as const,
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "payment-lost-response" },
      payload: { tender: "card", terminalId: "simulated-reader-1" }
    };

    const lostResponse = await instance.inject(paymentRequest);
    expect(lostResponse.statusCode).toBe(503);
    const recovered = await instance.inject(paymentRequest);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json<{ status: string }>().status).toBe("CAPTURED");
  });
});
