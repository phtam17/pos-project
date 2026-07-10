import { PosService } from "@pos/application";
import { SimulatedPaymentProvider } from "@pos/payments-simulated";
import { MemoryPosRepository } from "@pos/persistence";
import { describe, expect, it } from "vitest";

import { runWorkerOnce } from "./worker.js";

describe("reconciliation worker", () => {
  it("ingests a provider settlement page only once", async () => {
    const repository = new MemoryPosRepository();
    const provider = new SimulatedPaymentProvider();
    const service = new PosService(repository, provider);
    const product = await service.createProduct({
      sku: "WORKER-TEST",
      name: "Worker test item",
      priceMinor: "1000",
      currency: "USD"
    });
    const cart = await service.createCart("USD");
    await service.addCartLine(cart.id, product.id, 1);
    const order = await service.checkout(cart.id, "worker-checkout-key");
    await service.startPayment({
      orderId: order.id,
      tender: "card",
      terminalId: "simulated-reader",
      idempotencyKey: "worker-payment-key"
    });

    const first = await runWorkerOnce({
      repository,
      provider,
      publish: async () => undefined
    });
    const second = await runWorkerOnce({
      repository,
      provider,
      publish: async () => undefined
    });

    expect(first.settlementBatches).toBe(1);
    expect(first.settlementLines).toBe(1);
    expect(second.settlementBatches).toBe(0);
    const nextCart = await service.createCart("USD");
    await service.addCartLine(nextCart.id, product.id, 1);
    const nextOrder = await service.checkout(nextCart.id, "worker-checkout-key-2");
    await service.startPayment({
      orderId: nextOrder.id,
      tender: "card",
      terminalId: "simulated-reader",
      idempotencyKey: "worker-payment-key-2"
    });
    const growingFeed = await runWorkerOnce({
      repository,
      provider,
      publish: async () => undefined
    });
    expect(growingFeed.settlementBatches).toBe(1);
    expect(growingFeed.settlementLines).toBe(1);
    const summary = await repository.reconciliationSummary({
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
      currency: "USD",
      provider: provider.name
    });
    expect(summary.capturedGross.minorUnits).toBe(2000n);
    expect(summary.settledGross.minorUnits).toBe(2000n);
    expect(summary.unreconciledPaymentIds).toEqual([]);
  });

  it("records publish failures and defers their retry lock", async () => {
    const repository = new MemoryPosRepository();
    const provider = new SimulatedPaymentProvider();
    const service = new PosService(repository, provider);
    await service.createCart("USD");

    const first = await runWorkerOnce({
      repository,
      provider,
      publish: async () => {
        throw new Error("broker unavailable");
      }
    });
    const immediateRetry = await runWorkerOnce({
      repository,
      provider,
      publish: async () => undefined
    });

    expect(first.failedOutbox).toBe(1);
    expect(immediateRetry.publishedOutbox).toBe(0);
  });
});
