import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "pg";

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export interface RunMigrationsOptions {
  databaseUrl: string;
  migrationsDirectory?: string;
}

const defaultMigrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function runMigrations({
  databaseUrl,
  migrationsDirectory = defaultMigrationsDirectory
}: RunMigrationsOptions): Promise<MigrationResult> {
  const client = new Client({ connectionString: databaseUrl });
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  await client.connect();

  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", ["open-pos:migrations"]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS _pos_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const filenames = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right));

    for (const filename of filenames) {
      const sql = await readFile(join(migrationsDirectory, filename), "utf8");
      const migrationChecksum = checksum(sql);
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM _pos_migrations WHERE name = $1",
        [filename]
      );

      if (existing.rowCount) {
        const savedChecksum = existing.rows[0]?.checksum;
        if (savedChecksum !== migrationChecksum) {
          throw new Error(
            `Migration ${filename} changed after it was applied (expected ${savedChecksum}, found ${migrationChecksum})`
          );
        }
        alreadyApplied.push(filename);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO _pos_migrations (name, checksum) VALUES ($1, $2)",
          [filename, migrationChecksum]
        );
        await client.query("COMMIT");
        applied.push(filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return { applied, alreadyApplied };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
        "open-pos:migrations"
      ]);
    } finally {
      await client.end();
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run PostgreSQL migrations");
  }

  const result = await runMigrations({ databaseUrl });
  console.info(
    `Migrations complete: ${result.applied.length} applied, ${result.alreadyApplied.length} already current`
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
