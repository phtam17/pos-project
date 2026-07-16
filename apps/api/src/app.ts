import cors from "@fastify/cors";
import {
  ApplicationError,
  PosService,
  type CreateProductCommand
} from "@pos/application";
import { DomainError } from "@pos/domain";
import { PaymentProviderError, type PaymentProvider } from "@pos/payment-contract";
import {
  SimulatedPaymentProvider,
  SimulatedVietnamQrProvider
} from "@pos/payments-simulated";
import {
  PersistenceError,
  createRepository,
  type PosRepository
} from "@pos/persistence";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError, z } from "zod";

import { loadConfig, type ApiConfig } from "./config.js";
import {
  cartDto,
  merchantSettingsDto,
  orderDto,
  paymentAttemptDto,
  paymentDto,
  productDto,
  receiptDto,
  refundDto
} from "./dto.js";
import {
  addCartLineSchema,
  cartMoneyAdjustmentSchema,
  createProductSchema,
  idempotencyKeySchema,
  identifierSchema,
  merchantSettingsSchema,
  paymentAttemptSchema,
  refundSchema,
  sandboxVietnamQrCompletionSchema,
  sandboxVietnamQrScanSchema
} from "./schemas.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Uint8Array;
  }
}

export interface BuildAppOptions {
  readonly config?: ApiConfig;
  readonly repository?: PosRepository;
  readonly paymentProvider?: PaymentProvider;
  readonly paymentProviders?: readonly PaymentProvider[];
  readonly logger?: boolean;
}

