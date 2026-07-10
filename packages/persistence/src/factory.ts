import { MemoryPosRepository } from "./memory-repository.js";
import { PostgresPosRepository } from "./postgres-repository.js";
import type { PosRepository } from "./repository.js";
import { createSeedProducts } from "./seed-data.js";

export interface CreateRepositoryOptions {
  /** Pass an empty string to explicitly select the in-memory adapter. */
  readonly databaseUrl?: string;
  /** Memory repositories contain demo products by default. */
  readonly seed?: boolean;
  readonly currency?: string;
  readonly maxConnections?: number;
}

export function createRepository(options: CreateRepositoryOptions = {}): PosRepository {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (databaseUrl?.trim()) {
    return new PostgresPosRepository({
      connectionString: databaseUrl,
      ...(options.maxConnections === undefined
        ? {}
        : { maxConnections: options.maxConnections })
    });
  }

  const products =
    options.seed === false ? [] : createSeedProducts(options.currency ?? "USD");
  return new MemoryPosRepository(products);
}
