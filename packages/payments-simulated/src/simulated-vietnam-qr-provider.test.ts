import { Money } from "@pos/domain";
import type { StartSaleRequest } from "@pos/payment-contract";
import { describe, expect, it } from "vitest";

import { SimulatedVietnamQrProvider } from "./simulated-vietnam-qr-provider.js";

function sale(id: string): StartSaleRequest {
  return {
    attemptId: `attempt-${id}`,
    orderId: `order-${id}`,
    amount: new Money(2_500n, "USD"),
    terminalId: "register-qr-display",
    idempotencyKey: `payment-${id}`,
    metadata: { tender: "vietnam_qr" },
  };
}

describe("SimulatedVietnamQrProvider", () => {
  it("creates an expiring QR and captures the selected wallet", async () => {
    const provider = new SimulatedVietnamQrProvider();
    const pending = await provider.startSale(sale("approved"));

    expect(pending.status).toBe("PROCESSING");
    expect(pending.presentation).toMatchObject({
      type: "QR_CODE",
      sandbox: true,
      supportedWallets: ["VCB", "MOMO", "ZALOPAY", "SHOPEEPAY_VN"],
      quote: {
        payerAmountMinor: "637500",
        exchangeRate: "25500",
        settlementFeeBps: 250,
        settlementFeeMinor: "63",
        merchantNetMinor: "2437",
      },
    });

    const scanned = await provider.openSandboxPayment(pending.attemptId, "MOMO");
    expect(scanned.vietnamQr).toMatchObject({
      selectedWallet: "MOMO",
      timeline: [
        { type: "QR_CREATED" },
        { type: "CUSTOMER_OPENED" },
      ],
    });

    const captured = await provider.completeSandboxPayment(
      pending.attemptId,
      "MOMO",
      "APPROVED",
    );
    expect(captured).toMatchObject({
      status: "CAPTURED",
      wallet: {
        wallet: "MOMO",
        payerCurrency: "VND",
        payerAmountMinor: "637500",
        exchangeRate: "25500",
        settlementFeeBps: 250,
        settlementFeeMinor: "63",
        merchantNetMinor: "2437",
      },
      vietnamQr: {
        selectedWallet: "MOMO",
        timeline: [
          { type: "QR_CREATED" },
          { type: "CUSTOMER_OPENED" },
          { type: "CUSTOMER_APPROVED" },
          { type: "PROVIDER_CONFIRMED" },
          { type: "SETTLED" },
        ],
      },
    });

    const settlements = await provider.listSettlements();
    expect(settlements.items).toHaveLength(1);
    expect(settlements.items[0]).toMatchObject({
      kind: "PAYMENT",
      grossAmount: new Money(2_500n, "USD"),
      feeAmount: new Money(63n, "USD"),
      netAmount: new Money(2_437n, "USD"),
    });
  });

  it("delivers delayed callbacks through status polling and ignores duplicates", async () => {
    let current = new Date("2026-07-15T12:00:00.000Z");
    const provider = new SimulatedVietnamQrProvider({ clock: () => current });
    const pending = await provider.startSale(sale("delayed"));
    await provider.openSandboxPayment(pending.attemptId, "VCB");
    const scheduled = await provider.completeSandboxPayment(
      pending.attemptId,
      "VCB",
      "APPROVED",
      { delayMs: 5_000, duplicate: true },
    );
    expect(scheduled.status).toBe("PROCESSING");
    expect(scheduled.vietnamQr?.timeline.map((event) => event.type))
      .toContain("CALLBACK_SCHEDULED");

    current = new Date("2026-07-15T12:00:04.000Z");
    expect((await provider.getStatus(pending.attemptId)).status).toBe("PROCESSING");
    current = new Date("2026-07-15T12:00:06.000Z");
    const captured = await provider.getStatus(pending.attemptId);
    expect(captured.status).toBe("CAPTURED");
    expect(captured.vietnamQr?.timeline.map((event) => event.type)).toEqual([
      "QR_CREATED",
      "CUSTOMER_OPENED",
      "CALLBACK_SCHEDULED",
      "CUSTOMER_APPROVED",
      "PROVIDER_CONFIRMED",
      "SETTLED",
      "DUPLICATE_CALLBACK_IGNORED",
    ]);
    expect((await provider.listSettlements()).items).toHaveLength(1);
  });

  it("automatically expires a QR when its status is polled after the deadline", async () => {
    let current = new Date("2026-07-15T12:00:00.000Z");
    const provider = new SimulatedVietnamQrProvider({
      clock: () => current,
      expiresInMs: 1_000,
    });
    const pending = await provider.startSale(sale("automatic-expiry"));
    current = new Date("2026-07-15T12:00:02.000Z");
    const expired = await provider.getStatus(pending.attemptId);
    expect(expired).toMatchObject({ status: "CANCELED", failureCode: "QR_EXPIRED" });
    expect(expired.vietnamQr?.timeline.at(-1)?.type).toBe("EXPIRED");
  });

  it("supports decline, expiry, and idempotent refunds", async () => {
    const provider = new SimulatedVietnamQrProvider();
    const declined = await provider.startSale(sale("declined"));
    await expect(provider.completeSandboxPayment(declined.attemptId, "VCB", "DECLINED"))
      .resolves.toMatchObject({ status: "DECLINED", failureCode: "SANDBOX_CUSTOMER_DECLINED" });

    const expired = await provider.startSale(sale("expired"));
    await expect(provider.completeSandboxPayment(expired.attemptId, "VCB", "EXPIRED"))
      .resolves.toMatchObject({ status: "CANCELED", failureCode: "QR_EXPIRED" });

    const approved = await provider.startSale(sale("refund"));
    const payment = await provider.completeSandboxPayment(approved.attemptId, "ZALOPAY", "APPROVED");
    const refund = {
      refundId: "refund-1",
      paymentId: payment.providerPaymentId!,
      amount: new Money(1_000n, "USD"),
      idempotencyKey: "refund-key-1",
    };
    const first = await provider.refund(refund);
    const replay = await provider.refund(refund);
    expect(first.status).toBe("SUCCEEDED");
    expect(replay.providerRefundId).toBe(first.providerRefundId);
  });
});
