import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("sandbox configuration", () => {
  it("defaults to an authenticated local-only sandbox", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      appMode: "sandbox",
      publicSandbox: false,
      authEnabled: true,
      rateLimitEnabled: true,
      demoResetEnabled: true
    });
  });

  it("refuses live mode because this repository contains simulators only", () => {
    expect(() => loadConfig({ APP_MODE: "live" })).toThrow(/APP_MODE=live is unavailable/);
  });

  it("rejects public sharing with local demo credentials", () => {
    expect(() => loadConfig({
      PUBLIC_SANDBOX: "true",
      DEMO_RESET_INTERVAL_MINUTES: "60"
    })).toThrow(/AUTH_SECRET/);
  });

  it("accepts a public sandbox only with explicit hardened demo settings", () => {
    const config = loadConfig({
      PUBLIC_SANDBOX: "true",
      AUTH_SECRET: "auth-secret-at-least-thirty-two-characters-long",
      SIMULATED_WEBHOOK_SECRET: "webhook-secret-at-least-thirty-two-characters",
      DEMO_CASHIER_PIN: "135790",
      DEMO_MANAGER_PIN: "246801",
      CORS_ORIGINS: "https://sandbox.example.test",
      DEMO_RESET_ENABLED: "true",
      DEMO_RESET_INTERVAL_MINUTES: "60"
    });
    expect(config).toMatchObject({
      publicSandbox: true,
      corsOrigins: ["https://sandbox.example.test"],
      demoResetIntervalMinutes: 60
    });
  });
});
