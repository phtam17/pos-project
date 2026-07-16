import { z } from "zod";

export const identifierSchema = z.string().trim().min(1).max(128);

export const createProductSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(80).default("Other"),
  barcode: z.string().trim().min(1).max(80).nullable().optional(),
  priceMinor: z.string().regex(/^\d+$/).refine((value) => BigInt(value) > 0n, {
    message: "priceMinor must be greater than zero"
  }),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  taxRateBps: z.number().int().min(0).max(100_000).default(0),
  active: z.boolean().default(true)
}).strict();

export const merchantSettingsSchema = z.object({
  merchantName: z.string().trim().min(1).max(120),
  locationName: z.string().trim().min(1).max(120),
  registerName: z.string().trim().min(1).max(120),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  receiptHeader: z.string().trim().max(240).default(""),
  receiptFooter: z.string().trim().max(240).default("Thank you for your purchase."),
  showSkuOnReceipt: z.boolean().default(true),
  discountsEnabled: z.boolean().default(true),
  tipsEnabled: z.boolean().default(true)
}).strict();

export const cartMoneyAdjustmentSchema = z.object({
  amountMinor: z.string().regex(/^\d+$/)
}).strict();

export const addCartLineSchema = z.object({
  productId: identifierSchema,
  quantity: z.number().int().min(1).max(10_000)
}).strict();

export const paymentAttemptSchema = z.object({
  tender: z.enum(["cash", "card", "vietnam_qr"]),
  terminalId: z.string().trim().min(1).max(128).optional()
}).strict().superRefine((value, context) => {
  if (value.tender === "card" && !value.terminalId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["terminalId"],
      message: "terminalId is required for card payments"
    });
  }
});

export const sandboxVietnamQrCompletionSchema = z.object({
  wallet: z.enum(["VCB", "MOMO", "ZALOPAY", "SHOPEEPAY_VN"]),
  outcome: z.enum(["APPROVED", "DECLINED", "EXPIRED"]),
  delayMs: z.number().int().min(0).max(30_000).default(0),
  duplicate: z.boolean().default(false)
}).strict();

export const sandboxVietnamQrScanSchema = z.object({
  wallet: z.enum(["VCB", "MOMO", "ZALOPAY", "SHOPEEPAY_VN"])
}).strict();

export const refundSchema = z.object({
  amountMinor: z.string().regex(/^\d+$/),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const idempotencyKeySchema = z.string().trim().min(8).max(255);