const cartIdParams = z.object({ id: identifierSchema });
const cartLineParams = z.object({ id: identifierSchema, lineId: identifierSchema });
const productIdParams = z.object({ id: identifierSchema });
const orderIdParams = z.object({ id: identifierSchema });
const attemptIdParams = z.object({ id: identifierSchema });
const paymentIdParams = z.object({ id: identifierSchema });
const orderStatuses = ["OPEN", "PAYMENT_PENDING", "PAID", "CANCELED", "REFUNDED"] as const;

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const persistenceMode = config.persistenceMode ?? (config.databaseUrl ? "postgres" : "memory");
  const repository = options.repository ?? createRepository({
    // An explicit empty value prevents the persistence factory from falling
    // back to a stale DATABASE_URL when sandbox memory mode is selected.
    databaseUrl: persistenceMode === "postgres" ? config.databaseUrl ?? "" : ""
  });
  const cardProvider = options.paymentProvider ?? new SimulatedPaymentProvider({
    webhookSecret: config.simulatedWebhookSecret
  });
  const sandboxVietnamQrProvider = new SimulatedVietnamQrProvider();
  const providers = options.paymentProviders ?? [cardProvider, sandboxVietnamQrProvider];
  const service = new PosService(repository, providers);
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 1_048_576 });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const buffer = body as Buffer;
      request.rawBody = new Uint8Array(buffer);
      try {
        done(null, JSON.parse(buffer.toString("utf8")) as unknown);
      } catch {
        const error = Object.assign(new SyntaxError("Request body is not valid JSON"), {
          statusCode: 400,
          code: "INVALID_JSON"
        });
        done(error, undefined);
      }
    }
  );

  await app.register(cors, {
    origin: config.corsOrigins.length === 0 ? false : [...config.corsOrigins],
    allowedHeaders: ["Content-Type", "Idempotency-Key", "X-Manager-Id", "X-Manager-Key"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
  });

  app.get("/health", async () => ({
    status: "live",
    paymentProviders: providers.map((provider) => provider.name),
    persistence: persistenceMode,
    timestamp: new Date().toISOString()
  }));

  app.get("/ready", async (_request, reply) => {
    try {
      await repository.healthCheck();
      return { status: "ready", persistence: persistenceMode };
    } catch {
      return reply.code(503).send({
        error: { code: "NOT_READY", message: "Persistence is unavailable" }
      });
    }
  });

  app.get("/v1/payment-capabilities", async () => ({
    providers: providers.map((provider) => ({
      provider: provider.name,
      capabilities: provider.capabilities
    }))
  }));

  app.get("/v1/runtime-status", async () => {
    let persistenceReady = true;
    try {
      await repository.healthCheck();
    } catch {
      persistenceReady = false;
    }
    const cardProviderStatus = providers.find((provider) =>
      provider.capabilities.paymentMethods?.includes("CARD")
    );
    const vietnamQrProviderStatus = providers.find((provider) =>
      provider.capabilities.paymentMethods?.includes("VIETNAM_QR")
    );

    return {
      mode: "sandbox",
      api: { connected: true, ready: true },
      persistence: {
        mode: persistenceMode,
        ready: persistenceReady,
        ephemeral: persistenceMode === "memory"
      },
      simulators: {
        card: {
          ready: cardProviderStatus !== undefined,
          provider: cardProviderStatus?.name ?? null
        },
        vietnamQr: {
          ready: vietnamQrProviderStatus !== undefined,
          provider: vietnamQrProviderStatus?.name ?? null
        }
      },
      warnings: persistenceMode === "memory"
        ? ["Memory mode erases carts, orders, payments, and settings when the API restarts."]
        : [],
      checkedAt: new Date().toISOString()
    };
  });

  app.get("/v1/products", async (request) => {
    const query = z.object({
      search: z.string().trim().max(160).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(500),
      offset: z.coerce.number().int().min(0).default(0),
      includeInactive: z.enum(["true", "false"]).default("false")
    })
      .parse(request.query);
    const products = await service.listProducts(
      query.search,
      query.limit,
      query.offset,
      query.includeInactive !== "true"
    );
    return {
      products: products.map(productDto),
      page: { limit: query.limit, offset: query.offset, returned: products.length }
    };
  });

  app.post("/v1/products", async (request, reply) => {
    const body = createProductSchema.parse(request.body);
    const command: CreateProductCommand = body;
    const product = await service.createProduct(command);
    return reply.code(201).send(productDto(product));
  });

  app.put("/v1/products/:id", async (request) => {
    const { id } = productIdParams.parse(request.params);
    const body = createProductSchema.parse(request.body);
    return productDto(await service.updateProduct({ productId: id, ...body }));
  });

  app.get("/v1/merchant-settings", async () => {
    return merchantSettingsDto(await service.getMerchantSettings());
  });

  app.put("/v1/merchant-settings", async (request) => {
    const body = merchantSettingsSchema.parse(request.body);
    return merchantSettingsDto(await service.updateMerchantSettings(body));
  });

  app.post("/v1/carts", async (request, reply) => {
    const body = z.object({ currency: z.string().trim().length(3).optional() })
      .strict()
      .parse(request.body ?? {});
    const cart = await service.createCart(body.currency?.toUpperCase() ?? "USD");
    return reply.code(201).send(cartDto(cart));
  });

  app.get("/v1/carts/:id", async (request) => {
    const { id } = cartIdParams.parse(request.params);
    return cartDto(await service.getCart(id));
  });

  app.post("/v1/carts/:id/lines", async (request, reply) => {
    const { id } = cartIdParams.parse(request.params);
    const body = addCartLineSchema.parse(request.body);
    const cart = await service.addCartLine(id, body.productId, body.quantity);
    return reply.code(201).send(cartDto(cart));
  });

  app.delete("/v1/carts/:id/lines/:lineId", async (request) => {
    const { id, lineId } = cartLineParams.parse(request.params);
    return cartDto(await service.removeCartLine(id, lineId));
  });

  app.put("/v1/carts/:id/lines/:lineId/discount", async (request) => {
    const { id, lineId } = cartLineParams.parse(request.params);
    const body = cartMoneyAdjustmentSchema.parse(request.body);
    return cartDto(await service.applyCartLineDiscount(id, lineId, body.amountMinor));
  });

  app.put("/v1/carts/:id/tip", async (request) => {
    const { id } = cartIdParams.parse(request.params);
    const body = cartMoneyAdjustmentSchema.parse(request.body);
    return cartDto(await service.setCartTip(id, body.amountMinor));
  });

  app.post("/v1/carts/:id/checkout", async (request, reply) => {
    const { id } = cartIdParams.parse(request.params);
    const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
    const order = await service.checkout(id, idempotencyKey);
    return reply.code(201).send(orderDto(order));
  });

  app.get("/v1/orders", async (request) => {
    const query = z.object({
      search: z.string().trim().max(160).optional(),
      status: z.enum(orderStatuses).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0)
    }).parse(request.query);
    const orders = await service.listOrders(query.search, query.status, query.limit, query.offset);
    return {
      orders: orders.map(orderDto),
      page: { limit: query.limit, offset: query.offset, returned: orders.length }
    };
  });

  app.get("/v1/orders/:id", async (request) => {
    const { id } = orderIdParams.parse(request.params);
    return orderDto(await service.getOrder(id));
  });

  app.get("/v1/orders/:id/sale", async (request) => {
    const { id } = orderIdParams.parse(request.params);
    const [order, payments] = await Promise.all([
      service.getOrder(id),
      service.listPaymentsForOrder(id)
    ]);
    const refundGroups = await Promise.all(
      payments.map((payment) => service.listRefundsForPayment(payment.id))
    );
    const attempts = await Promise.all(
      payments.map((payment) => service.getPaymentAttempt(payment.paymentAttemptId, false))
    );
    return {
      order: orderDto(order),
      payments: payments.map((payment, index) => paymentDto(payment, attempts[index]?.attempt)),
      refunds: refundGroups.flat().map(refundDto)
    };
  });

  app.post("/v1/orders/:id/payment-attempts", async (request, reply) => {
    const { id } = orderIdParams.parse(request.params);
    const body = paymentAttemptSchema.parse(request.body);
    const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
    const result = await service.startPayment({
      orderId: id,
      tender: body.tender,
      ...(body.terminalId ? { terminalId: body.terminalId } : {}),
      idempotencyKey
    });
    if (result.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.code(result.replayed ? 200 : 201).send(
      paymentAttemptDto(result.attempt, result.payment, result.presentation, result.wallet)
    );
  });

  app.get("/v1/payment-attempts/:id", async (request) => {
    const { id } = attemptIdParams.parse(request.params);
    const refresh = z.object({ refresh: z.enum(["true", "false"]).optional() })
      .parse(request.query).refresh !== "false";
    const result = await service.getPaymentAttempt(id, refresh);
    return paymentAttemptDto(result.attempt, result.payment, result.presentation, result.wallet);
  });

  app.post("/v1/payment-attempts/:id/cancel", async (request) => {
    const { id } = attemptIdParams.parse(request.params);
    return paymentAttemptDto(await service.cancelPaymentAttempt(id));
  });

  app.post("/v1/sandbox/vietnam-qr/:id/complete", async (request) => {
    const { id } = attemptIdParams.parse(request.params);
    const body = sandboxVietnamQrCompletionSchema.parse(request.body);
    const provider = providers.find(
      (candidate): candidate is SimulatedVietnamQrProvider => candidate instanceof SimulatedVietnamQrProvider
    );
    if (!provider) {
      throw new ApplicationError("Vietnam QR sandbox is not enabled", "SANDBOX_NOT_ENABLED", 404);
    }
    await provider.completeSandboxPayment(id, body.wallet, body.outcome, {
      delayMs: body.delayMs,
      duplicate: body.duplicate
    });
    const result = await service.getPaymentAttempt(id, true);
    return paymentAttemptDto(result.attempt, result.payment, result.presentation, result.wallet);
  });

  app.post("/v1/sandbox/vietnam-qr/:id/scan", async (request) => {
    const { id } = attemptIdParams.parse(request.params);
    const body = sandboxVietnamQrScanSchema.parse(request.body);
    const provider = providers.find(
      (candidate): candidate is SimulatedVietnamQrProvider => candidate instanceof SimulatedVietnamQrProvider
    );
    if (!provider) {
      throw new ApplicationError("Vietnam QR sandbox is not enabled", "SANDBOX_NOT_ENABLED", 404);
    }
    await provider.openSandboxPayment(id, body.wallet);
    const result = await service.getPaymentAttempt(id, true);
    return paymentAttemptDto(result.attempt, result.payment, result.presentation, result.wallet);
  });

  app.get("/v1/payments/:id", async (request) => {
    const { id } = paymentIdParams.parse(request.params);
    const payment = await service.getPayment(id);
    const attempt = await service.getPaymentAttempt(payment.paymentAttemptId, false);
    return paymentDto(payment, attempt.attempt);
  });

  app.post("/v1/payments/:id/refunds", async (request, reply) => {
    const { id } = paymentIdParams.parse(request.params);
    const body = refundSchema.parse(request.body);
    const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
    const managerId = z.string().trim().min(1).parse(request.headers["x-manager-id"]);
    if (!config.managerApiKey) {
      throw new ApplicationError(
        "Refunds are disabled until MANAGER_API_KEY is configured",
        "REFUNDS_DISABLED",
        503
      );
    }
    if (request.headers["x-manager-key"] !== config.managerApiKey) {
      throw new ApplicationError("Manager authorization failed", "FORBIDDEN", 403);
    }
    const result = await service.refundPayment({
      paymentId: id,
      amountMinor: body.amountMinor,
      reason: body.reason,
      idempotencyKey,
      actorId: managerId
    });
    if (result.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.code(result.replayed ? 200 : 201).send(refundDto(result.refund));
  });

  app.get("/v1/orders/:id/receipt", async (request) => {
    const { id } = orderIdParams.parse(request.params);
    const order = await service.getOrder(id);
    const payments = await service.listPaymentsForOrder(id);
    const attempt = payments[0]
      ? (await service.getPaymentAttempt(payments[0].paymentAttemptId, false)).attempt
      : undefined;
    const refunds = payments[0]
      ? await service.listRefundsForPayment(payments[0].id)
      : [];
    const settings = await service.getMerchantSettings();
    return receiptDto(order, payments[0], refunds, attempt, settings);
  });

  app.post("/v1/providers/simulated/webhooks", async (request, reply) => {
    const rawBody = request.rawBody;
    if (!rawBody) {
      throw new ApplicationError("Webhook raw body is unavailable", "RAW_BODY_REQUIRED", 400);
    }
    const event = await service.verifyWebhook(rawBody, headerRecord(request.headers));
    return reply.code(202).send({ received: true, eventId: event.id });
  });

  app.get("/v1/reconciliation/summary", async (request) => {
    const query = z.object({
      from: z.coerce.date(),
      to: z.coerce.date(),
      currency: z.string().trim().length(3).default("USD"),
      provider: z.string().trim().min(1).optional()
    }).parse(request.query);
    const summary = await service.reconciliationSummary({
      from: query.from,
      to: query.to,
      currency: query.currency.toUpperCase(),
      ...(query.provider ? { provider: query.provider } : {})
    });
    return {
      ...summary,
      capturedGross: summary.capturedGross.toJSON(),
      refunded: summary.refunded.toJSON(),
      netSales: summary.netSales.toJSON(),
      settledGross: summary.settledGross.toJSON(),
      settlementFees: summary.settlementFees.toJSON(),
      settledNet: summary.settledNet.toJSON()
    };
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({
      error: { code: "ROUTE_NOT_FOUND", message: "Route not found" }
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    const mapped = mapError(error);
    if (mapped.status >= 500) request.log.error({ err: error }, mapped.message);
    else request.log.info({ err: error }, mapped.message);
    return reply.code(mapped.status).send({
      error: { code: mapped.code, message: mapped.message }
    });
  });

  app.addHook("onClose", async () => service.close());
  return app;
}

function headerRecord(
  headers: Readonly<Record<string, string | string[] | undefined>>
): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value[0] : value
    ])
  );
}

