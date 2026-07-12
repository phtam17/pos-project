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
