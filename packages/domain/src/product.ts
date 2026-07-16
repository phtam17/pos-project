import type { ProductId } from "./ids.js";
import { DomainValidationError } from "./errors.js";
import { Money } from "./money.js";
import { requireNonEmpty, requireNonNegativeInteger } from "./validation.js";

export interface ProductSnapshot {
  readonly id: ProductId;
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly barcode: string | null;
  readonly unitPrice: Money;
  readonly taxRateBps: number;
  readonly active: boolean;
}

export interface ProductInput {
  readonly id: ProductId;
  readonly sku: string;
  readonly name: string;
  readonly category?: string;
  readonly barcode?: string | null;
  readonly unitPrice: Money;
  readonly taxRateBps?: number;
  readonly active?: boolean;
}

export class Product implements ProductSnapshot {
  readonly id: ProductId;
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly barcode: string | null;
  readonly unitPrice: Money;
  readonly taxRateBps: number;
  readonly active: boolean;

  constructor(input: ProductInput) {
    this.id = requireNonEmpty(input.id, "product.id");
    this.sku = requireNonEmpty(input.sku, "product.sku");
    this.name = requireNonEmpty(input.name, "product.name");
    this.category = requireNonEmpty(input.category ?? "Other", "product.category");
    const barcode = input.barcode?.trim() ?? "";
    this.barcode = barcode.length > 0 ? barcode : null;
    if (!(input.unitPrice instanceof Money) || input.unitPrice.isNegative()) {
      throw new DomainValidationError(
        "product.unitPrice must be non-negative Money",
        "INVALID_PRODUCT_PRICE",
      );
    }
    this.unitPrice = input.unitPrice;
    this.taxRateBps = requireNonNegativeInteger(
      input.taxRateBps ?? 0,
      "product.taxRateBps",
    );
    if (this.taxRateBps > 100_000) {
      throw new DomainValidationError(
        "product.taxRateBps must not exceed 100000",
        "INVALID_TAX_RATE",
      );
    }
    this.active = input.active ?? true;
    Object.freeze(this);
  }

  static rehydrate(snapshot: ProductSnapshot): Product {
    return new Product(snapshot);
  }

  withChanges(input: Omit<ProductInput, "id">): Product {
    return new Product({ id: this.id, ...input });
  }

  toSnapshot(): ProductSnapshot {
    return Object.freeze({
      id: this.id,
      sku: this.sku,
      name: this.name,
      category: this.category,
      barcode: this.barcode,
      unitPrice: this.unitPrice,
      taxRateBps: this.taxRateBps,
      active: this.active,
    });
  }
}
