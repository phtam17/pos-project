import { createHash } from "node:crypto";

import {
  Money,
  SettlementBatch,
  SettlementLine,
  type OutboxMessage,
  type SettlementLineSnapshot
} from "@pos/domain";
import type { PaymentProvider, ProviderSettlementItem } from "@pos/payment-contract";
import type { PosRepository } from "@pos/persistence";

export interface WorkerResult {
  readonly publishedOutbox: number;
  readonly failedOutbox: number;
  readonly settlementBatches: number;
  readonly settlementLines: number;
  readonly unmatchedSettlementItems: readonly string[];
  readonly nextSettlementCursor: string | null;
}

export interface RunWorkerOptions {
  readonly repository: PosRepository;
  readonly provider: PaymentProvider;
  readonly settlementCursor?: string;
  readonly outboxLimit?: number;
  readonly publish?: (message: OutboxMessage) => Promise<void>;
  readonly now?: () => Date;
}

/**
 * Processes one bounded batch. A production process should persist the
 * settlement cursor and publish outbox messages to a durable broker.
 */
export async function runWorkerOnce(options: RunWorkerOptions): Promise<WorkerResult> {
  const now = options.now ?? (() => new Date());
  const claimTime = now();
  const pending = await options.repository.claimPendingOutbox(
    options.outboxLimit ?? 100,
    claimTime,
    new Date(claimTime.getTime() + 30_000)
  );
  let publishedOutbox = 0;
  let failedOutbox = 0;
  for (const message of pending) {
    try {
      await (options.publish ?? defaultPublish)(message);
      await options.repository.markOutboxPublished(message.id, now());
      publishedOutbox += 1;
    } catch (error) {
      await options.repository.markOutboxFailed(
        message.id,
        error instanceof Error ? error.message : "Unknown outbox publish failure",
        new Date(now().getTime() + 30_000)
      );
      failedOutbox += 1;
    }
  }

  if (!options.provider.capabilities.supportsSettlementListing) {
    return {
      publishedOutbox,
      failedOutbox,
      settlementBatches: 0,
      settlementLines: 0,
      unmatchedSettlementItems: [],
      nextSettlementCursor: null
    };
  }

  const page = await options.provider.listSettlements(options.settlementCursor);
  if (page.items.length === 0) {
    return {
      publishedOutbox,
      failedOutbox,
      settlementBatches: 0,
      settlementLines: 0,
      unmatchedSettlementItems: [],
      nextSettlementCursor: page.nextCursor
    };
  }
  const unmatched: string[] = [];
  const lines: SettlementLineSnapshot[] = [];
  for (const item of page.items) {
    const lineId = settlementLineId(options.provider.name, item.id);
    if (await options.repository.hasSettlementLine(lineId)) continue;
    const mapped = await mapSettlementItem(
      options.repository,
      options.provider.name,
      "pending-batch-id",
      item
    );
    if (mapped) lines.push(mapped.toSnapshot());
    else unmatched.push(item.id);
  }

  if (unmatched.length > 0) {
    return {
      publishedOutbox,
      failedOutbox,
      settlementBatches: 0,
      settlementLines: 0,
      unmatchedSettlementItems: unmatched,
      // Do not advance past an incomplete page. This prevents a missing local
      // payment mapping from being silently lost.
      nextSettlementCursor: options.settlementCursor ?? null
    };
  }
  if (lines.length === 0) {
    return {
      publishedOutbox,
      failedOutbox,
      settlementBatches: 0,
      settlementLines: 0,
      unmatchedSettlementItems: [],
      // The page was already committed. Advancing to the provider cursor is
      // required when a worker crashes after commit but before saving cursor.
      nextSettlementCursor: page.nextCursor
    };
  }

  const linesByCurrency = new Map<string, SettlementLineSnapshot[]>();
  for (const line of lines) {
    const currency = line.netAmount.currency;
    const group = linesByCurrency.get(currency) ?? [];
    group.push(line);
    linesByCurrency.set(currency, group);
  }

  for (const [currency, currencyLines] of linesByCurrency) {
    const pageIdentity = currencyLines.map((line) => line.id).sort().join("|");
    const batchId = stableId(
      "settlement-batch",
      `${options.provider.name}:${currency}:${pageIdentity}`
    );
    const batchLines = currencyLines.map((line) => ({ ...line, batchId }));
    const payoutAmount = batchLines.reduce(
      (sum, line) => sum.add(line.netAmount),
      Money.zero(currency)
    );
    const occurred = batchLines.map((line) => line.occurredAt.getTime());
    const batch = new SettlementBatch({
      id: batchId,
      provider: options.provider.name,
      providerBatchReference:
        `${options.provider.name}:${currency}:${stableId("provider-page", pageIdentity)}`,
      currency,
      status: "OPEN",
      lines: batchLines,
      payoutAmount,
      periodStart: new Date(Math.min(...occurred)),
      periodEnd: new Date(Math.max(...occurred)),
      createdAt: now(),
      reconciledAt: null,
      version: 0
    });
    await options.repository.createSettlementBatch(batch);
  }

  return {
    publishedOutbox,
    failedOutbox,
    settlementBatches: linesByCurrency.size,
    settlementLines: lines.length,
    unmatchedSettlementItems: unmatched,
    nextSettlementCursor: page.nextCursor
  };
}

async function mapSettlementItem(
  repository: PosRepository,
  provider: string,
  batchId: string,
  item: ProviderSettlementItem
): Promise<SettlementLine | undefined> {
  let paymentId: string | null = null;
  let refundId: string | null = null;

  if (item.kind === "PAYMENT") {
    const reference = item.paymentId ?? item.providerReference;
    const payment = await repository.findPaymentByProviderReference(provider, reference)
      ?? await repository.findPaymentByProviderReference(provider, item.providerReference);
    if (!payment) return undefined;
    if (!item.grossAmount.equals(payment.amount)) return undefined;
    paymentId = payment.id;
  }
  if (item.kind === "REFUND") {
    const reference = item.refundId ?? item.providerReference;
    const refund = await repository.findRefundByProviderReference(provider, reference)
      ?? await repository.findRefundByProviderReference(provider, item.providerReference);
    if (!refund) return undefined;
    if (!item.grossAmount.equals(refund.amount.multiply(-1))) return undefined;
    refundId = refund.id;
  }

  return new SettlementLine({
    id: settlementLineId(provider, item.id),
    batchId,
    kind: item.kind,
    paymentId,
    refundId,
    providerReference: item.providerReference,
    grossAmount: item.grossAmount,
    feeAmount: item.feeAmount,
    netAmount: item.netAmount,
    occurredAt: item.occurredAt
  });
}

async function defaultPublish(message: OutboxMessage): Promise<void> {
  console.info(JSON.stringify({
    id: message.id,
    topic: message.topic,
    aggregateId: message.aggregateId,
    occurredAt: message.occurredAt.toISOString(),
    payload: message.payload
  }));
}

function stableId(namespace: string, value: string): string {
  const hex = createHash("sha256").update(`${namespace}\0${value}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function settlementLineId(provider: string, providerItemId: string): string {
  return stableId("settlement-line", `${provider}:${providerItemId}`);
}
