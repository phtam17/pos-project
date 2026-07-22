export type StaffRole = "CASHIER" | "MANAGER";

export interface StaffCredential {
  readonly id: string;
  readonly name: string;
  readonly role: StaffRole;
  readonly pin: string;
}

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl?: string;
  readonly persistenceMode?: "memory" | "postgres";
  readonly simulatedWebhookSecret: string;
  readonly managerApiKey?: string;
  readonly corsOrigins: readonly string[];
  readonly appMode?: "sandbox";
  readonly publicSandbox?: boolean;
  readonly authEnabled?: boolean;
  readonly authSecret?: string;
  readonly staffCredentials?: readonly StaffCredential[];
  readonly sessionDurationMinutes?: number;
  readonly managerApprovalMinutes?: number;
  readonly rateLimitEnabled?: boolean;
  readonly rateLimitMax?: number;
  readonly rateLimitWindowMs?: number;
  readonly loginRateLimitMax?: number;
  readonly loginRateLimitWindowMs?: number;
  readonly demoResetEnabled?: boolean;
  readonly demoResetIntervalMinutes?: number;
}

const DEVELOPMENT_AUTH_SECRET = "development-auth-secret-change-me";
const DEVELOPMENT_WEBHOOK_SECRET = "development-only-secret";
const DEVELOPMENT_CASHIER_PIN = "1234";
const DEVELOPMENT_MANAGER_PIN = "2468";
const PUBLIC_SECRET_PLACEHOLDERS = new Set([
  DEVELOPMENT_AUTH_SECRET,
  DEVELOPMENT_WEBHOOK_SECRET,
  "local-sandbox-auth-secret-change-before-sharing",
  "local-sandbox-webhook-secret-change-before-sharing"
]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = Number.parseInt(env.PORT ?? "3000", 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const databaseUrl = env.DATABASE_URL?.trim();
  const persistenceModeValue = env.PERSISTENCE_MODE?.trim().toLowerCase();
  if (
    persistenceModeValue !== undefined &&
    persistenceModeValue !== "memory" &&
    persistenceModeValue !== "postgres"
  ) {
    throw new Error("PERSISTENCE_MODE must be either memory or postgres");
  }
  const persistenceMode = persistenceModeValue ?? (databaseUrl ? "postgres" : "memory");
  if (persistenceMode === "postgres" && !databaseUrl) {
    throw new Error("DATABASE_URL is required when PERSISTENCE_MODE=postgres");
  }
  const managerApiKey = env.MANAGER_API_KEY?.trim();
  const appMode = env.APP_MODE?.trim().toLowerCase() || "sandbox";
  if (appMode !== "sandbox") {
    throw new Error(
      "APP_MODE=live is unavailable: this repository contains simulated providers only and cannot accept live payments"
    );
  }
  const publicSandbox = booleanValue(env.PUBLIC_SANDBOX, false, "PUBLIC_SANDBOX");
  const authEnabled = booleanValue(env.SANDBOX_AUTH_ENABLED, true, "SANDBOX_AUTH_ENABLED");
  const authSecret = env.AUTH_SECRET?.trim() || DEVELOPMENT_AUTH_SECRET;
  const simulatedWebhookSecret = env.SIMULATED_WEBHOOK_SECRET?.trim() || DEVELOPMENT_WEBHOOK_SECRET;
  const cashierPin = env.DEMO_CASHIER_PIN?.trim() || DEVELOPMENT_CASHIER_PIN;
  const managerPin = env.DEMO_MANAGER_PIN?.trim() || DEVELOPMENT_MANAGER_PIN;
  const demoResetIntervalMinutes = integerValue(
    env.DEMO_RESET_INTERVAL_MINUTES,
    0,
    0,
    10_080,
    "DEMO_RESET_INTERVAL_MINUTES"
  );
  const origins = (env.CORS_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const config: ApiConfig = {
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    ...(databaseUrl ? { databaseUrl } : {}),
    persistenceMode,
    simulatedWebhookSecret,
    ...(managerApiKey ? { managerApiKey } : {}),
    corsOrigins: origins,
    appMode: "sandbox",
    publicSandbox,
    authEnabled,
    authSecret,
    staffCredentials: [
      { id: "cashier-01", name: "Demo Cashier", role: "CASHIER", pin: cashierPin },
      { id: "manager-01", name: "Demo Manager", role: "MANAGER", pin: managerPin }
    ],
    sessionDurationMinutes: integerValue(env.SESSION_DURATION_MINUTES, 480, 15, 1_440, "SESSION_DURATION_MINUTES"),
    managerApprovalMinutes: integerValue(env.MANAGER_APPROVAL_MINUTES, 5, 1, 30, "MANAGER_APPROVAL_MINUTES"),
    rateLimitEnabled: booleanValue(env.RATE_LIMIT_ENABLED, true, "RATE_LIMIT_ENABLED"),
    rateLimitMax: integerValue(env.RATE_LIMIT_MAX, 240, 10, 10_000, "RATE_LIMIT_MAX"),
    rateLimitWindowMs: 60_000,
    loginRateLimitMax: integerValue(env.LOGIN_RATE_LIMIT_MAX, 8, 1, 100, "LOGIN_RATE_LIMIT_MAX"),
    loginRateLimitWindowMs: 300_000,
    demoResetEnabled: booleanValue(env.DEMO_RESET_ENABLED, true, "DEMO_RESET_ENABLED"),
    demoResetIntervalMinutes
  };

  if (publicSandbox) validatePublicSandbox(config);
  return config;
}

function booleanValue(value: string | undefined, fallback: boolean, field: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${field} must be true or false`);
}

function integerValue(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function validatePublicSandbox(config: ApiConfig): void {
  if (!config.authEnabled) throw new Error("PUBLIC_SANDBOX requires SANDBOX_AUTH_ENABLED=true");
  if (!config.authSecret || unsafePublicSecret(config.authSecret)) {
    throw new Error("PUBLIC_SANDBOX requires a unique AUTH_SECRET of at least 32 characters");
  }
  if (unsafePublicSecret(config.simulatedWebhookSecret)) {
    throw new Error("PUBLIC_SANDBOX requires a unique SIMULATED_WEBHOOK_SECRET of at least 32 characters");
  }
  if (config.authSecret === config.simulatedWebhookSecret) {
    throw new Error("PUBLIC_SANDBOX requires separate AUTH_SECRET and SIMULATED_WEBHOOK_SECRET values");
  }
  const credentials = config.staffCredentials ?? [];
  if (
    credentials.length < 2 ||
    credentials.some((credential) => !/^\d{6,}$/.test(credential.pin)) ||
    credentials.some((credential) =>
      credential.pin === DEVELOPMENT_CASHIER_PIN || credential.pin === DEVELOPMENT_MANAGER_PIN
    ) ||
    new Set(credentials.map((credential) => credential.pin)).size !== credentials.length
  ) {
    throw new Error("PUBLIC_SANDBOX requires distinct, non-default staff PINs of at least 6 digits");
  }
  if (
    config.corsOrigins.length === 0 ||
    config.corsOrigins.includes("*") ||
    config.corsOrigins.some((origin) => {
      try {
        return new URL(origin).protocol !== "https:";
      } catch {
        return true;
      }
    })
  ) {
    throw new Error("PUBLIC_SANDBOX requires explicit HTTPS CORS_ORIGINS");
  }
  if (!config.demoResetEnabled || (config.demoResetIntervalMinutes ?? 0) <= 0) {
    throw new Error("PUBLIC_SANDBOX requires an automatic DEMO_RESET_INTERVAL_MINUTES");
  }
  if (!config.rateLimitEnabled) {
    throw new Error("PUBLIC_SANDBOX requires RATE_LIMIT_ENABLED=true");
  }
}

function unsafePublicSecret(value: string): boolean {
  return value.length < 32 || PUBLIC_SECRET_PLACEHOLDERS.has(value)
    || /change[-_ ]?(?:me|before[-_ ]?sharing)|development[-_ ]?(?:only|secret)/i.test(value);
}
