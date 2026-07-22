import type { FastifyReply, FastifyRequest } from "fastify";

export interface RateLimitOptions {
  readonly generalMax: number;
  readonly generalWindowMs: number;
  readonly loginMax: number;
  readonly loginWindowMs: number;
  readonly now?: () => number;
}

interface Counter {
  count: number;
  resetAt: number;
}

export function createRateLimitHook(options: RateLimitOptions) {
  const counters = new Map<string, Counter>();
  const now = options.now ?? Date.now;
  let requests = 0;

  return async function rateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (request.method === "OPTIONS" || path === "/health" || path === "/ready") return;
    const credentialAttempt = path === "/v1/auth/login"
      || path === "/v1/auth/guest"
      || path === "/v1/auth/manager-approvals";
    const maximum = credentialAttempt ? options.loginMax : options.generalMax;
    const windowMs = credentialAttempt ? options.loginWindowMs : options.generalWindowMs;
    const key = `${credentialAttempt ? "credential" : "general"}:${request.ip}`;
    const timestamp = now();
    const current = counters.get(key);
    const counter = current && current.resetAt > timestamp
      ? current
      : { count: 0, resetAt: timestamp + windowMs };
    counter.count += 1;
    counters.set(key, counter);
    const remaining = Math.max(0, maximum - counter.count);
    reply.header("RateLimit-Limit", String(maximum));
    reply.header("RateLimit-Remaining", String(remaining));
    reply.header("RateLimit-Reset", String(Math.ceil(counter.resetAt / 1000)));

    if (counter.count > maximum) {
      reply.header("Retry-After", String(Math.max(1, Math.ceil((counter.resetAt - timestamp) / 1000))));
      reply.code(429).send({
        error: { code: "RATE_LIMITED", message: "Too many requests. Wait and try again." }
      });
      return;
    }

    requests += 1;
    if (requests % 1_000 === 0) {
      for (const [candidate, value] of counters) {
        if (value.resetAt <= timestamp) counters.delete(candidate);
      }
    }
  };
}
