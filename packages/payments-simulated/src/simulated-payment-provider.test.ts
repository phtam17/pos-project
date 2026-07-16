import { Money } from "@pos/domain";
import {
  SensitiveCardDataError,
  type StartSaleRequest,
} from "@pos/payment-contract";
import { describe, expect, it } from "vitest";
import {
  SIMULATED_WEBHOOK_SECRET,
  SimulatedPaymentProvider,
} from "./index.js";

function sale(minorUnits: bigint, suffix: string): StartSaleRequest {
  return {
    attemptId: `attempt-${suffix}`,
    orderId: `order-${suffix}`,
    amount: new Money(minorUnits, "USD"),
    terminalId: "terminal-1",
    idempotencyKey: `sale-${suffix}`,
  };
}

function clock(...timestamps: string[]): () => Date {
  let index = 0;
  return () => {
    const selected = timestamps[Math.min(index, timestamps.length - 1)];
    index += 1;
    if (selected === undefined) throw new Error("Test clock needs a timestamp");
    return new Date(selected);
  };
}

describe("SimulatedPaymentProvider outcomes", () => {
  it("declines amounts ending in 01 cents", async () => {
    const provider = new SimulatedPaymentProvider({
      clock: clock("2026-01-01T00:00:00.000Z"),
    });
    const result = await provider.startSale(sale(1_001n, "decline"));
    expect(result.status).toBe("DECLINED");
    expect(result.failureCode).toBe("SIMULATED_DECLINE");
    expect(result.providerPaymentId).toBeNull();
  });

  it("returns UNKNOWN for 02 then resolves to CAPTURED on getStatus", async () => {
    const provider = new SimulatedPaymentProvider({
      clock: clock(
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z",
      ),
    });
    const initial = await provider.startSale(sale(1_002n, "unknown"));
    expect(initial.status).toBe("UNKNOWN");
    expect(initial.providerPaymentId).toBeNull();

    const resolved = await provider.getStatus(initial.attemptId);
    expect(resolved.status).toBe("CAPTURED");
    expect(resolved.providerPaymentId).toMatch(/^sim_pay_/);
    expect((await provider.getStatus(initial.attemptId)).processedAt).toEqual(
      resolved.processedAt,
    );
  });

  it("captures every other positive amount", async () => {
    const provider = new SimulatedPaymentProvider();
    await expect(provider.startSale(sale(1_000n, "success"))).resolves.toMatchObject({
      status: "CAPTURED",
      card: { brand: "VISA", last4: "4242", entryMethod: "CONTACTLESS" },
    });
  });
});

describe("simulator safety and replay behavior", () => {
  it("replays an identical idempotent request and rejects changed data", async () => {
    const provider = new SimulatedPaymentProvider({
      clock: clock(
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:05.000Z",
      ),
    });
    const input = sale(2_500n, "idem");
    const first = await provider.startSale(input);
    const replay = await provider.startSale({ ...input });
    expect(replay).toEqual(first);

    await expect(
      provider.startSale({ ...input, amount: new Money(2_600n, "USD") }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("rejects raw card fields and PAN-like values even when hidden in metadata", async () => {
    const provider = new SimulatedPaymentProvider();
    const withCvv = {
      ...sale(2_500n, "cvv"),
      cvv: "123",
    } as unknown as StartSaleRequest;
    await expect(provider.startSale(withCvv)).rejects.toBeInstanceOf(
      SensitiveCardDataError,
    );

    const withPan = {
      ...sale(2_500n, "pan"),
      metadata: { note: "4242424242424242" },
    };
    await expect(provider.startSale(withPan)).rejects.toBeInstanceOf(
      SensitiveCardDataError,
    );
  });
});

describe("refunds, settlements, and webhooks", () => {
  it("supports idempotent partial refunds and exposes settlement records", async () => {
    const provider = new SimulatedPaymentProvider({ settlementPageSize: 1 });
    const captured = await provider.startSale(sale(5_000n, "refund"));
    if (captured.providerPaymentId === null) throw new Error("Expected captured payment");
    const request = {
      refundId: "refund-1",
      paymentId: captured.providerPaymentId,
      amount: new Money(1_000n, "USD"),
      idempotencyKey: "refund-key-1",
    };
    const first = await provider.refund(request);
    expect(await provider.refund(request)).toEqual(first);
    expect(first.status).toBe("SUCCEEDED");

    const page1 = await provider.listSettlements();
    const page2 = await provider.listSettlements(page1.nextCursor ?? undefined);
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]?.kind).toBe("PAYMENT");
    expect(page2.items[0]?.kind).toBe("REFUND");
    expect(page2.items[0]?.grossAmount.minorUnits).toBe(-1_000n);

    provider.resetSandbox();
    expect((await provider.listSettlements()).items).toEqual([]);
    await expect(provider.startSale(sale(5_000n, "refund"))).resolves.toMatchObject({
      status: "CAPTURED"
    });
  });

  it("verifies signed, non-sensitive webhook payloads", async () => {
    const provider = new SimulatedPaymentProvider();
    const body = new TextEncoder().encode(
      JSON.stringify({
        id: "event-1",
        type: "payment.captured",
        occurredAt: "2026-01-01T00:00:00.000Z",
        data: { attemptId: "attempt-1" },
      }),
    );
    const event = await provider.verifyWebhook(body, {
      "x-simulated-signature": SIMULATED_WEBHOOK_SECRET,
    });
    expect(event.type).toBe("payment.captured");
    await expect(provider.verifyWebhook(body, {})).rejects.toMatchObject({
      code: "INVALID_WEBHOOK",
    });
  });
});
