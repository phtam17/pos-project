import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("sandbox configuration", () => {
  it("defaults to an authenticated local-only sandbox", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      appMode: "sandbox",
      publicSandbox: false,
      publicStaffLoginEnabled: false,
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

  it("supports a guest-only same-origin public deployment without exposing staff credentials", () => {
    const config = loadConfig({
      PUBLIC_SANDBOX: "true",
      STATIC_DIR: "apps/register/dist",
      CORS_ORIGINS: "",
      AUTH_SECRET: "auth-secret-at-least-thirty-two-characters-long",
      SIMULATED_WEBHOOK_SECRET: "webhook-secret-at-least-thirty-two-characters",
      DEMO_RESET_INTERVAL_MINUTES: "60",
      TRUST_PROXY_HOPS: "1"
    });
    expect(config).toMatchObject({
      publicSandbox: true,
      publicStaffLoginEnabled: false,
      staticDir: "apps/register/dist",
      corsOrigins: [],
      trustProxyHops: 1
    });
  });

  it("requires hardened staff PINs only when a public deployment exposes staff login", () => {
    const base = {
      PUBLIC_SANDBOX: "true",
      PUBLIC_STAFF_LOGIN_ENABLED: "true",
      STATIC_DIR: "apps/register/dist",
      CORS_ORIGINS: "",
      AUTH_SECRET: "auth-secret-at-least-thirty-two-characters-long",
      SIMULATED_WEBHOOK_SECRET: "webhook-secret-at-least-thirty-two-characters",
      DEMO_RESET_INTERVAL_MINUTES: "60"
    };
    expect(() => loadConfig(base)).toThrow(/staff login requires distinct/);
    expect(loadConfig({
      ...base,
      DEMO_CASHIER_PIN: "135790",
      DEMO_MANAGER_PIN: "246801"
    }).publicStaffLoginEnabled).toBe(true);
  });

  it("rejects the known .env.example placeholder secrets in public mode", () => {
    expect(() => loadConfig({
      PUBLIC_SANDBOX: "true",
      AUTH_SECRET: "local-sandbox-auth-secret-change-before-sharing",
      SIMULATED_WEBHOOK_SECRET: "local-sandbox-webhook-secret-change-before-sharing",
      DEMO_CASHIER_PIN: "135790",
      DEMO_MANAGER_PIN: "246801",
      CORS_ORIGINS: "https://sandbox.example.test",
      DEMO_RESET_INTERVAL_MINUTES: "60"
    })).toThrow(/AUTH_SECRET/);
  });

  it("requires HTTPS origins and rate limiting in public mode", () => {
    const hardened = {
      PUBLIC_SANDBOX: "true",
      AUTH_SECRET: "auth-secret-at-least-thirty-two-characters-long",
      SIMULATED_WEBHOOK_SECRET: "webhook-secret-at-least-thirty-two-characters",
      DEMO_CASHIER_PIN: "135790",
      DEMO_MANAGER_PIN: "246801",
      DEMO_RESET_INTERVAL_MINUTES: "60"
    };
    expect(() => loadConfig({
      ...hardened,
      CORS_ORIGINS: "http://sandbox.example.test"
    })).toThrow(/HTTPS CORS_ORIGINS/);
    expect(() => loadConfig({
      ...hardened,
      CORS_ORIGINS: "https://sandbox.example.test",
      RATE_LIMIT_ENABLED: "false"
    })).toThrow(/RATE_LIMIT_ENABLED/);
  });
});
