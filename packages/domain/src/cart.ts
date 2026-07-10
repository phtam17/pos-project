import { DomainValidationError } from "./errors.js";
import type { CartId, CartLineId, ProductId } from "./ids.js";
import { Money } from "./money.js";
import { Product } from "./product.js";
import {
  copyDate,
  requireNonEmpty,
  requireNonNegativeInteger,
  requirePositiveInteger,
} from "./validation.js";

export interface CartLineInput {
  readonly id: CartLineId;
  readonly productId: ProductId;
  readonly sku: string;
  readonly name: string;
  readonly unitPrice: Money;
  readonly quantity: number;
  readonly taxRateBps?: number;
  readonly discount?: Money;
}

export interface CartLineSnapshot {
  readonly id: CartLineId;
  readonly productId: ProductId;
  readonly sku: string;
  readonly name: string;
  readonly unitPrice: Money;
  readonly quantity: number;
  readonly taxRateBps: number;
  /** Total discount for the entire line, not a per-unit discount. */
  readonly discount: Money;
  /** Unit price multiplied by quantity, before discount and tax. */
  readonly subtotal: Money;
  readonly tax: Money;
  readonly total: Money;
}

export class CartLine implements CartLineSnapshot {
  readonly id: CartLineId;
  readonly productId: ProductId;
  readonly sku: string;
  readonly name: string;
  readonly unitPrice: Money;
  readonly quantity: number;
  readonly taxRateBps: number;
  readonly discount: Money;
  readonly subtotal: Money;
  readonly tax: Money;
  readonly total: Money;

  constructor(input: CartLineInput) {
    this.id = requireNonEmpty(input.id, "cartLine.id");
    this.productId = requireNonEmpty(input.productId, "cartLine.productId");
    this.sku = requireNonEmpty(input.sku, "cartLine.sku");
    this.name = requireNonEmpty(input.name, "cartLine.name");
    if (!(input.unitPrice instanceof Money) || input.unitPrice.isNegative()) {
      throw new DomainValidationError(
        "cartLine.unitPrice must be non-negative Money",
        "INVALID_CART_LINE_PRICE",
      );
    }
    this.unitPrice = input.unitPrice;
    this.quantity = requirePositiveInteger(input.quantity, "cartLine.quantity");
    this.taxRateBps = requireNonNegativeInteger(
      input.taxRateBps ?? 0,
      "cartLine.taxRateBps",
    );
    if (this.taxRateBps > 100_000) {
      throw new DomainValidationError(
        "cartLine.taxRateBps must not exceed 100000",
        "INVALID_TAX_RATE",
      );
    }

    this.subtotal = this.unitPrice.multiply(this.quantity);
    const discount = input.discount ?? Money.zero(this.unitPrice.currency);
    this.unitPrice.assertSameCurrency(discount);
    if (discount.isNegative() || discount.compare(this.subtotal) > 0) {
      throw new DomainValidationError(
        "cartLine.discount must be between zero and the line subtotal",
        "INVALID_LINE_DISCOUNT",
      );
    }
    this.discount = discount;
    const taxableAmount = this.subtotal.subtract(this.discount);
    this.tax = taxableAmount.percentageBasisPoints(this.taxRateBps);
    this.total = taxableAmount.add(this.tax);
    Object.freeze(this);
  }

  static fromProduct(
    product: Product,
    quantity = 1,
    id: CartLineId = product.id,
  ): CartLine {
    if (!product.active) {
      throw new DomainValidationError(
        "Inactive products cannot be added to a cart",
        "INACTIVE_PRODUCT",
      );
    }
    return new CartLine({
      id,
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unitPrice: product.unitPrice,
      quantity,
      taxRateBps: product.taxRateBps,
    });
  }

  static rehydrate(snapshot: CartLineSnapshot): CartLine {
    const line = new CartLine(snapshot);
    if (
      !line.subtotal.equals(snapshot.subtotal) ||
      !line.tax.equals(snapshot.tax) ||
      !line.total.equals(snapshot.total)
    ) {
      throw new DomainValidationError(
        "Persisted cart line totals do not match their inputs",
        "CART_LINE_TOTAL_MISMATCH",
      );
    }
    return line;
  }

