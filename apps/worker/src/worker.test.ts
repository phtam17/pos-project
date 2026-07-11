import { PosService } from "@pos/application";
import { Money } from "@pos/domain";
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

  it("advances to the provider cursor when retrying an already-ingested page", async () => {
    const repository = new MemoryPosRepository();
    const provider = new SimulatedPaymentProvider({ settlementPageSize: 1 });
    const service = new PosService(repository, provider);
    const product = await service.createProduct({
      sku: "PAGINATED-SETTLEMENT",
      name: "Paginated settlement item",
      priceMinor: "1000",
      currency: "USD"
    });

    for (const suffix of ["one", "two"]) {
      const cart = await service.createCart("USD");
      await service.addCartLine(cart.id, product.id, 1);
      const order = await service.checkout(cart.id, `paginated-checkout-${suffix}`);
      await service.startPayment({
        orderId: order.id,
        tender: "card",
        terminalId: "simulated-reader",
        idempotencyKey: `paginated-payment-${suffix}`
      });
    }

    const committed = await runWorkerOnce({
      repository,
      provider,
      publish: async () => undefined
    });
    const retriedBeforeCursorSave = await runWorkerOnce({
      repository,
      provider,
      publish: async () => undefined
    });

    expect(committed.settlementBatches).toBe(1);
    expect(committed.settlementLines).toBe(1);
    expect(committed.nextSettlementCursor).toBe("1");
    expect(retriedBeforeCursorSave.settlementBatches).toBe(0);
    expect(retriedBeforeCursorSave.settlementLines).toBe(0);
    expect(retriedBeforeCursorSave.nextSettlementCursor).toBe("1");
  });

  it("creates one settlement batch per currency on a mixed-currency page", async () => {
    const repository = new MemoryPosRepository();
    const provider = new SimulatedPaymentProvider();
    const service = new PosService(repository, provider);

    for (const [currency, priceMinor] of [["USD", "1000"], ["EUR", "2000"]] as const) {
      const product = await service.createProduct({
        sku: `MIXED-${currency}`,
        name: `${currency} settlement item`,
        priceMinor,
        currency
      });
      const cart = await service.createCart(currency);
      await service.addCartLine(cart.id, product.id, 1);
      const order = await service.checkout(cart.id, `mixed-checkout-${currency}`);
      await service.startPayment({
        orderId: order.id,
        tender: "card",
        terminalId: "simulated-reader",
        idempotencyKey: `mixed-payment-${currency}`
      });
    }

    const result = await runWorkerOnce({
      repository,
      provider,
      publish: async () => undefined
    });

    expect(result.settlementBatches).toBe(2);
    expect(result.settlementLines).toBe(2);
    expect(result.unmatchedSettlementItems).toEqual([]);
    for (const currency of ["USD", "EUR"]) {
      const summary = await repository.reconciliationSummary({
        from: new Date(Date.now() - 60_000),
        to: new Date(Date.now() + 60_000),
        currency,
        provider: provider.name
      });
      expect(summary.unreconciledPaymentIds).toEqual([]);
    }
  });

  it("leaves settlement references with the wrong amount or currency unmatched", async () => {
    const repository = new MemoryPosRepository();
    const provider = new SimulatedPaymentProvider();
    const service = new PosService(repository, provider);
    const product = await service.createProduct({
      sku: "MISMATCHED-SETTLEMENT",
      name: "Mismatched settlement item",
      priceMinor: "1000",
      currency: "USD"
    });
    const cart = await service.createCart("USD");
    await service.addCartLine(cart.id, product.id, 1);
    const order = await service.checkout(cart.id, "mismatched-checkout-key");
    const captured = await service.startPayment({
      orderId: order.id,
      tender: "card",
      terminalId: "simulated-reader",
      idempotencyKey: "mismatched-payment-key"
    });
    if (!captured.payment) throw new Error("Expected a captured payment");

    const legitimatePage = await provider.listSettlements();
    const legitimateItem = legitimatePage.items[0];
    if (!legitimateItem) throw new Error("Expected a simulated settlement item");
    provider.listSettlements = async () => ({
      items: [
        {
          ...legitimateItem,
          id: "wrong-amount",
          grossAmount: Money.fromMinor(1001n, "USD"),
          netAmount: Money.fromMinor(1001n, "USD")
        },
        {
          ...legitimateItem,
          id: "wrong-currency",
          grossAmount: Money.fromMinor(1000n, "EUR"),
          feeAmount: Money.zero("EUR"),
          netAmount: Money.fromMinor(1000n, "EUR")
        }
      ],
      nextCursor: "2"
    });

    const result = await runWorkerOnce({
      repository,
      provider,
      publish: async () => undefined
    });
    const summary = await repository.reconciliationSummary({
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
      currency: "USD",
      provider: provider.name
    });

    expect(result.settlementBatches).toBe(0);
    expect(result.settlementLines).toBe(0);
    expect(result.unmatchedSettlementItems).toEqual(["wrong-amount", "wrong-currency"]);
    expect(result.nextSettlementCursor).toBeNull();
    expect(summary.settledGross.minorUnits).toBe(0n);
    expect(summary.unreconciledPaymentIds).toEqual([captured.payment.id]);
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
