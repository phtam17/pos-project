import { pathToFileURL } from "node:url";

import { createRepository } from "./factory.js";
import { seedRepository } from "./seed-data.js";

export async function runSeed(databaseUrl: string, currency = "USD"): Promise<void> {
  const repository = createRepository({ databaseUrl, seed: false });
  try {
    await seedRepository(repository, currency);
  } finally {
    await repository.close();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required to seed PostgreSQL");
  await runSeed(databaseUrl, process.env.POS_CURRENCY ?? "USD");
  console.info("Seed products are ready");
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
