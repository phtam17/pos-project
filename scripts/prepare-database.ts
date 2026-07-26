import {
  createRepository,
  runMigrations,
  seedRepository
} from "@pos/persistence";

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to prepare PostgreSQL");
}

const migrations = await runMigrations({ databaseUrl });
const repository = createRepository({ databaseUrl, seed: false });

try {
  await seedRepository(repository, process.env.POS_CURRENCY ?? "USD");
} finally {
  await repository.close();
}

console.info(
  `Database ready: ${migrations.applied.length} migrations applied, `
  + `${migrations.alreadyApplied.length} already current, sample catalog ensured`
);