function mapError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ZodError) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")
    };
  }
  if (error instanceof ApplicationError) {
    return { status: error.httpStatus, code: error.code, message: error.message };
  }
  if (error instanceof DomainError) {
    return { status: 409, code: error.code, message: error.message };
  }
  if (error instanceof PersistenceError) {
    const status = error.code === "REPOSITORY_NOT_FOUND" ? 404 : 409;
    return { status, code: error.code, message: error.message };
  }
  if (error instanceof PaymentProviderError) {
    const status = error.code === "PROVIDER_UNAVAILABLE" ? 503
      : error.code === "IDEMPOTENCY_CONFLICT" || error.code === "OPERATION_NOT_ALLOWED" ? 409
        : error.code === "ATTEMPT_NOT_FOUND" || error.code === "PAYMENT_NOT_FOUND" ? 404
          : error.code === "INVALID_WEBHOOK" || error.code === "INVALID_REQUEST" || error.code === "SENSITIVE_CARD_DATA" ? 400
            : 502;
    return { status, code: error.code, message: error.message };
  }
  if (isPersistenceConnectionError(error)) {
    return {
      status: 503,
      code: "PERSISTENCE_UNAVAILABLE",
      message: "Persistence is unavailable. Start PostgreSQL or set PERSISTENCE_MODE=memory for the sandbox demo."
    };
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    const code = "code" in error && typeof error.code === "string"
      ? error.code
      : "INVALID_REQUEST";
    return {
      status: error.statusCode,
      code,
      message: error instanceof Error ? error.message : "Invalid request"
    };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "An unexpected error occurred" };
}

function isPersistenceConnectionError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  return typeof error.code === "string" && [
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "57P01",
    "57P02",
    "57P03"
  ].includes(error.code);
}
