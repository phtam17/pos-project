import {
  AuditEntry,
  Cart,
  Money,
  Order,
  OutboxMessage,
  Payment,
  PaymentAttempt,
  Product,
  Refund,
  SettlementBatch,
  type CartLineSnapshot,
  type OrderLineSnapshot,
  type SettlementLineSnapshot
} from "@pos/domain";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { decodeAggregate, encodeAggregate } from "./codec.js";
import {
  IdempotencyConflictError,
  PersistenceError,
  RepositoryConflictError,
  RepositoryNotFoundError
} from "./errors.js";
import type {
  AuditQuery,
  IdempotencyClaim,
  IdempotencyRecord,
  PosRepository,
  ProductQuery,
  ReconciliationQuery,
  ReconciliationSummary
} from "./repository.js";

interface SnapshotRow extends QueryResultRow {
  snapshot: unknown;
}

interface IdempotencyRow extends QueryResultRow {
  scope: string;
  key: string;
  request_hash: string;
  state: IdempotencyRecord["state"];
  response_status: number | null;
  response_body: unknown | null;
  resource_id: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

interface SummaryRow extends QueryResultRow {
  count: string;
  amount: string;
}

interface SettlementSummaryRow extends QueryResultRow {
  gross: string;
  fees: string;
  net: string;
}

interface IdRow extends QueryResultRow {
  id: string;
}

export interface PostgresPosRepositoryOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly maxConnections?: number;
}

function minor(money: Money): string {
  return money.minorUnits.toString();
}

function mapIdempotency(row: IdempotencyRow): IdempotencyRecord {
  return Object.freeze({
    scope: row.scope,
    key: row.key,
    requestHash: row.request_hash,
    state: row.state,
    ...(row.response_status === null ? {} : { responseStatus: row.response_status }),
    ...(row.response_body === null ? {} : { responseBody: row.response_body }),
    ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    expiresAt: new Date(row.expires_at)
  });
}

function isPgError(error: unknown): error is { code?: string; constraint?: string } {
  return error !== null && typeof error === "object" && "code" in error;
}

