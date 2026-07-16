import { Money, Product } from "@pos/domain";

import { RepositoryConflictError } from "./errors.js";
import { MemoryPosRepository } from "./memory-repository.js";
import type { PosRepository } from "./repository.js";

export function createSeedProducts(currency = "USD"): readonly Product[] {
  return Object.freeze([
    new Product({
      id: "product-coffee",
      sku: "COFFEE-001",
      name: "Coffee",
      category: "Drinks",
      barcode: "100000000001",
      unitPrice: Money.fromMinor(350n, currency),
      taxRateBps: 0
    }),
    new Product({
      id: "product-sandwich",
      sku: "SANDWICH-001",
      name: "Sandwich",
      category: "Food",
      barcode: "100000000002",
      unitPrice: Money.fromMinor(950n, currency),
      taxRateBps: 0
    }),
    new Product({
      id: "product-water",
      sku: "WATER-001",
      name: "Bottled Water",
      category: "Drinks",
      barcode: "100000000003",
      unitPrice: Money.fromMinor(200n, currency),
      taxRateBps: 0
    })
  ]);
}

export async function seedRepository(
  repository: PosRepository,
  currency = "USD"
): Promise<void> {
  for (const product of createSeedProducts(currency)) {
    try {
      await repository.createProduct(product);
    } catch (error) {
      if (!(error instanceof RepositoryConflictError)) throw error;
    }
  }
}

export async function seedMemoryRepository(
  repository = new MemoryPosRepository(),
  currency = "USD"
): Promise<MemoryPosRepository> {
  await seedRepository(repository, currency);
  return repository;
}
