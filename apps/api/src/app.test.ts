import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentAttempt } from "@pos/domain";
import {
  PaymentProviderError,
  type PaymentResult,
  type StartSaleRequest
} from "@pos/payment-contract";
import { SimulatedPaymentProvider } from "@pos/payments-simulated";
import { MemoryPosRepository } from "@pos/persistence";

import { buildApp } from "./app.js";
import type { ApiConfig } from "./config.js";

const config: ApiConfig = {
  host: "127.0.0.1",
  port: 3000,
  simulatedWebhookSecret: "test-webhook-secret",
  corsOrigins: [],
  authEnabled: false,
  rateLimitEnabled: false
};

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
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
  it("serves the production register from the API origin with security headers", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "open-pos-static-"));
    temporaryDirectories.push(staticDir);
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Open POS test</title>");
    await mkdir(join(staticDir, "assets"));
    await writeFile(join(staticDir, "assets", "app.js"), "console.log('sandbox')");
    const instance = await buildApp({
      config: {
        ...config,
        publicSandbox: true,
        authEnabled: true,
        authSecret: "public-static-test-auth-secret-long-enough",
        staticDir
      },
      logger: false
    });
    openApps.push(instance);

    const index = await instance.inject({
      method: "GET",
      url: "/orders",
      headers: { accept: "text/html" }
    });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("Open POS test");
    expect(index.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(index.headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(index.headers["x-content-type-options"]).toBe("nosniff");

    const asset = await instance.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const missingApi = await instance.inject({
      method: "GET",
      url: "/v1/does-not-exist",
      headers: { accept: "text/html" }
    });
    expect(missingApi.statusCode).toBe(401);
    expect(missingApi.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  it("lets sandbox memory mode override a configured PostgreSQL URL", async () => {
    const instance = await buildApp({
      config: {
        ...config,
        persistenceMode: "memory",
        databaseUrl: "postgres://unavailable.example.invalid/pos"
      },
      logger: false
    });
    openApps.push(instance);
    const health = await instance.inject({ method: "GET", url: "/health" });
    const products = await instance.inject({ method: "GET", url: "/v1/products" });
    expect(health.json<{ persistence: string }>().persistence).toBe("memory");
    expect(products.statusCode).toBe(200);
  });

  it("separates liveness from persistence readiness", async () => {
    class UnreadyRepository extends MemoryPosRepository {
      override async healthCheck(): Promise<void> {
        throw new Error("database unavailable");
      }
    }
    const instance = await buildApp({
      config,
      logger: false,
      repository: new UnreadyRepository()
    });
    openApps.push(instance);
    expect((await instance.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const ready = await instance.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json<{ error: { code: string } }>().error.code).toBe("NOT_READY");

    const runtime = await instance.inject({ method: "GET", url: "/v1/runtime-status" });
    expect(runtime.statusCode).toBe(200);
    expect(runtime.json<{
      mode: string;
      api: { connected: boolean };
      persistence: { mode: string; ready: boolean; ephemeral: boolean };
      simulators: { card: { ready: boolean }; vietnamQr: { ready: boolean } };
    }>()).toMatchObject({
      mode: "sandbox",
      api: { connected: true },
      persistence: { mode: "memory", ready: false, ephemeral: true },
      simulators: { card: { ready: true }, vietnamQr: { ready: true } }
    });
  });

  it("manages merchant settings and products, then snapshots discounts and tips", async () => {
    const instance = await app();
    const settingsResponse = await instance.inject({
      method: "PUT",
      url: "/v1/merchant-settings",
      payload: {
        merchantName: "Little Saigon Market",
        locationName: "Phoenix",
        registerName: "Register VN-01",
        currency: "USD",
        receiptHeader: "Sandbox demonstration",
        receiptFooter: "Cảm ơn quý khách!",
        showSkuOnReceipt: true,
        discountsEnabled: true,
        tipsEnabled: true
      }
    });
    expect(settingsResponse.statusCode).toBe(200);
    expect(settingsResponse.json<{ version: number }>().version).toBe(2);

    const createdResponse = await instance.inject({
      method: "POST",
      url: "/v1/products",
      payload: {
        sku: "BANH-MI-001",
        name: "Bánh mì đặc biệt",
        category: "Vietnamese food",
        barcode: "893000000001",
        priceMinor: "1000",
        currency: "USD",
        taxRateBps: 1000,
        active: true
      }
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<{ id: string }>();
    const updatedResponse = await instance.inject({
      method: "PUT",
      url: `/v1/products/${created.id}`,
      payload: {
        sku: "BANH-MI-001",
        name: "Bánh mì đặc biệt",
        category: "Vietnamese food",
        barcode: "893000000001",
        priceMinor: "1200",
        currency: "USD",
        taxRateBps: 1000,
        active: true
      }
    });
    expect(updatedResponse.json<{ priceMinor: string; category: string }>()).toMatchObject({
      priceMinor: "1200",
      category: "Vietnamese food"
    });

    const cart = (await instance.inject({ method: "POST", url: "/v1/carts", payload: {} }))
      .json<{ id: string; currency: string }>();
    expect(cart.currency).toBe("USD");
    const withLine = await instance.inject({
      method: "POST",
      url: `/v1/carts/${cart.id}/lines`,
      payload: { productId: created.id, quantity: 1 }
    });
    const lineId = withLine.json<{ lines: Array<{ id: string }> }>().lines[0]!.id;
    const discounted = await instance.inject({
      method: "PUT",
      url: `/v1/carts/${cart.id}/lines/${encodeURIComponent(lineId)}/discount`,
      payload: { amountMinor: "200" }
    });
    expect(discounted.json<{ discountMinor: string; taxMinor: string }>()).toMatchObject({
      discountMinor: "200",
      taxMinor: "100"
    });
    const tipped = await instance.inject({
      method: "PUT",
      url: `/v1/carts/${cart.id}/tip`,
      payload: { amountMinor: "100" }
    });
    expect(tipped.json<{ tipMinor: string; totalMinor: string }>()).toMatchObject({
      tipMinor: "100",
      totalMinor: "1200"
    });
    const order = (await instance.inject({
      method: "POST",
      url: `/v1/carts/${cart.id}/checkout`,
      headers: { "idempotency-key": "merchant-checkout-key" }
    })).json<{ id: string }>();
    await instance.inject({
      method: "POST",
      url: `/v1/orders/${order.id}/payment-attempts`,
      headers: { "idempotency-key": "merchant-payment-key" },
      payload: { tender: "cash" }
    });
    const receipt = await instance.inject({ method: "GET", url: `/v1/orders/${order.id}/receipt` });
    expect(receipt.json<{
      discountMinor: string;
      tipMinor: string;
      totalMinor: string;
      merchant: { merchantName: string; receiptFooter: string };
    }>()).toMatchObject({
      discountMinor: "200",
      tipMinor: "100",
      totalMinor: "1200",
      merchant: { merchantName: "Little Saigon Market", receiptFooter: "Cảm ơn quý khách!" }
    });

    const deactivated = await instance.inject({
      method: "PUT",
      url: `/v1/products/${created.id}`,
      payload: {
        sku: "BANH-MI-001",
        name: "Bánh mì đặc biệt",
        category: "Vietnamese food",
        barcode: "893000000001",
        priceMinor: "1200",
        currency: "USD",
        taxRateBps: 1000,
        active: false
      }
    });
    expect(deactivated.json<{ active: boolean }>().active).toBe(false);
    const publicProducts = (await instance.inject({ method: "GET", url: "/v1/products" }))
      .json<{ products: Array<{ id: string }> }>().products;
    const managedProducts = (await instance.inject({ method: "GET", url: "/v1/products?includeInactive=true" }))
      .json<{ products: Array<{ id: string }> }>().products;
    expect(publicProducts.some((product) => product.id === created.id)).toBe(false);
    expect(managedProducts.some((product) => product.id === created.id)).toBe(true);
  });

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
    const postCheckoutMutation = await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/lines`,
      payload: { productId: products[0]!.id, quantity: 1 }
    });
    expect(postCheckoutMutation.statusCode).toBe(409);
    expect(postCheckoutMutation.json<{ error: { code: string } }>().error.code).toBe("CART_NOT_OPEN");

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

  it("runs a complete Vietnam QR sandbox checkout", async () => {
    const instance = await buildApp({
      config: { ...config, managerApiKey: "manager-test-key" },
      logger: false
    });
    openApps.push(instance);
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
      headers: { "idempotency-key": "vietnam-qr-checkout" }
    })).json<{ id: string }>().id;

    const started = await instance.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "vietnam-qr-payment" },
      payload: { tender: "vietnam_qr" }
    });
    expect(started.statusCode).toBe(201);
    const attempt = started.json<{
      id: string;
      status: string;
      tender: string;
      presentation: {
        sandbox: boolean;
        supportedWallets: string[];
        quote: { exchangeRate: string; settlementFeeBps: number; payerAmountMinor: string };
      };
      vietnamQr: { timeline: Array<{ type: string }> };
    }>();
    expect(attempt).toMatchObject({
      status: "PROCESSING",
      tender: "vietnam_qr",
      presentation: {
        sandbox: true,
        supportedWallets: ["VCB", "MOMO", "ZALOPAY", "SHOPEEPAY_VN"],
        quote: { exchangeRate: "25500", settlementFeeBps: 250 }
      },
      vietnamQr: { timeline: [{ type: "QR_CREATED" }] }
    });

    const scanned = await instance.inject({
      method: "POST",
      url: `/v1/sandbox/vietnam-qr/${attempt.id}/scan`,
      payload: { wallet: "VCB" }
    });
    expect(scanned.statusCode).toBe(200);
    expect(scanned.json<{ vietnamQr: { selectedWallet: string; timeline: Array<{ type: string }> } }>())
      .toMatchObject({
        vietnamQr: {
          selectedWallet: "VCB",
          timeline: [{ type: "QR_CREATED" }, { type: "CUSTOMER_OPENED" }]
        }
      });

    const completed = await instance.inject({
      method: "POST",
      url: `/v1/sandbox/vietnam-qr/${attempt.id}/complete`,
      payload: { wallet: "VCB", outcome: "APPROVED", duplicate: true }
    });
    expect(completed.statusCode).toBe(200);
    const captured = completed.json<{
      status: string;
      tender: string;
      paymentId: string;
      amountMinor: string;
      wallet: { wallet: string; payerAmountMinor: string; settlementFeeMinor: string };
      vietnamQr: { timeline: Array<{ type: string }> };
    }>();
    expect(captured).toMatchObject({
      status: "CAPTURED",
      tender: "vietnam_qr",
      wallet: { wallet: "VCB", settlementFeeMinor: "5" }
    });
    expect(captured.vietnamQr.timeline.map((event) => event.type)).toEqual([
      "QR_CREATED",
      "CUSTOMER_OPENED",
      "CUSTOMER_APPROVED",
      "PROVIDER_CONFIRMED",
      "SETTLED",
      "DUPLICATE_CALLBACK_IGNORED"
    ]);

    const receipt = await instance.inject({ method: "GET", url: `/v1/orders/${orderId}/receipt` });
    expect(receipt.json<{
      paymentStatus: string;
      tender: string;
      wallet: string;
      vietnamQr: { quote: { exchangeRate: string; settlementFeeMinor: string } };
    }>()).toMatchObject({
      paymentStatus: "CAPTURED",
      tender: "vietnam_qr",
      wallet: "VCB",
      vietnamQr: { quote: { exchangeRate: "25500", settlementFeeMinor: "5" } }
    });

    const refund = await instance.inject({
      method: "POST",
      url: `/v1/payments/${captured.paymentId}/refunds`,
      headers: {
        "idempotency-key": "vietnam-qr-refund-key",
        "x-manager-id": "manager-1",
        "x-manager-key": "manager-test-key"
      },
      payload: { amountMinor: "50", reason: "Vietnam QR timeline test" }
    });
    expect(refund.statusCode).toBe(201);
    const refundedReceipt = await instance.inject({
      method: "GET",
      url: `/v1/orders/${orderId}/receipt`
    });
    expect(refundedReceipt.json<{
      vietnamQr: { timeline: Array<{ type: string; description: string }> };
    }>().vietnamQr.timeline.at(-1)).toMatchObject({
      type: "REFUNDED",
      description: "Refunded $0.50"
    });
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
      private acceptedAt: Date | undefined;

      override async startSale(input: StartSaleRequest) {
        const result = await super.startSale(input);
        if (this.loseNextResponse) {
          this.loseNextResponse = false;
          this.acceptedAt = result.processedAt;
          throw new PaymentProviderError(
            "PROVIDER_UNAVAILABLE",
            "Simulated response was lost after provider acceptance",
            true
          );
        }
        return result;
      }

      override async getStatus(attemptId: string): Promise<PaymentResult> {
        const result = await super.getStatus(attemptId);
        return {
          ...result,
          // Make the provider's capture timestamp deterministically older
          // than the API's local UNKNOWN recovery write.
          processedAt: new Date((this.acceptedAt ?? result.processedAt).getTime() - 1_000)
        };
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

  it("atomically reserves an order so concurrent payment keys cannot double-charge", async () => {
    class CountingProvider extends SimulatedPaymentProvider {
      saleCalls = 0;

      override async startSale(input: StartSaleRequest) {
        this.saleCalls += 1;
        return super.startSale(input);
      }
    }

    const provider = new CountingProvider();
    const instance = await app(provider);
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
      headers: { "idempotency-key": "checkout-payment-race" }
    })).json<{ id: string }>().id;
    const pay = (key: string) => instance.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": key },
      payload: { tender: "card", terminalId: "simulated-reader" }
    });

    const keys = ["payment-race-key-one", "payment-race-key-two"] as const;
    const responses = await Promise.all(keys.map(pay));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(provider.saleCalls).toBe(1);

    const rejectedIndex = responses.findIndex((response) => response.statusCode === 409);
    const rejectedReplay = await pay(keys[rejectedIndex]!);
    expect(rejectedReplay.statusCode).toBe(409);
    expect(["PAYMENT_REJECTED", "ORDER_ALREADY_PAID"]).toContain(
      rejectedReplay.json<{ error: { code: string } }>().error.code
    );
    expect(provider.saleCalls).toBe(1);
  });

  it("resubmits the same provider attempt after a timeout before acceptance", async () => {
    class NotAcceptedOnceProvider extends SimulatedPaymentProvider {
      saleCalls = 0;

      override async startSale(input: StartSaleRequest) {
        this.saleCalls += 1;
        if (this.saleCalls === 1) {
          throw new PaymentProviderError(
            "PROVIDER_UNAVAILABLE",
            "Provider timed out before accepting the request",
            true
          );
        }
        return super.startSale(input);
      }
    }

    const provider = new NotAcceptedOnceProvider();
    const instance = await app(provider);
    const product = await instance.inject({
      method: "POST",
      url: "/v1/products",
      payload: {
        sku: "TIMEOUT-BEFORE-ACCEPT",
        name: "Timeout recovery item",
        priceMinor: "1500",
        currency: "USD",
        taxRateBps: 0
      }
    });
    const cartId = (await instance.inject({ method: "POST", url: "/v1/carts", payload: {} }))
      .json<{ id: string }>().id;
    await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/lines`,
      payload: { productId: product.json<{ id: string }>().id, quantity: 1 }
    });
    const orderId = (await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/checkout`,
      headers: { "idempotency-key": "checkout-timeout-before-accept" }
    })).json<{ id: string }>().id;
    const request = {
      method: "POST" as const,
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "payment-timeout-before-accept" },
      payload: { tender: "card", terminalId: "simulated-reader" }
    };

    expect((await instance.inject(request)).statusCode).toBe(503);
    const recovered = await instance.inject(request);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json<{ status: string }>().status).toBe("CAPTURED");
    expect(provider.saleCalls).toBe(2);
  });

  it("keeps CAPTURED when a stale PROCESSING status arrives concurrently", async () => {
    class RacingStatusProvider extends SimulatedPaymentProvider {
      private statusCalls = 0;
      private initialProcessedAt = new Date(0);
      private releaseSlow: (() => void) | undefined;
      private readonly slowStartedPromise: Promise<void>;
      private slowStarted: (() => void) | undefined;

      constructor() {
        super();
        this.slowStartedPromise = new Promise((resolve) => {
          this.slowStarted = resolve;
        });
      }

      override async startSale(input: StartSaleRequest) {
        const result = await super.startSale(input);
        this.initialProcessedAt = result.processedAt;
        return result;
      }

      waitForSlowStatus(): Promise<void> {
        return this.slowStartedPromise;
      }

      override async getStatus(attemptId: string): Promise<PaymentResult> {
        this.statusCalls += 1;
        if (this.statusCalls === 1) {
          this.slowStarted?.();
          await new Promise<void>((resolve) => {
            this.releaseSlow = resolve;
          });
          return {
            attemptId,
            status: "PROCESSING",
            providerPaymentId: null,
            providerReference: null,
            failureCode: null,
            failureMessage: null,
            card: null,
            processedAt: new Date(this.initialProcessedAt)
          };
        }
        const captured = await super.getStatus(attemptId);
        this.releaseSlow?.();
        return captured;
      }
    }

    const provider = new RacingStatusProvider();
    const instance = await app(provider);
    const product = await instance.inject({
      method: "POST",
      url: "/v1/products",
      payload: {
        sku: "STATUS-RACE",
        name: "Status race item",
        priceMinor: "102",
        currency: "USD",
        taxRateBps: 0
      }
    });
    const cartId = (await instance.inject({ method: "POST", url: "/v1/carts", payload: {} }))
      .json<{ id: string }>().id;
    await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/lines`,
      payload: { productId: product.json<{ id: string }>().id, quantity: 1 }
    });
    const orderId = (await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/checkout`,
      headers: { "idempotency-key": "checkout-status-race" }
    })).json<{ id: string }>().id;
    const initial = await instance.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "payment-status-race" },
      payload: { tender: "card", terminalId: "simulated-reader" }
    });
    expect(initial.json<{ status: string }>().status).toBe("UNKNOWN");
    const attemptId = initial.json<{ id: string }>().id;

    const slow = instance.inject({ method: "GET", url: `/v1/payment-attempts/${attemptId}` });
    await provider.waitForSlowStatus();
    const fast = instance.inject({ method: "GET", url: `/v1/payment-attempts/${attemptId}` });
    await Promise.all([slow, fast]);

    const final = await instance.inject({
      method: "GET",
      url: `/v1/payment-attempts/${attemptId}?refresh=false`
    });
    expect(final.json<{ status: string; paymentId: string }>().status).toBe("CAPTURED");
    expect(final.json<{ paymentId: string }>().paymentId).toBeTruthy();
  });

  it("lets a newer CAPTURED result dominate a concurrently persisted decline", async () => {
    class DeclineObservedRepository extends MemoryPosRepository {
      private declineSaved: (() => void) | undefined;
      private readonly declineSavedPromise = new Promise<void>((resolve) => {
        this.declineSaved = resolve;
      });

      waitForDeclineSave(): Promise<void> {
        return this.declineSavedPromise;
      }

      override async savePaymentAttempt(
        attempt: PaymentAttempt,
        expectedVersion?: number
      ): Promise<PaymentAttempt> {
        const saved = expectedVersion === undefined
          ? await super.savePaymentAttempt(attempt)
          : await super.savePaymentAttempt(attempt, expectedVersion);
        if (saved.status === "DECLINED") this.declineSaved?.();
        return saved;
      }
    }

    class ContradictoryTerminalProvider extends SimulatedPaymentProvider {
      private statusCalls = 0;
      private initialResult: PaymentResult | undefined;
      private firstStarted: (() => void) | undefined;
      private secondStarted: (() => void) | undefined;
      private readonly firstStartedPromise = new Promise<void>((resolve) => {
        this.firstStarted = resolve;
      });
      private readonly secondStartedPromise = new Promise<void>((resolve) => {
        this.secondStarted = resolve;
      });

      constructor(private readonly repository: DeclineObservedRepository) {
        super();
      }

      override async startSale(input: StartSaleRequest) {
        const result = await super.startSale(input);
        this.initialResult = result;
        return result;
      }

      waitForFirstStatus(): Promise<void> {
        return this.firstStartedPromise;
      }

      override async getStatus(attemptId: string): Promise<PaymentResult> {
        this.statusCalls += 1;
        const initial = this.initialResult;
        if (!initial) throw new Error("Expected an initial provider result");
        if (this.statusCalls === 1) {
          this.firstStarted?.();
          await this.secondStartedPromise;
          return {
            attemptId,
            status: "DECLINED",
            providerPaymentId: null,
            providerReference: initial.providerReference,
            failureCode: "DECLINED",
            failureMessage: "Contradictory decline",
            card: null,
            processedAt: new Date(initial.processedAt.getTime() + 1_000)
          };
        }
        this.secondStarted?.();
        await this.repository.waitForDeclineSave();
        const captured = await super.getStatus(attemptId);
        return {
          ...captured,
          processedAt: new Date(initial.processedAt.getTime() + 2_000)
        };
      }
    }

    const repository = new DeclineObservedRepository();
    const provider = new ContradictoryTerminalProvider(repository);
    const instance = await buildApp({ config, logger: false, repository, paymentProvider: provider });
    openApps.push(instance);
    const productId = (await instance.inject({
      method: "POST",
      url: "/v1/products",
      payload: {
        sku: "TERMINAL-RACE",
        name: "Terminal race item",
        priceMinor: "102",
        currency: "USD",
        taxRateBps: 0
      }
    })).json<{ id: string }>().id;
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
      headers: { "idempotency-key": "checkout-terminal-race" }
    })).json<{ id: string }>().id;
    const initial = await instance.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "payment-terminal-race" },
      payload: { tender: "card", terminalId: "simulated-reader" }
    });
    const attemptId = initial.json<{ id: string }>().id;
    expect(initial.json<{ status: string }>().status).toBe("UNKNOWN");

    const decline = instance.inject({ method: "GET", url: `/v1/payment-attempts/${attemptId}` });
    await provider.waitForFirstStatus();
    const capture = instance.inject({ method: "GET", url: `/v1/payment-attempts/${attemptId}` });
    await Promise.all([decline, capture]);

    const final = await instance.inject({
      method: "GET",
      url: `/v1/payment-attempts/${attemptId}?refresh=false`
    });
    expect(final.json<{ status: string; paymentId: string }>().status).toBe("CAPTURED");
    expect(final.json<{ paymentId: string }>().paymentId).toBeTruthy();
    const order = await instance.inject({ method: "GET", url: `/v1/orders/${orderId}` });
    expect(order.json<{ status: string }>().status).toBe("PAID");
  });

  it("recovers a persisted CREATED cash attempt without invoking the card provider", async () => {
    class FailFirstAttemptSaveRepository extends MemoryPosRepository {
      private fail = true;

      override async savePaymentAttempt(
        attempt: PaymentAttempt,
        expectedVersion?: number
      ): Promise<PaymentAttempt> {
        if (this.fail) {
          this.fail = false;
          throw new Error("Simulated crash after cash reservation");
        }
        return expectedVersion === undefined
          ? super.savePaymentAttempt(attempt)
          : super.savePaymentAttempt(attempt, expectedVersion);
      }
    }
    class CountingProvider extends SimulatedPaymentProvider {
      saleCalls = 0;

      override async startSale(input: StartSaleRequest) {
        this.saleCalls += 1;
        return super.startSale(input);
      }
    }

    const repository = new FailFirstAttemptSaveRepository();
    const provider = new CountingProvider();
    const instance = await buildApp({ config, logger: false, repository, paymentProvider: provider });
    openApps.push(instance);
    const productId = (await instance.inject({
      method: "POST",
      url: "/v1/products",
      payload: {
        sku: "CASH-RECOVERY",
        name: "Cash recovery item",
        priceMinor: "1000",
        currency: "USD",
        taxRateBps: 0
      }
    })).json<{ id: string }>().id;
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
      headers: { "idempotency-key": "checkout-cash-recovery" }
    })).json<{ id: string }>().id;
    const request = {
      method: "POST" as const,
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "payment-cash-recovery" },
      payload: { tender: "cash" }
    };

    expect((await instance.inject(request)).statusCode).toBe(500);
    const recovered = await instance.inject(request);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json<{ status: string; provider: string }>().status).toBe("CAPTURED");
    expect(recovered.json<{ provider: string }>().provider).toBe("cash");
    expect(provider.saleCalls).toBe(0);
  });

  it("scopes provider idempotency keys so the same client key works on separate orders", async () => {
    const instance = await app();
    const productId = (await instance.inject({ method: "GET", url: "/v1/products" }))
      .json<{ products: Array<{ id: string }> }>().products[0]!.id;
    const makeOrder = async (suffix: string): Promise<string> => {
      const cartId = (await instance.inject({ method: "POST", url: "/v1/carts", payload: {} }))
        .json<{ id: string }>().id;
      await instance.inject({
        method: "POST",
        url: `/v1/carts/${cartId}/lines`,
        payload: { productId, quantity: 1 }
      });
      return (await instance.inject({
        method: "POST",
        url: `/v1/carts/${cartId}/checkout`,
        headers: { "idempotency-key": `checkout-shared-key-${suffix}` }
      })).json<{ id: string }>().id;
    };
    const firstOrder = await makeOrder("one");
    const secondOrder = await makeOrder("two");
    const pay = (orderId: string) => instance.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "same-client-payment-key" },
      payload: { tender: "card", terminalId: "simulated-reader" }
    });

    expect((await pay(firstOrder)).statusCode).toBe(201);
    expect((await pay(secondOrder)).statusCode).toBe(201);
  });

  it("recovers when a process dies after claiming payment idempotency", async () => {
    class CrashAfterPaymentClaimRepository extends MemoryPosRepository {
      private crash = true;

      override async claimIdempotency(
        record: Parameters<MemoryPosRepository["claimIdempotency"]>[0]
      ) {
        const claim = await super.claimIdempotency(record);
        if (this.crash && claim.claimed && record.scope.startsWith("order-payment:")) {
          this.crash = false;
          throw new Error("Simulated process death after idempotency claim");
        }
        return claim;
      }
    }

    const repository = new CrashAfterPaymentClaimRepository();
    const instance = await buildApp({ config, logger: false, repository });
    openApps.push(instance);
    const productId = (await instance.inject({
      method: "POST",
      url: "/v1/products",
      payload: {
        sku: "PAYMENT-CLAIM-RECOVERY",
        name: "Payment claim recovery item",
        priceMinor: "1000",
        currency: "USD",
        taxRateBps: 0
      }
    })).json<{ id: string }>().id;
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
      headers: { "idempotency-key": "checkout-payment-claim-recovery" }
    })).json<{ id: string }>().id;
    const request = {
      method: "POST" as const,
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "payment-claim-recovery" },
      payload: { tender: "card", terminalId: "simulated-reader" }
    };

    expect((await instance.inject(request)).statusCode).toBe(500);
    const recovered = await instance.inject(request);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json<{ status: string; paymentId: string }>().status).toBe("CAPTURED");
    expect(recovered.json<{ paymentId: string }>().paymentId).toBeTruthy();
  });

  it("recovers when a process dies after claiming refund idempotency", async () => {
    class CrashAfterRefundClaimRepository extends MemoryPosRepository {
      private crash = true;

      override async claimIdempotency(
        record: Parameters<MemoryPosRepository["claimIdempotency"]>[0]
      ) {
        const claim = await super.claimIdempotency(record);
        if (this.crash && claim.claimed && record.scope.startsWith("payment-refund:")) {
          this.crash = false;
          throw new Error("Simulated process death after refund idempotency claim");
        }
        return claim;
      }
    }

    const repository = new CrashAfterRefundClaimRepository();
    const instance = await buildApp({
      config: { ...config, managerApiKey: "manager-test-key" },
      logger: false,
      repository
    });
    openApps.push(instance);
    const productId = (await instance.inject({
      method: "POST",
      url: "/v1/products",
      payload: {
        sku: "REFUND-CLAIM-RECOVERY",
        name: "Refund claim recovery item",
        priceMinor: "1000",
        currency: "USD",
        taxRateBps: 0
      }
    })).json<{ id: string }>().id;
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
      headers: { "idempotency-key": "checkout-refund-claim-recovery" }
    })).json<{ id: string }>().id;
    const payment = (await instance.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "payment-refund-claim-recovery" },
      payload: { tender: "card", terminalId: "simulated-reader" }
    })).json<{ paymentId: string; amountMinor: string }>();
    const request = {
      method: "POST" as const,
      url: `/v1/payments/${payment.paymentId}/refunds`,
      headers: {
        "idempotency-key": "refund-claim-recovery",
        "x-manager-id": "manager-1",
        "x-manager-key": "manager-test-key"
      },
      payload: { amountMinor: payment.amountMinor, reason: "Recovery test" }
    };

    expect((await instance.inject(request)).statusCode).toBe(500);
    const recovered = await instance.inject(request);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json<{ status: string }>().status).toBe("SUCCEEDED");
  });

  it("atomically prevents concurrent refunds from exceeding the captured payment", async () => {
    const instance = await buildApp({
      config: { ...config, managerApiKey: "manager-test-key" },
      logger: false
    });
    openApps.push(instance);
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
      headers: { "idempotency-key": "refund-checkout-key" }
    })).json<{ id: string }>().id;
    const payment = (await instance.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/payment-attempts`,
      headers: { "idempotency-key": "refund-payment-key" },
      payload: { tender: "card", terminalId: "simulated-reader" }
    })).json<{ paymentId: string; amountMinor: string }>();
    const refund = (key: string) => instance.inject({
      method: "POST",
      url: `/v1/payments/${payment.paymentId}/refunds`,
      headers: {
        "idempotency-key": key,
        "x-manager-id": "manager-1",
        "x-manager-key": "manager-test-key"
      },
      payload: { amountMinor: payment.amountMinor, reason: "Test return" }
    });

    const responses = await Promise.all([
      refund("refund-capacity-key-1"),
      refund("refund-capacity-key-2")
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const order = await instance.inject({ method: "GET", url: `/v1/orders/${orderId}` });
    expect(order.json<{ status: string }>().status).toBe("REFUNDED");
  });

  it("lists a persisted sale and records partial and full refunds in its history", async () => {
    const instance = await buildApp({
      config: { ...config, managerApiKey: "manager-test-key" },
      logger: false
    });
    openApps.push(instance);
    const product = (await instance.inject({
      method: "POST",
      url: "/v1/products",
      payload: {
        sku: "ORDER-HISTORY-ITEM",
        name: "Order history test item",
        priceMinor: "1000",
        currency: "USD",
        taxRateBps: 0
      }
    })).json<{ id: string }>();
    const cartId = (await instance.inject({ method: "POST", url: "/v1/carts", payload: {} }))
      .json<{ id: string }>().id;
    await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/lines`,
      payload: { productId: product.id, quantity: 1 }
    });
    const order = (await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartId}/checkout`,
      headers: { "idempotency-key": "history-checkout-key" }
    })).json<{ id: string; number: string }>();
    const payment = (await instance.inject({
      method: "POST",
      url: `/v1/orders/${order.id}/payment-attempts`,
      headers: { "idempotency-key": "history-payment-key" },
      payload: { tender: "card", terminalId: "simulated-reader" }
    })).json<{ paymentId: string; amountMinor: string }>();

    const listed = await instance.inject({
      method: "GET",
      url: "/v1/orders?status=PAID&search=history%20test&limit=10"
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{
      orders: Array<{
        id: string;
        payment: { tender: string; cardBrand: string };
        refundStatus: string;
        refundedMinor: string;
      }>;
    }>().orders).toContainEqual(expect.objectContaining({
      id: order.id,
      payment: expect.objectContaining({ tender: "card" }),
      refundStatus: "NONE",
      refundedMinor: "0"
    }));

    const refund = (key: string, amountMinor: string) => instance.inject({
      method: "POST" as const,
      url: `/v1/payments/${payment.paymentId}/refunds`,
      headers: {
        "idempotency-key": key,
        "x-manager-id": "manager-1",
        "x-manager-key": "manager-test-key"
      },
      payload: { amountMinor, reason: "Lifecycle test return" }
    });

    expect((await refund("history-partial-refund", "250")).statusCode).toBe(201);
    const partialSale = await instance.inject({ method: "GET", url: `/v1/orders/${order.id}/sale` });
    expect(partialSale.json<{ order: { status: string }; refunds: Array<{ amountMinor: string }> }>())
      .toMatchObject({ order: { status: "PAID" }, refunds: [{ amountMinor: "250" }] });
    const partialReceipt = await instance.inject({ method: "GET", url: `/v1/orders/${order.id}/receipt` });
    expect(partialReceipt.json<{ refundStatus: string; refundedMinor: string; remainingMinor: string }>())
      .toMatchObject({ refundStatus: "PARTIAL", refundedMinor: "250", remainingMinor: "750" });
    const partiallyRefundedOrders = await instance.inject({
      method: "GET",
      url: "/v1/orders?status=PAID"
    });
    expect(partiallyRefundedOrders.json<{
      orders: Array<{ id: string; status: string; refundStatus: string; remainingMinor: string }>;
    }>().orders).toContainEqual(expect.objectContaining({
      id: order.id,
      status: "PAID",
      refundStatus: "PARTIAL",
      remainingMinor: "750"
    }));

    expect((await refund("history-full-refund", "750")).statusCode).toBe(201);
    const fullReceipt = await instance.inject({ method: "GET", url: `/v1/orders/${order.id}/receipt` });
    expect(fullReceipt.json<{ status: string; refundStatus: string; refundedMinor: string; remainingMinor: string }>())
      .toMatchObject({ status: "REFUNDED", refundStatus: "FULL", refundedMinor: "1000", remainingMinor: "0" });
    const refundedOrders = await instance.inject({ method: "GET", url: "/v1/orders?status=REFUNDED" });
    expect(refundedOrders.json<{ orders: Array<{ id: string }> }>().orders.map((item) => item.id))
      .toContain(order.id);
  });

  it("enforces staff roles and manager-bound refund approvals, audits actions, and resets demo data", async () => {
    const securedConfig: ApiConfig = {
      ...config,
      authEnabled: true,
      authSecret: "unit-test-auth-secret-that-is-not-used-outside-tests",
      staffCredentials: [
        { id: "cashier-01", name: "Test Cashier", role: "CASHIER", pin: "123456" },
        { id: "manager-01", name: "Test Manager", role: "MANAGER", pin: "246810" }
      ],
      demoResetEnabled: true
    };
    const securedProvider = new SimulatedPaymentProvider({
      webhookSecret: securedConfig.simulatedWebhookSecret
    });
    const instance = await buildApp({
      config: securedConfig,
      logger: false,
      paymentProvider: securedProvider
    });
    openApps.push(instance);

    expect((await instance.inject({ method: "GET", url: "/v1/products" })).statusCode).toBe(401);

    const login = async (staffId: string, pin: string) => {
      const response = await instance.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { staffId, pin }
      });
      expect(response.statusCode).toBe(200);
      return response.json<{ token: string; staff: { role: string } }>();
    };
    const cashier = await login("cashier-01", "123456");
    const manager = await login("manager-01", "246810");
    expect(cashier.staff.role).toBe("CASHIER");
    expect(manager.staff.role).toBe("MANAGER");
    const cashierHeaders = { authorization: `Bearer ${cashier.token}` };
    const managerHeaders = { authorization: `Bearer ${manager.token}` };

    const productsResponse = await instance.inject({
      method: "GET",
      url: "/v1/products",
      headers: cashierHeaders
    });
    expect(productsResponse.statusCode).toBe(200);
    expect((await instance.inject({
      method: "GET",
      url: "/v1/products?includeInactive=true",
      headers: cashierHeaders
    })).statusCode).toBe(403);
    expect((await instance.inject({
      method: "GET",
      url: "/v1/products?includeInactive=true",
      headers: managerHeaders
    })).statusCode).toBe(200);

    const productId = productsResponse.json<{ products: Array<{ id: string }> }>().products[0]!.id;
    const cart = (await instance.inject({
      method: "POST",
      url: "/v1/carts",
      headers: cashierHeaders,
      payload: {}
    })).json<{ id: string }>();
    await instance.inject({
      method: "POST",
      url: `/v1/carts/${cart.id}/lines`,
      headers: cashierHeaders,
      payload: { productId, quantity: 1 }
    });
    const order = (await instance.inject({
      method: "POST",
      url: `/v1/carts/${cart.id}/checkout`,
      headers: { ...cashierHeaders, "idempotency-key": "secured-checkout-key" }
    })).json<{ id: string }>();
    const payment = (await instance.inject({
      method: "POST",
      url: `/v1/orders/${order.id}/payment-attempts`,
      headers: { ...cashierHeaders, "idempotency-key": "secured-payment-key" },
      payload: { tender: "card", terminalId: "secured-test-reader" }
    })).json<{ paymentId: string; amountMinor: string }>();

    const approvedRefundKey = "approved-refund-key";
    expect((await instance.inject({
      method: "POST",
      url: "/v1/auth/manager-approvals",
      headers: cashierHeaders,
      payload: {
        managerId: "manager-01",
        managerPin: "000000",
        paymentId: payment.paymentId,
        amountMinor: payment.amountMinor,
        idempotencyKey: approvedRefundKey
      }
    })).statusCode).toBe(401);
    const approvalResponse = await instance.inject({
      method: "POST",
      url: "/v1/auth/manager-approvals",
      headers: cashierHeaders,
      payload: {
        managerId: "manager-01",
        managerPin: "246810",
        paymentId: payment.paymentId,
        amountMinor: payment.amountMinor,
        idempotencyKey: approvedRefundKey
      }
    });
    expect(approvalResponse.statusCode).toBe(200);
    const approval = approvalResponse.json<{ approvalToken: string; approvedBy: string }>();
    expect(approval.approvedBy).toBe("manager-01");

    const mismatchedRefund = await instance.inject({
      method: "POST",
      url: `/v1/payments/${payment.paymentId}/refunds`,
      headers: {
        ...cashierHeaders,
        "idempotency-key": approvedRefundKey,
        "x-manager-approval": approval.approvalToken
      },
      payload: { amountMinor: "1", reason: "Wrong amount test" }
    });
    expect(mismatchedRefund.statusCode).toBe(403);

    const refund = await instance.inject({
      method: "POST",
      url: `/v1/payments/${payment.paymentId}/refunds`,
      headers: {
        ...cashierHeaders,
        "idempotency-key": approvedRefundKey,
        "x-manager-approval": approval.approvalToken
      },
      payload: { amountMinor: payment.amountMinor, reason: "Approved sandbox return" }
    });
    expect(refund.statusCode).toBe(201);
    expect((await instance.inject({
      method: "POST",
      url: `/v1/payments/${payment.paymentId}/refunds`,
      headers: {
        ...cashierHeaders,
        "idempotency-key": "approval-reuse-blocked",
        "x-manager-approval": approval.approvalToken
      },
      payload: { amountMinor: payment.amountMinor, reason: "Approval replay test" }
    })).statusCode).toBe(403);

    const audit = await instance.inject({ method: "GET", url: "/v1/audit", headers: managerHeaders });
    expect(audit.statusCode).toBe(200);
    const auditEntries = audit.json<{ entries: Array<{ action: string; actorId: string | null }> }>().entries;
    const actions = auditEntries.map((entry) => entry.action);
    expect(actions).toContain("MANAGER_APPROVAL_GRANTED");
    expect(actions).toContain("MANAGER_APPROVAL_DENIED");
    expect(actions).toContain("REFUND_UPDATED");
    expect(auditEntries).toContainEqual(expect.objectContaining({
      action: "PAYMENT_STARTED",
      actorId: "cashier-01"
    }));
    expect((await instance.inject({ method: "GET", url: "/v1/audit", headers: cashierHeaders })).statusCode)
      .toBe(403);

    const webhookPayload = {
      id: "sandbox-webhook-duplicate-test",
      type: "payment.updated",
      occurredAt: new Date().toISOString(),
      data: {}
    };
    const webhookRequest = {
      method: "POST" as const,
      url: "/v1/providers/simulated/webhooks",
      headers: { "x-simulated-signature": securedConfig.simulatedWebhookSecret },
      payload: webhookPayload
    };
    expect((await instance.inject(webhookRequest)).json<{ replayed: boolean }>().replayed).toBe(false);
    expect((await instance.inject(webhookRequest)).json<{ replayed: boolean }>().replayed).toBe(true);
    expect((await instance.inject({
      ...webhookRequest,
      payload: { ...webhookPayload, type: "payment.changed-with-conflicting-payload" }
    })).statusCode).toBe(409);
    expect((await instance.inject(webhookRequest)).json<{ replayed: boolean }>().replayed).toBe(true);

    const reset = await instance.inject({ method: "POST", url: "/v1/sandbox/reset", headers: managerHeaders });
    expect(reset.statusCode).toBe(200);
    const resetAt = reset.json<{ resetAt: string }>().resetAt;
    expect((await instance.inject({ method: "GET", url: "/v1/runtime-status" }))
      .json<{ demoReset: { lastAt: string } }>().demoReset.lastAt).toBe(resetAt);
    expect((await securedProvider.listSettlements()).items).toEqual([]);
    expect((await instance.inject({ method: "GET", url: "/v1/orders", headers: managerHeaders }))
      .json<{ orders: unknown[] }>().orders).toEqual([]);
    expect((await instance.inject({ method: "GET", url: "/v1/products", headers: managerHeaders }))
      .json<{ products: unknown[] }>().products.length).toBeGreaterThan(0);
  });

  it("creates isolated public guest sessions and blocks cross-visitor access", async () => {
    const publicConfig: ApiConfig = {
      ...config,
      publicSandbox: true,
      authEnabled: true,
      authSecret: "public-guest-test-auth-secret-long-enough-for-tests",
      staffCredentials: [
        { id: "cashier-01", name: "Test Cashier", role: "CASHIER", pin: "123456" },
        { id: "manager-01", name: "Test Manager", role: "MANAGER", pin: "246810" }
      ],
      demoResetEnabled: true,
      demoResetIntervalMinutes: 60
    };
    const instance = await buildApp({ config: publicConfig, logger: false });
    openApps.push(instance);

    const runtime = await instance.inject({ method: "GET", url: "/v1/runtime-status" });
    expect(runtime.json<{ auth: { guestAccess: boolean; staffLoginEnabled: boolean } }>().auth)
      .toMatchObject({ guestAccess: true, staffLoginEnabled: false });
    expect((await instance.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { staffId: "manager-01", pin: "246810" }
    })).statusCode).toBe(404);

    const startGuest = async () => {
      const response = await instance.inject({ method: "POST", url: "/v1/auth/guest" });
      expect(response.statusCode).toBe(200);
      return response.json<{ token: string; staff: { guest: boolean; role: string } }>();
    };
    const guestA = await startGuest();
    const guestB = await startGuest();
    expect(guestA.staff).toMatchObject({ guest: true, role: "CASHIER" });
    expect(guestB.token).not.toBe(guestA.token);
    const headersA = { authorization: `Bearer ${guestA.token}` };
    const headersB = { authorization: `Bearer ${guestB.token}` };

    const products = (await instance.inject({
      method: "GET",
      url: "/v1/products",
      headers: headersA
    })).json<{ products: Array<{ id: string }> }>().products;
    const productId = products[0]!.id;
    const cartA = (await instance.inject({
      method: "POST",
      url: "/v1/carts",
      headers: headersA,
      payload: {}
    })).json<{ id: string }>();

    expect((await instance.inject({
      method: "GET",
      url: `/v1/carts/${cartA.id}`,
      headers: headersB
    })).statusCode).toBe(404);
    expect((await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartA.id}/lines`,
      headers: headersB,
      payload: { productId, quantity: 1 }
    })).statusCode).toBe(404);

    await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartA.id}/lines`,
      headers: headersA,
      payload: { productId, quantity: 1 }
    });
    const orderAResponse = await instance.inject({
      method: "POST",
      url: `/v1/carts/${cartA.id}/checkout`,
      headers: { ...headersA, "idempotency-key": "guest-a-checkout" }
    });
    expect(orderAResponse.statusCode).toBe(201);
    const orderA = orderAResponse.json<{ id: string }>();
    const paymentAResponse = await instance.inject({
      method: "POST",
      url: `/v1/orders/${orderA.id}/payment-attempts`,
      headers: { ...headersA, "idempotency-key": "guest-a-payment" },
      payload: { tender: "card", terminalId: "guest-reader" }
    });
    expect(paymentAResponse.statusCode).toBe(201);
    const paymentA = paymentAResponse.json<{ id: string; paymentId: string; amountMinor: string }>();

    expect((await instance.inject({
      method: "POST",
      url: "/v1/auth/manager-approvals",
      headers: headersA,
      payload: {
        managerId: "manager-01",
        managerPin: "246810",
        paymentId: paymentA.paymentId,
        amountMinor: paymentA.amountMinor,
        idempotencyKey: "guest-refund-attempt"
      }
    })).statusCode).toBe(403);
    expect((await instance.inject({
      method: "POST",
      url: `/v1/payments/${paymentA.paymentId}/refunds`,
      headers: { ...headersA, "idempotency-key": "guest-refund-attempt" },
      payload: { amountMinor: paymentA.amountMinor, reason: "Guest cannot refund" }
    })).statusCode).toBe(403);

    const ordersA = (await instance.inject({
      method: "GET",
      url: "/v1/orders",
      headers: headersA
    })).json<{ orders: Array<{ id: string }> }>().orders;
    const ordersB = (await instance.inject({
      method: "GET",
      url: "/v1/orders",
      headers: headersB
    })).json<{ orders: Array<{ id: string }> }>().orders;
    expect(ordersA.map((order) => order.id)).toEqual([orderA.id]);
    expect(ordersB).toEqual([]);

    for (const url of [
      `/v1/orders/${orderA.id}`,
      `/v1/orders/${orderA.id}/sale`,
      `/v1/orders/${orderA.id}/receipt`,
      `/v1/payment-attempts/${paymentA.id}`,
      `/v1/payments/${paymentA.paymentId}`
    ]) {
      expect((await instance.inject({ method: "GET", url, headers: headersB })).statusCode).toBe(404);
    }
    expect((await instance.inject({
      method: "GET",
      url: "/v1/reconciliation/summary?from=2026-01-01&to=2027-01-01&currency=USD",
      headers: headersA
    })).statusCode).toBe(403);
  });

  it("rate limits repeated staff login attempts", async () => {
    const instance = await buildApp({
      config: {
        ...config,
        authEnabled: true,
        authSecret: "rate-limit-test-secret",
        staffCredentials: [
          { id: "cashier-01", name: "Test Cashier", role: "CASHIER", pin: "123456" }
        ],
        rateLimitEnabled: true,
        loginRateLimitMax: 2,
        loginRateLimitWindowMs: 60_000,
        rateLimitMax: 100,
        rateLimitWindowMs: 60_000
      },
      logger: false
    });
    openApps.push(instance);
    const badLogin = () => instance.inject({
      method: "POST" as const,
      url: "/v1/auth/login",
      payload: { staffId: "cashier-01", pin: "wrong" }
    });
    expect((await badLogin()).statusCode).toBe(401);
    expect((await badLogin()).statusCode).toBe(401);
    const limited = await badLogin();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });
});
