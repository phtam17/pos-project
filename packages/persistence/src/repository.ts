import type {
  AuditEntry,
  Cart,
  MerchantSettings,
  Order,
  OutboxMessage,
  Payment,
  PaymentAttempt,
  Product,
  Refund,
  SettlementBatch,
  OrderStatus
} from "@pos/domain";
import { Money } from "@pos/domain";

export type IdempotencyState = "IN_PROGRESS" | "COMPLETED" | "FAILED";

export interface IdempotencyRecord {
  readonly scope: string;
  readonly key: string;
  readonly requestHash: string;
  readonly state: IdempotencyState;
  readonly responseStatus?: number;
  readonly responseBody?: unknown;
  readonly resourceId?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
}

export interface IdempotencyClaim {
  readonly record: IdempotencyRecord;
  readonly claimed: boolean;
}

export interface ProductQuery {
  readonly activeOnly?: boolean;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface OrderQuery {
  readonly search?: string;
  readonly status?: OrderStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AuditQuery {
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly limit?: number;
}

export interface ReconciliationQuery {
  readonly from: Date;
  readonly to: Date;
  readonly currency: string;
  readonly locationId?: string;
  readonly provider?: string;
}

export interface ReconciliationSummary {
  readonly from: Date;
  readonly to: Date;
  readonly currency: string;
  readonly capturedPaymentCount: number;
  readonly capturedGross: Money;
  readonly succeededRefundCount: number;
  readonly refunded: Money;
  readonly netSales: Money;
  readonly settledGross: Money;
  readonly settlementFees: Money;
  readonly settledNet: Money;
  readonly unreconciledPaymentIds: readonly string[];
  readonly unreconciledRefundIds: readonly string[];
}

export type ProviderInboxStatus = "PROCESSING" | "PROCESSED" | "FAILED";

export interface ProviderInboxEvent {
  readonly provider: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly payloadHash: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly status: ProviderInboxStatus;
  readonly attempts: number;
  readonly receivedAt: Date;
  readonly updatedAt: Date;
  readonly processedAt?: Date;
  readonly lastError?: string;
}

export interface ProviderInboxClaim {
  readonly record: ProviderInboxEvent;
  readonly claimed: boolean;
}

export interface PosRepository {
  withTransaction<T>(work: () => Promise<T>): Promise<T>;
  healthCheck(): Promise<void>;
  listProducts(query?: ProductQuery): Promise<readonly Product[]>;
  getProduct(id: string): Promise<Product | undefined>;
  createProduct(product: Product): Promise<Product>;
  saveProduct(product: Product): Promise<Product>;

  getMerchantSettings(): Promise<MerchantSettings>;
  saveMerchantSettings(settings: MerchantSettings): Promise<MerchantSettings>;

  createCart(cart: Cart): Promise<Cart>;
  getCart(id: string): Promise<Cart | undefined>;
  saveCart(cart: Cart, expectedVersion?: number): Promise<Cart>;

  createOrder(order: Order): Promise<Order>;
  listOrders(query?: OrderQuery): Promise<readonly Order[]>;
  getOrder(id: string): Promise<Order | undefined>;
  findOrderByCartId(cartId: string): Promise<Order | undefined>;
  saveOrder(order: Order, expectedVersion?: number): Promise<Order>;

  createPaymentAttempt(attempt: PaymentAttempt): Promise<PaymentAttempt>;
  /** Atomically moves an OPEN order to PAYMENT_PENDING and creates its attempt. */
  reservePaymentAttempt(
    order: Order,
    attempt: PaymentAttempt,
    expectedOrderVersion: number
  ): Promise<PaymentAttempt>;
  getPaymentAttempt(id: string): Promise<PaymentAttempt | undefined>;
  savePaymentAttempt(
    attempt: PaymentAttempt,
    expectedVersion?: number
  ): Promise<PaymentAttempt>;

  createPayment(payment: Payment): Promise<Payment>;
  getPayment(id: string): Promise<Payment | undefined>;
  findPaymentByProviderReference(
    provider: string,
    providerReference: string
  ): Promise<Payment | undefined>;
  listPaymentsForOrder(orderId: string): Promise<readonly Payment[]>;

  createRefund(refund: Refund): Promise<Refund>;
  /** Atomically reserves refund capacity against the captured payment. */
  reserveRefund(refund: Refund): Promise<Refund>;
  saveRefund(refund: Refund, expectedVersion?: number): Promise<Refund>;
  findRefundByProviderReference(
    provider: string,
    providerReference: string
  ): Promise<Refund | undefined>;
  listRefundsForPayment(paymentId: string): Promise<readonly Refund[]>;

  getIdempotency(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  claimIdempotency(record: IdempotencyRecord): Promise<IdempotencyClaim>;
  saveIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord>;

  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(query?: AuditQuery): Promise<readonly AuditEntry[]>;

  claimProviderEvent(event: ProviderInboxEvent): Promise<ProviderInboxClaim>;
  completeProviderEvent(provider: string, eventId: string, processedAt: Date): Promise<void>;
  failProviderEvent(event: ProviderInboxEvent, error: string, failedAt: Date): Promise<void>;

  /** Removes sandbox transactions while retaining products and merchant settings. */
  resetDemoData(): Promise<void>;

  enqueueOutbox(message: OutboxMessage): Promise<void>;
  listPendingOutbox(limit?: number, now?: Date): Promise<readonly OutboxMessage[]>;
  claimPendingOutbox(
    limit?: number,
    now?: Date,
    lockedUntil?: Date
  ): Promise<readonly OutboxMessage[]>;
  markOutboxPublished(id: string, publishedAt?: Date): Promise<void>;
  markOutboxFailed(id: string, error: string, retryAt?: Date): Promise<void>;

  createSettlementBatch(batch: SettlementBatch): Promise<SettlementBatch>;
  getSettlementBatch(id: string): Promise<SettlementBatch | undefined>;
  hasSettlementLine(id: string): Promise<boolean>;

  reconciliationSummary(query: ReconciliationQuery): Promise<ReconciliationSummary>;

  close(): Promise<void>;
}

export function emptyReconciliationSummary(
  query: ReconciliationQuery
): ReconciliationSummary {
  const currency = query.currency.toUpperCase();
  return {
    from: new Date(query.from),
    to: new Date(query.to),
    currency,
    capturedPaymentCount: 0,
    capturedGross: Money.zero(currency),
    succeededRefundCount: 0,
    refunded: Money.zero(currency),
    netSales: Money.zero(currency),
    settledGross: Money.zero(currency),
    settlementFees: Money.zero(currency),
    settledNet: Money.zero(currency),
    unreconciledPaymentIds: [],
    unreconciledRefundIds: []
  };
}