  withQuantity(quantity: number): CartLine {
    return new CartLine({
      id: this.id,
      productId: this.productId,
      sku: this.sku,
      name: this.name,
      unitPrice: this.unitPrice,
      quantity,
      taxRateBps: this.taxRateBps,
      discount: this.discount,
    });
  }

  withDiscount(discount: Money): CartLine {
    return new CartLine({
      id: this.id,
      productId: this.productId,
      sku: this.sku,
      name: this.name,
      unitPrice: this.unitPrice,
      quantity: this.quantity,
      taxRateBps: this.taxRateBps,
      discount,
    });
  }

  toSnapshot(): CartLineSnapshot {
    return Object.freeze({
      id: this.id,
      productId: this.productId,
      sku: this.sku,
      name: this.name,
      unitPrice: this.unitPrice,
      quantity: this.quantity,
      taxRateBps: this.taxRateBps,
      discount: this.discount,
      subtotal: this.subtotal,
      tax: this.tax,
      total: this.total,
    });
  }
}

export interface CartSnapshot {
  readonly id: CartId;
  readonly status: CartStatus;
  readonly currency: string;
  readonly lines: readonly CartLineSnapshot[];
  readonly subtotal: Money;
  readonly discountTotal: Money;
  readonly taxTotal: Money;
  readonly total: Money;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface CartInput {
  readonly id: CartId;
  readonly status?: CartStatus;
  readonly currency: string;
  readonly lines?: readonly CartLineSnapshot[];
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
  /** New carts start at version 1, matching the persistence schema. */
  readonly version?: number;
}

export type CartStatus = "OPEN" | "CHECKED_OUT" | "ABANDONED";

/** A mutable cart aggregate whose individual line values are immutable. */
export class Cart {
  readonly id: CartId;
  readonly currency: string;
  readonly createdAt: Date;
  private statusValue: CartStatus;
  private updatedAtValue: Date;
  private versionValue: number;
  private readonly lineMap = new Map<CartLineId, CartLine>();

  constructor(input: CartInput) {
    this.id = requireNonEmpty(input.id, "cart.id");
    this.statusValue = input.status ?? "OPEN";
    this.currency = Money.zero(input.currency).currency;
    const createdAt = copyDate(input.createdAt ?? new Date(), "cart.createdAt");
    const updatedAt = copyDate(input.updatedAt ?? createdAt, "cart.updatedAt");
    if (updatedAt.getTime() < createdAt.getTime()) {
      throw new DomainValidationError(
        "cart.updatedAt cannot be before createdAt",
        "INVALID_CART_TIMESTAMP",
      );
    }
    this.createdAt = createdAt;
    this.updatedAtValue = updatedAt;
    const version = input.version ?? 1;
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new DomainValidationError(
        "cart.version must be a positive safe integer",
        "INVALID_CART_VERSION",
      );
    }
    this.versionValue = version;

    for (const snapshot of input.lines ?? []) {
      const line = CartLine.rehydrate(snapshot);
      this.assertCurrency(line.unitPrice);
      if (this.lineMap.has(line.id)) {
        throw new DomainValidationError(
          `Duplicate cart line id: ${line.id}`,
          "DUPLICATE_CART_LINE",
        );
      }
      this.lineMap.set(line.id, line);
    }
  }