function translateWriteError(error: unknown, entity: string, id: string): never {
  if (isPgError(error) && error.code === "23505") {
    throw new RepositoryConflictError(entity, id, { cause: error });
  }
  if (isPgError(error) && error.code === "23503") {
    throw new PersistenceError(
      `${entity} ${id} references an entity that does not exist`,
      "REFERENCE_NOT_FOUND",
      { cause: error }
    );
  }
  throw error;
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresPosRepository implements PosRepository {
  readonly pool: Pool;
  private readonly ownsPool: boolean;

  async healthCheck(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  constructor(options: PostgresPosRepositoryOptions) {
    const connectionString = options.connectionString;
    if (!options.pool && !connectionString) {
      throw new TypeError("PostgresPosRepository requires a pool or connectionString");
    }
    this.pool =
      options.pool ??
      new Pool({
        connectionString: connectionString!,
        max: options.maxConnections ?? 10
      });
    this.ownsPool = options.pool === undefined;
  }

  async listProducts(query: ProductQuery = {}): Promise<readonly Product[]> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (query.activeOnly) conditions.push("active = true");
    if (query.search?.trim()) {
      values.push(`%${query.search.trim()}%`);
      conditions.push(`(name ILIKE $${values.length} OR sku ILIKE $${values.length})`);
    }
    values.push(Math.max(0, query.limit ?? 500));
    const limit = `$${values.length}`;
    values.push(Math.max(0, query.offset ?? 0));
    const offset = `$${values.length}`;
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<SnapshotRow>(
      `SELECT snapshot FROM products ${where} ORDER BY name, id LIMIT ${limit} OFFSET ${offset}`,
      values
    );
    return result.rows.map((row) => decodeAggregate(row.snapshot, Product));
  }

  async getProduct(id: string): Promise<Product | undefined> {
    return this.getAggregate("products", id, Product);
  }

  async createProduct(product: Product): Promise<Product> {
    try {
      await this.pool.query(
        `INSERT INTO products
          (id, sku, name, unit_price_minor, currency, tax_rate_bps, active, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          product.id,
          product.sku,
          product.name,
          minor(product.unitPrice),
          product.unitPrice.currency,
          product.taxRateBps,
          product.active,
          encodeAggregate(product)
        ]
      );
      return Product.rehydrate(product.toSnapshot());
    } catch (error) {
      translateWriteError(error, "Product", product.id);
    }
  }

  async createCart(cart: Cart): Promise<Cart> {
    try {
      await inTransaction(this.pool, async (client) => {
        const snapshot = cart.toSnapshot();
        await client.query(
          `INSERT INTO carts (id, status, currency, version, snapshot, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            cart.id,
            snapshot.status,
            cart.currency,
            snapshot.version,
            encodeAggregate(cart),
            snapshot.createdAt,
            snapshot.updatedAt
          ]
        );
        await this.insertCartLines(client, cart.id, snapshot.lines);
      });
      return Cart.rehydrate(cart.toSnapshot());
    } catch (error) {
      translateWriteError(error, "Cart", cart.id);
    }
  }

  async getCart(id: string): Promise<Cart | undefined> {
    return this.getAggregate("carts", id, Cart);
  }

  async saveCart(cart: Cart, expectedVersion?: number): Promise<Cart> {
    try {
      await inTransaction(this.pool, async (client) => {
        const snapshot = cart.toSnapshot();
        const values: unknown[] = [
          cart.id,
          cart.currency,
          encodeAggregate(cart),
          snapshot.updatedAt,
          snapshot.version,
          snapshot.status
        ];
        const versionCondition =
          expectedVersion === undefined
            ? ""
            : (values.push(expectedVersion), ` AND version = $${values.length}`);
        const result = await client.query(
          `UPDATE carts
             SET currency = $2, snapshot = $3, updated_at = $4, version = $5,
                 status = $6
           WHERE id = $1${versionCondition}`,
          values
        );
        if (!result.rowCount) {
          const exists = await client.query("SELECT 1 FROM carts WHERE id = $1", [cart.id]);
          if (exists.rowCount) throw new RepositoryConflictError("Cart", cart.id);
          throw new RepositoryNotFoundError("Cart", cart.id);
        }
        await client.query("DELETE FROM cart_lines WHERE cart_id = $1", [cart.id]);
        await this.insertCartLines(client, cart.id, snapshot.lines);
      });
      return Cart.rehydrate(cart.toSnapshot());
    } catch (error) {
      if (error instanceof RepositoryConflictError || error instanceof RepositoryNotFoundError) {
        throw error;
      }
      translateWriteError(error, "Cart", cart.id);
    }
  }

  async createOrder(order: Order): Promise<Order> {
    try {
      await inTransaction(this.pool, async (client) => {
        const snapshot = order.toSnapshot();
        await client.query(
          `INSERT INTO orders
            (id, order_number, cart_id, status, currency, subtotal_minor,
             discount_minor, tax_minor, total_minor, version, snapshot,
             created_at, updated_at, completed_at)
           VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            order.id,
            snapshot.cartId,
            snapshot.status,
            snapshot.currency,
            minor(snapshot.subtotal),
            minor(snapshot.discountTotal),
            minor(snapshot.taxTotal),
            minor(snapshot.total),
            snapshot.version,
            encodeAggregate(order),
            snapshot.createdAt,
            snapshot.updatedAt,
            ["PAID", "CANCELED", "REFUNDED"].includes(snapshot.status)
              ? snapshot.updatedAt
              : null
          ]
        );
        await this.insertOrderLines(client, order.id, snapshot.lines);
      });
      return Order.rehydrate(order.toSnapshot());
    } catch (error) {
      translateWriteError(error, "Order", order.id);
    }
  }

  async getOrder(id: string): Promise<Order | undefined> {
    return this.getAggregate("orders", id, Order);
  }

  async findOrderByCartId(cartId: string): Promise<Order | undefined> {
    const result = await this.pool.query<SnapshotRow>(
      "SELECT snapshot FROM orders WHERE cart_id = $1",
      [cartId]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeAggregate(row.snapshot, Order);
  }

  async saveOrder(order: Order, expectedVersion?: number): Promise<Order> {
    const snapshot = order.toSnapshot();
    const values: unknown[] = [
      order.id,
      snapshot.status,
      snapshot.version,
      encodeAggregate(order),
      snapshot.updatedAt,
      ["PAID", "CANCELED", "REFUNDED"].includes(snapshot.status)
        ? snapshot.updatedAt
        : null
    ];
    const versionCondition =
      expectedVersion === undefined
        ? ""
        : (values.push(expectedVersion), ` AND version = $${values.length}`);
    try {
      const result = await this.pool.query(
        `UPDATE orders
            SET status = $2, version = $3, snapshot = $4, updated_at = $5,
                completed_at = $6
          WHERE id = $1${versionCondition}`,
        values
      );
      await this.assertUpdated(result.rowCount, "Order", order.id, expectedVersion !== undefined);
      return Order.rehydrate(snapshot);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      translateWriteError(error, "Order", order.id);
    }
  }

  async createPaymentAttempt(attempt: PaymentAttempt): Promise<PaymentAttempt> {
    const snapshot = attempt.toSnapshot();
    try {
      await this.pool.query(
        `INSERT INTO payment_attempts
          (id, order_id, provider, provider_reference, terminal_id, status,
           amount_minor, currency, idempotency_key, failure_code, version,
           snapshot, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          snapshot.id,
          snapshot.orderId,
          snapshot.provider,
          snapshot.providerReference,
          snapshot.terminalId,
          snapshot.status,
          minor(snapshot.amount),
          snapshot.amount.currency,
          snapshot.idempotencyKey,
          snapshot.failureCode,
          snapshot.version,
          encodeAggregate(attempt),
          snapshot.createdAt,
          snapshot.updatedAt
        ]
      );
      return PaymentAttempt.rehydrate(snapshot);
    } catch (error) {
      translateWriteError(error, "PaymentAttempt", attempt.id);
    }
  }

  async reservePaymentAttempt(
    order: Order,
    attempt: PaymentAttempt,
    expectedOrderVersion: number
  ): Promise<PaymentAttempt> {
    const orderSnapshot = order.toSnapshot();
    const attemptSnapshot = attempt.toSnapshot();
    try {
      await inTransaction(this.pool, async (client) => {
        const orderResult = await client.query(
          `UPDATE orders
              SET status = $2, version = $3, snapshot = $4, updated_at = $5,
                  completed_at = NULL
            WHERE id = $1 AND version = $6`,
          [
            order.id,
            orderSnapshot.status,
            orderSnapshot.version,
            encodeAggregate(order),
            orderSnapshot.updatedAt,
            expectedOrderVersion
          ]
        );
        if (!orderResult.rowCount) {
          const exists = await client.query("SELECT 1 FROM orders WHERE id = $1", [order.id]);
          if (exists.rowCount) throw new RepositoryConflictError("Order", order.id);
          throw new RepositoryNotFoundError("Order", order.id);
        }

        await client.query(
          `INSERT INTO payment_attempts
            (id, order_id, provider, provider_reference, terminal_id, status,
             amount_minor, currency, idempotency_key, failure_code, version,
             snapshot, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            attemptSnapshot.id,
            attemptSnapshot.orderId,
            attemptSnapshot.provider,
            attemptSnapshot.providerReference,
            attemptSnapshot.terminalId,
            attemptSnapshot.status,
            minor(attemptSnapshot.amount),
            attemptSnapshot.amount.currency,
            attemptSnapshot.idempotencyKey,
            attemptSnapshot.failureCode,
            attemptSnapshot.version,
            encodeAggregate(attempt),
            attemptSnapshot.createdAt,
            attemptSnapshot.updatedAt
          ]
        );
      });
      return PaymentAttempt.rehydrate(attemptSnapshot);
    } catch (error) {
      if (error instanceof RepositoryConflictError || error instanceof RepositoryNotFoundError) {
        throw error;
      }
      translateWriteError(error, "PaymentAttempt", attempt.id);
    }
  }

  async getPaymentAttempt(id: string): Promise<PaymentAttempt | undefined> {
    return this.getAggregate("payment_attempts", id, PaymentAttempt);
  }

  async savePaymentAttempt(
    attempt: PaymentAttempt,
    expectedVersion?: number
  ): Promise<PaymentAttempt> {
    const snapshot = attempt.toSnapshot();
    const values: unknown[] = [
      snapshot.id,
      snapshot.providerReference,
      snapshot.status,
      snapshot.failureCode,
      snapshot.version,
      encodeAggregate(attempt),
      snapshot.updatedAt
    ];
    const versionCondition =
      expectedVersion === undefined
        ? ""
        : (values.push(expectedVersion), ` AND version = $${values.length}`);
    try {
      const result = await this.pool.query(
        `UPDATE payment_attempts
            SET provider_reference = $2, status = $3, failure_code = $4,
                version = $5, snapshot = $6, updated_at = $7
          WHERE id = $1${versionCondition}`,
        values
      );
      await this.assertUpdated(
        result.rowCount,
        "PaymentAttempt",
        attempt.id,
        expectedVersion !== undefined
      );
      return PaymentAttempt.rehydrate(snapshot);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      translateWriteError(error, "PaymentAttempt", attempt.id);
    }
  }

  async createPayment(payment: Payment): Promise<Payment> {
    const snapshot = payment.toSnapshot();
    try {
      await this.pool.query(
        `INSERT INTO payments
          (id, order_id, attempt_id, provider, provider_payment_id, status,
           amount_minor, currency, card_brand, card_last4, entry_method,
           snapshot, captured_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'CAPTURED', $6, $7, $8, $9, $10, $11, $12, $12)`,
        [
          snapshot.id,
          snapshot.orderId,
          snapshot.paymentAttemptId,
          snapshot.provider,
          snapshot.providerReference,
          minor(snapshot.amount),
          snapshot.amount.currency,
          snapshot.card?.brand ?? null,
          snapshot.card?.last4 ?? null,
          snapshot.card?.entryMethod ?? null,
          encodeAggregate(payment),
          snapshot.capturedAt
        ]
      );
      return Payment.rehydrate(snapshot);
    } catch (error) {
      translateWriteError(error, "Payment", payment.id);
    }
  }

  async getPayment(id: string): Promise<Payment | undefined> {
    return this.getAggregate("payments", id, Payment);
  }

  async findPaymentByProviderReference(
    provider: string,
    providerReference: string
  ): Promise<Payment | undefined> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT snapshot FROM payments
        WHERE provider = $1 AND provider_payment_id = $2`,
      [provider, providerReference]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeAggregate(row.snapshot, Payment);
  }

  async listPaymentsForOrder(orderId: string): Promise<readonly Payment[]> {
    const result = await this.pool.query<SnapshotRow>(
      "SELECT snapshot FROM payments WHERE order_id = $1 ORDER BY captured_at, id",
      [orderId]
    );
    return result.rows.map((row) => decodeAggregate(row.snapshot, Payment));
  }

  async createRefund(refund: Refund): Promise<Refund> {
    const snapshot = refund.toSnapshot();
    try {
      await this.pool.query(
        `INSERT INTO refunds
          (id, payment_id, provider, provider_refund_id, status, amount_minor,
           currency, idempotency_key, failure_code, version, snapshot,
           created_at, updated_at, processed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          snapshot.id,
          snapshot.paymentId,
          snapshot.provider,
          snapshot.providerReference,
          snapshot.status,
          minor(snapshot.amount),
          snapshot.amount.currency,
          snapshot.idempotencyKey,
          snapshot.failureCode,
          snapshot.version,
          encodeAggregate(refund),
          snapshot.createdAt,
          snapshot.updatedAt,
          snapshot.status === "PENDING" ? null : snapshot.updatedAt
        ]
      );
      return Refund.rehydrate(snapshot);
    } catch (error) {
      translateWriteError(error, "Refund", refund.id);
    }
  }

  async reserveRefund(refund: Refund): Promise<Refund> {
    const snapshot = refund.toSnapshot();
    try {
      return await inTransaction(this.pool, async (client) => {
        const paymentResult = await client.query<
          QueryResultRow & { amount_minor: string; currency: string }
        >(
          "SELECT amount_minor::text, currency FROM payments WHERE id = $1 FOR UPDATE",
          [snapshot.paymentId]
        );
        const payment = paymentResult.rows[0];
        if (!payment) throw new RepositoryNotFoundError("Payment", snapshot.paymentId);
        if (payment.currency !== snapshot.amount.currency) {
          throw new RepositoryConflictError("Refund currency", snapshot.paymentId);
        }
        const reservedResult = await client.query<QueryResultRow & { amount: string }>(
          `SELECT COALESCE(sum(amount_minor), 0)::text AS amount
             FROM refunds
            WHERE payment_id = $1 AND status IN ('PENDING', 'SUCCEEDED')`,
          [snapshot.paymentId]
        );
        const reserved = BigInt(reservedResult.rows[0]?.amount ?? "0");
        if (reserved + snapshot.amount.minorUnits > BigInt(payment.amount_minor)) {
          throw new RepositoryConflictError("Refund capacity", snapshot.paymentId);
        }
        await client.query(
          `INSERT INTO refunds
            (id, payment_id, provider, provider_refund_id, status, amount_minor,
             currency, idempotency_key, failure_code, version, snapshot,
             created_at, updated_at, processed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            snapshot.id,
            snapshot.paymentId,
            snapshot.provider,
            snapshot.providerReference,
            snapshot.status,
            minor(snapshot.amount),
            snapshot.amount.currency,
            snapshot.idempotencyKey,
            snapshot.failureCode,
            snapshot.version,
            encodeAggregate(refund),
            snapshot.createdAt,
            snapshot.updatedAt,
            null
          ]
        );
        return Refund.rehydrate(snapshot);
      });
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      translateWriteError(error, "Refund", refund.id);
    }
  }

  async saveRefund(refund: Refund, expectedVersion?: number): Promise<Refund> {
    const snapshot = refund.toSnapshot();
    const values: unknown[] = [
      snapshot.id,
      snapshot.providerReference,
      snapshot.status,
      snapshot.failureCode,
      snapshot.version,
      encodeAggregate(refund),
      snapshot.updatedAt,
      snapshot.status === "PENDING" ? null : snapshot.updatedAt
    ];
    const versionCondition =
      expectedVersion === undefined
        ? ""
        : (values.push(expectedVersion), ` AND version = $${values.length}`);
    try {
      const result = await this.pool.query(
        `UPDATE refunds
            SET provider_refund_id = $2, status = $3, failure_code = $4,
                version = $5, snapshot = $6, updated_at = $7, processed_at = $8
          WHERE id = $1${versionCondition}`,
        values
      );
      await this.assertUpdated(result.rowCount, "Refund", refund.id, expectedVersion !== undefined);
      return Refund.rehydrate(snapshot);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      translateWriteError(error, "Refund", refund.id);
    }
  }

  async listRefundsForPayment(paymentId: string): Promise<readonly Refund[]> {
    const result = await this.pool.query<SnapshotRow>(
      "SELECT snapshot FROM refunds WHERE payment_id = $1 ORDER BY created_at, id",
      [paymentId]
    );
    return result.rows.map((row) => decodeAggregate(row.snapshot, Refund));
  }

  async findRefundByProviderReference(
    provider: string,
    providerReference: string
  ): Promise<Refund | undefined> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT snapshot FROM refunds
        WHERE provider = $1 AND provider_refund_id = $2`,
      [provider, providerReference]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeAggregate(row.snapshot, Refund);
  }

  async getIdempotency(
    scope: string,
    key: string
  ): Promise<IdempotencyRecord | undefined> {
    const result = await this.pool.query<IdempotencyRow>(
      "SELECT * FROM idempotency_records WHERE scope = $1 AND key = $2",
      [scope, key]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapIdempotency(row);
  }

  async claimIdempotency(record: IdempotencyRecord): Promise<IdempotencyClaim> {
    const inserted = await this.pool.query<IdempotencyRow>(
      `INSERT INTO idempotency_records
        (scope, key, request_hash, state, response_status, response_body,
         resource_id, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (scope, key) DO NOTHING
       RETURNING *`,
      [
        record.scope,
        record.key,
        record.requestHash,
        record.state,
        record.responseStatus ?? null,
        record.responseBody ?? null,
        record.resourceId ?? null,
        record.createdAt,
        record.updatedAt,
        record.expiresAt
      ]
    );
    const claimed = inserted.rows[0];
    if (claimed) return { record: mapIdempotency(claimed), claimed: true };

    const existing = await this.getIdempotency(record.scope, record.key);
    if (!existing || existing.requestHash !== record.requestHash) {
      throw new IdempotencyConflictError(record.scope, record.key);
    }
    return { record: existing, claimed: false };
  }

  async saveIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    const responseStatus = record.responseStatus ?? null;
    const responseBody = record.responseBody ?? null;
    const resourceId = record.resourceId ?? null;
    const result = await this.pool.query<IdempotencyRow>(
      `INSERT INTO idempotency_records
        (scope, key, request_hash, state, response_status, response_body,
         resource_id, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (scope, key) DO UPDATE SET
         state = EXCLUDED.state,
         response_status = EXCLUDED.response_status,
         response_body = EXCLUDED.response_body,
         resource_id = EXCLUDED.resource_id,
         updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at
       WHERE idempotency_records.request_hash = EXCLUDED.request_hash
       RETURNING *`,
      [
        record.scope,
        record.key,
        record.requestHash,
        record.state,
        responseStatus,
        responseBody,
        resourceId,
        record.createdAt,
        record.updatedAt,
        record.expiresAt
      ]
    );
    const saved = result.rows[0];
    if (!saved) throw new IdempotencyConflictError(record.scope, record.key);
    return mapIdempotency(saved);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    const snapshot = entry.toSnapshot();
    try {
      await this.pool.query(
        `INSERT INTO audit_events
          (id, aggregate_type, aggregate_id, action, actor_id, details, snapshot, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          snapshot.id,
          snapshot.aggregateType,
          snapshot.aggregateId,
          snapshot.action,
          snapshot.actorId,
          snapshot.metadata,
          encodeAggregate(entry),
          snapshot.occurredAt
        ]
      );
    } catch (error) {
      translateWriteError(error, "AuditEntry", entry.id);
    }
  }

  async listAudit(query: AuditQuery = {}): Promise<readonly AuditEntry[]> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (query.aggregateType !== undefined) {
      values.push(query.aggregateType);
      conditions.push(`aggregate_type = $${values.length}`);
    }
    if (query.aggregateId !== undefined) {
      values.push(query.aggregateId);
      conditions.push(`aggregate_id = $${values.length}`);
    }
    values.push(Math.max(0, query.limit ?? 100));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query<SnapshotRow>(
      `SELECT snapshot FROM audit_events ${where}
       ORDER BY occurred_at DESC, id DESC LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => decodeAggregate(row.snapshot, AuditEntry));
  }

  async enqueueOutbox(message: OutboxMessage): Promise<void> {
    const snapshot = message.toSnapshot();
    try {
      await this.pool.query(
        `INSERT INTO outbox_events
          (id, aggregate_type, aggregate_id, event_type, payload, snapshot,
           occurred_at, published_at, attempts, last_error)
         VALUES ($1, 'DOMAIN', $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          snapshot.id,
          snapshot.aggregateId,
          snapshot.topic,
          snapshot.payload,
          encodeAggregate(message),
          snapshot.occurredAt,
          snapshot.publishedAt,
          snapshot.attempts,
          snapshot.lastError
        ]
      );
    } catch (error) {
      translateWriteError(error, "OutboxMessage", message.id);
    }
  }

  async listPendingOutbox(
    limit = 100,
    now = new Date()
  ): Promise<readonly OutboxMessage[]> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT snapshot FROM outbox_events
        WHERE published_at IS NULL AND (locked_until IS NULL OR locked_until <= $1)
        ORDER BY occurred_at, id
        LIMIT $2`,
      [now, Math.max(0, limit)]
    );
    return result.rows.map((row) => decodeAggregate(row.snapshot, OutboxMessage));
  }

  async claimPendingOutbox(
    limit = 100,
    now = new Date(),
    lockedUntil = new Date(now.getTime() + 30_000)
  ): Promise<readonly OutboxMessage[]> {
    const result = await this.pool.query<SnapshotRow>(
      `WITH candidates AS (
         SELECT id FROM outbox_events
          WHERE published_at IS NULL AND (locked_until IS NULL OR locked_until <= $1)
          ORDER BY occurred_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE outbox_events AS events
          SET locked_until = $3
         FROM candidates
        WHERE events.id = candidates.id
       RETURNING events.snapshot`,
      [now, Math.max(0, limit), lockedUntil]
    );
    return result.rows.map((row) => decodeAggregate(row.snapshot, OutboxMessage));
  }

  async markOutboxPublished(id: string, publishedAt = new Date()): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      const result = await client.query<SnapshotRow & { published_at: Date | null }>(
        "SELECT snapshot, published_at FROM outbox_events WHERE id = $1 FOR UPDATE",
        [id]
      );
      const row = result.rows[0];
      if (!row) throw new RepositoryNotFoundError("OutboxMessage", id);
      if (row.published_at !== null) return;
      const message = decodeAggregate(row.snapshot, OutboxMessage);
      message.markPublished(publishedAt);
      const snapshot = message.toSnapshot();
      await client.query(
        `UPDATE outbox_events
            SET published_at = $2, attempts = $3, last_error = NULL,
                locked_until = NULL, snapshot = $4
          WHERE id = $1`,
        [id, snapshot.publishedAt, snapshot.attempts, encodeAggregate(message)]
      );
    });
  }

  async markOutboxFailed(
    id: string,
    error: string,
    retryAt = new Date(Date.now() + 30_000)
  ): Promise<void> {
    await inTransaction(this.pool, async (client) => {
      const result = await client.query<SnapshotRow>(
        "SELECT snapshot FROM outbox_events WHERE id = $1 FOR UPDATE",
        [id]
      );
      const row = result.rows[0];
      if (!row) throw new RepositoryNotFoundError("OutboxMessage", id);
      const message = decodeAggregate(row.snapshot, OutboxMessage);
      message.markFailed(error);
      await client.query(
        `UPDATE outbox_events
            SET attempts = $2, last_error = $3, locked_until = $4, snapshot = $5
          WHERE id = $1`,
        [id, message.attempts, message.lastError, retryAt, encodeAggregate(message)]
      );
    });
  }

  async createSettlementBatch(batch: SettlementBatch): Promise<SettlementBatch> {
    const snapshot = batch.toSnapshot();
    let gross = Money.zero(snapshot.currency);
    let fees = Money.zero(snapshot.currency);
    let refundAmount = Money.zero(snapshot.currency);
    for (const line of snapshot.lines) {
      gross = gross.add(line.grossAmount);
      fees = fees.add(line.feeAmount);
      if (line.kind === "REFUND") {
        refundAmount = refundAmount.add(
          line.grossAmount.isNegative()
            ? Money.zero(snapshot.currency).subtract(line.grossAmount)
            : line.grossAmount
        );
      }
    }
    try {
      await inTransaction(this.pool, async (client) => {
        await client.query(
          `INSERT INTO settlement_batches
            (id, provider, provider_batch_id, status, currency, gross_minor,
             fee_minor, refund_minor, net_minor, period_start, period_end,
             snapshot, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            snapshot.id,
            snapshot.provider,
            snapshot.providerBatchReference,
            snapshot.status,
            snapshot.currency,
            minor(gross),
            minor(fees),
            minor(refundAmount),
            minor(snapshot.payoutAmount),
            snapshot.periodStart,
            snapshot.periodEnd,
            encodeAggregate(batch),
            snapshot.createdAt
          ]
        );
        await this.insertSettlementLines(client, snapshot.lines);
      });
      return SettlementBatch.rehydrate(snapshot);
    } catch (error) {
      translateWriteError(error, "SettlementBatch", batch.id);
    }
  }

  async getSettlementBatch(id: string): Promise<SettlementBatch | undefined> {
    return this.getAggregate("settlement_batches", id, SettlementBatch);
  }

  async hasSettlementLine(id: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM settlement_lines WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async reconciliationSummary(
    query: ReconciliationQuery
  ): Promise<ReconciliationSummary> {
    const currency = query.currency.toUpperCase();
    const params = [
      query.from,
      query.to,
      currency,
      query.provider ?? null,
      query.locationId ?? null
    ];
    const paymentFilter = `
      p.captured_at >= $1 AND p.captured_at < $2 AND p.currency = $3
      AND ($4::text IS NULL OR p.provider = $4)
      AND ($5::text IS NULL OR o.location_id = $5)`;
    const refundFilter = `
      r.updated_at >= $1 AND r.updated_at < $2 AND r.currency = $3
      AND r.status = 'SUCCEEDED'
      AND ($4::text IS NULL OR r.provider = $4)
      AND ($5::text IS NULL OR o.location_id = $5)`;
    const [paymentResult, refundResult, settlementResult, paymentsMissing, refundsMissing] =
      await Promise.all([
        this.pool.query<SummaryRow>(
          `SELECT count(*)::text AS count,
                  COALESCE(sum(p.amount_minor), 0)::text AS amount
             FROM payments p JOIN orders o ON o.id = p.order_id
            WHERE ${paymentFilter} AND p.status <> 'VOIDED'`,
          params
        ),
        this.pool.query<SummaryRow>(
          `SELECT count(*)::text AS count,
                  COALESCE(sum(r.amount_minor), 0)::text AS amount
             FROM refunds r
             JOIN payments p ON p.id = r.payment_id
             JOIN orders o ON o.id = p.order_id
            WHERE ${refundFilter}`,
          params
        ),
        this.pool.query<SettlementSummaryRow>(
          `SELECT COALESCE(sum(sl.gross_minor), 0)::text AS gross,
                  COALESCE(sum(sl.fee_minor), 0)::text AS fees,
                  COALESCE(sum(sl.net_minor), 0)::text AS net
             FROM settlement_lines sl
             JOIN settlement_batches sb ON sb.id = sl.batch_id
             LEFT JOIN payments settled_payment ON settled_payment.id = sl.payment_id
             LEFT JOIN refunds settled_refund ON settled_refund.id = sl.refund_id
             LEFT JOIN payments refund_payment ON refund_payment.id = settled_refund.payment_id
             LEFT JOIN orders settled_order
               ON settled_order.id = COALESCE(settled_payment.order_id, refund_payment.order_id)
            WHERE sl.occurred_at >= $1 AND sl.occurred_at < $2
              AND sb.currency = $3
              AND ($4::text IS NULL OR sb.provider = $4)
              AND ($5::text IS NULL OR settled_order.location_id = $5)`,
          params
        ),
        this.pool.query<IdRow>(
          `SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id
            WHERE ${paymentFilter} AND p.status <> 'VOIDED'
              AND NOT EXISTS (
                SELECT 1
                  FROM settlement_lines sl
                  JOIN settlement_batches sb ON sb.id = sl.batch_id
                 WHERE sl.payment_id = p.id
                   AND sl.occurred_at >= $1 AND sl.occurred_at < $2
                   AND sb.currency = $3
                   AND ($4::text IS NULL OR sb.provider = $4)
              ) ORDER BY p.id`,
          params
        ),
        this.pool.query<IdRow>(
          `SELECT r.id
             FROM refunds r
             JOIN payments p ON p.id = r.payment_id
             JOIN orders o ON o.id = p.order_id
            WHERE ${refundFilter}
              AND NOT EXISTS (
                SELECT 1
                  FROM settlement_lines sl
                  JOIN settlement_batches sb ON sb.id = sl.batch_id
                 WHERE sl.refund_id = r.id
                   AND sl.occurred_at >= $1 AND sl.occurred_at < $2
                   AND sb.currency = $3
                   AND ($4::text IS NULL OR sb.provider = $4)
              ) ORDER BY r.id`,
          params
        )
      ]);

    const payment = paymentResult.rows[0] ?? { count: "0", amount: "0" };
    const refund = refundResult.rows[0] ?? { count: "0", amount: "0" };
    const settlement = settlementResult.rows[0] ?? { gross: "0", fees: "0", net: "0" };
    const capturedGross = Money.fromMinor(BigInt(payment.amount), currency);
    const refunded = Money.fromMinor(BigInt(refund.amount), currency);
    return Object.freeze({
      from: new Date(query.from),
      to: new Date(query.to),
      currency,
      capturedPaymentCount: Number(payment.count),
      capturedGross,
      succeededRefundCount: Number(refund.count),
      refunded,
      netSales: capturedGross.subtract(refunded),
      settledGross: Money.fromMinor(BigInt(settlement.gross), currency),
      settlementFees: Money.fromMinor(BigInt(settlement.fees), currency),
      settledNet: Money.fromMinor(BigInt(settlement.net), currency),
      unreconciledPaymentIds: Object.freeze(paymentsMissing.rows.map((row) => row.id)),
      unreconciledRefundIds: Object.freeze(refundsMissing.rows.map((row) => row.id))
    });
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async getAggregate<T>(
    table: string,
    id: string,
    rehydrator: { rehydrate(snapshot: never): T }
  ): Promise<T | undefined> {
    const allowedTables = new Set([
      "products",
      "carts",
      "orders",
      "payment_attempts",
      "payments",
      "settlement_batches"
    ]);
    if (!allowedTables.has(table)) throw new TypeError(`Unsupported repository table: ${table}`);
    const result = await this.pool.query<SnapshotRow>(
      `SELECT snapshot FROM ${table} WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decodeAggregate(row.snapshot, rehydrator);
  }

  private async assertUpdated(
    rowCount: number | null,
    entity: string,
    id: string,
    optimistic: boolean
  ): Promise<void> {
    if (rowCount) return;
    const tables: Record<string, string> = {
      Order: "orders",
      PaymentAttempt: "payment_attempts",
      Refund: "refunds"
    };
    const table = tables[entity];
    if (!table) throw new PersistenceError(`Unknown aggregate ${entity}`, "INTERNAL_ERROR");
    const exists = await this.pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (exists.rowCount && optimistic) throw new RepositoryConflictError(entity, id);
    throw new RepositoryNotFoundError(entity, id);
  }

  private async insertCartLines(
    client: PoolClient,
    cartId: string,
    lines: readonly CartLineSnapshot[]
  ): Promise<void> {
    for (const line of lines) {
      await client.query(
        `INSERT INTO cart_lines
          (id, cart_id, product_id, sku, name, quantity, unit_price_minor,
           currency, tax_rate_bps, discount_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          line.id,
          cartId,
          line.productId,
          line.sku,
          line.name,
          line.quantity,
          minor(line.unitPrice),
          line.unitPrice.currency,
          line.taxRateBps,
          minor(line.discount)
        ]
      );
    }
  }

  private async insertOrderLines(
    client: PoolClient,
    orderId: string,
    lines: readonly OrderLineSnapshot[]
  ): Promise<void> {
    for (const line of lines) {
      await client.query(
        `INSERT INTO order_lines
          (id, order_id, product_id, sku, name, quantity, unit_price_minor,
           currency, tax_rate_bps, discount_minor, line_subtotal_minor,
           line_tax_minor, line_total_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          line.lineId,
          orderId,
          line.productId,
          line.sku,
          line.name,
          line.quantity,
          minor(line.unitPrice),
          line.unitPrice.currency,
          line.taxRateBps,
          minor(line.discount),
          minor(line.subtotal),
          minor(line.tax),
          minor(line.total)
        ]
      );
    }
  }

  private async insertSettlementLines(
    client: PoolClient,
    lines: readonly SettlementLineSnapshot[]
  ): Promise<void> {
    for (const line of lines) {
      await client.query(
        `INSERT INTO settlement_lines
          (id, batch_id, payment_id, refund_id, provider_transaction_id,
           kind, gross_minor, fee_minor, net_minor, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          line.id,
          line.batchId,
          line.paymentId,
          line.refundId,
          line.providerReference,
          line.kind,
          minor(line.grossAmount),
          minor(line.feeAmount),
          minor(line.netAmount),
          line.occurredAt
        ]
      );
    }
  }
}
