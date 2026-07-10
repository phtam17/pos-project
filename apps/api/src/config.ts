export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl?: string;
  readonly simulatedWebhookSecret: string;
  readonly corsOrigins: readonly string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = Number.parseInt(env.PORT ?? "3000", 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  const origins = (env.CORS_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    ...(databaseUrl ? { databaseUrl } : {}),
    simulatedWebhookSecret: env.SIMULATED_WEBHOOK_SECRET?.trim() || "development-only-secret",
    corsOrigins: origins
  };
}