  static rehydrate(snapshot: CartSnapshot): Cart {
    const cart = new Cart(snapshot);
    if (
      !cart.subtotal.equals(snapshot.subtotal) ||
      !cart.discountTotal.equals(snapshot.discountTotal) ||
      !cart.taxTotal.equals(snapshot.taxTotal) ||
      !cart.total.equals(snapshot.total)
    ) {
      throw new DomainValidationError(
        "Persisted cart totals do not match its lines",
        "CART_TOTAL_MISMATCH",
      );
    }
    return cart;
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtValue.getTime());
  }

  get status(): CartStatus {
    return this.statusValue;
  }

  get lines(): readonly CartLine[] {
    return Object.freeze([...this.lineMap.values()]);
  }

  get version(): number {
    return this.versionValue;
  }

  get subtotal(): Money {
    return this.sum((line) => line.subtotal);
  }

  get discountTotal(): Money {
    return this.sum((line) => line.discount);
  }

  get taxTotal(): Money {
    return this.sum((line) => line.tax);
  }

  get total(): Money {
    return this.sum((line) => line.total);
  }

  addProduct(
    product: Product,
    quantity = 1,
    lineId: CartLineId = product.id,
    at: Date = new Date(),
  ): CartLine {
    this.assertOpen();
    this.assertCurrency(product.unitPrice);
    const existing = this.lineMap.get(lineId);
    let line: CartLine;
    if (existing !== undefined) {
      if (
        existing.productId !== product.id ||
        !existing.unitPrice.equals(product.unitPrice) ||
        existing.taxRateBps !== product.taxRateBps
      ) {
        throw new DomainValidationError(
          `Cart line id ${lineId} is already used by another price snapshot`,
          "CART_LINE_CONFLICT",
        );
      }
      line = existing.withQuantity(existing.quantity + requirePositiveInteger(quantity, "quantity"));
    } else {
      line = CartLine.fromProduct(product, quantity, lineId);
    }
    this.lineMap.set(line.id, line);
    this.touch(at);
    return line;
  }

  setQuantity(lineId: CartLineId, quantity: number, at: Date = new Date()): CartLine {
    this.assertOpen();
    const existing = this.requireLine(lineId);
    const updated = existing.withQuantity(quantity);
    this.lineMap.set(lineId, updated);
    this.touch(at);
    return updated;
  }

  applyLineDiscount(
    lineId: CartLineId,
    discount: Money,
    at: Date = new Date(),
  ): CartLine {
    this.assertOpen();
    this.assertCurrency(discount);
    const updated = this.requireLine(lineId).withDiscount(discount);
    this.lineMap.set(lineId, updated);
    this.touch(at);
    return updated;
  }

  removeLine(lineId: CartLineId, at: Date = new Date()): void {
    this.assertOpen();
    if (!this.lineMap.delete(lineId)) {
      throw new DomainValidationError(
        `Cart line not found: ${lineId}`,
        "CART_LINE_NOT_FOUND",
      );
    }
    this.touch(at);
  }

  clear(at: Date = new Date()): void {
    this.assertOpen();
    this.lineMap.clear();
    this.touch(at);
  }

  markCheckedOut(at: Date = new Date()): void {
    this.assertOpen();
    if (this.lineMap.size === 0) {
      throw new DomainValidationError("An empty cart cannot be checked out", "EMPTY_CART");
    }
    this.statusValue = "CHECKED_OUT";
    this.touch(at);
  }

  toSnapshot(): CartSnapshot {
    return Object.freeze({
      id: this.id,
      status: this.status,
      currency: this.currency,
      lines: Object.freeze(this.lines.map((line) => line.toSnapshot())),
      subtotal: this.subtotal,
      discountTotal: this.discountTotal,
      taxTotal: this.taxTotal,
      total: this.total,
      createdAt: new Date(this.createdAt.getTime()),
      updatedAt: this.updatedAt,
      version: this.version,
    });
  }

  private sum(select: (line: CartLine) => Money): Money {
    let total = Money.zero(this.currency);
    for (const line of this.lineMap.values()) {
      total = total.add(select(line));
    }
    return total;
  }

  private requireLine(lineId: CartLineId): CartLine {
    const line = this.lineMap.get(lineId);
    if (line === undefined) {
      throw new DomainValidationError(
        `Cart line not found: ${lineId}`,
        "CART_LINE_NOT_FOUND",
      );
    }
    return line;
  }

  private assertCurrency(value: Money): void {
    Money.zero(this.currency).assertSameCurrency(value);
  }

  private assertOpen(): void {
    if (this.statusValue !== "OPEN") {
      throw new DomainValidationError(
        `Cart cannot be changed while ${this.statusValue}`,
        "CART_NOT_OPEN"
      );
    }
  }

  private touch(at: Date): void {
    const timestamp = copyDate(at, "cart.updatedAt");
    if (timestamp.getTime() < this.updatedAtValue.getTime()) {
      throw new DomainValidationError(
        "cart.updatedAt cannot move backwards",
        "INVALID_CART_TIMESTAMP",
      );
    }
    this.updatedAtValue = timestamp;
    this.versionValue += 1;
  }
}
