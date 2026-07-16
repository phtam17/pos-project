import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { ApplicationError } from "@pos/application";

import type { ApiConfig, StaffCredential, StaffRole } from "./config.js";

export interface StaffSession {
  readonly id: string;
  readonly name: string;
  readonly role: StaffRole;
  readonly expiresAt: Date;
}

interface SessionClaims {
  readonly kind: "session";
  readonly sub: string;
  readonly name: string;
  readonly role: StaffRole;
  readonly exp: number;
  readonly nonce: string;
}

interface ApprovalClaims {
  readonly kind: "manager_approval";
  readonly approvedBy: string;
  readonly requestedBy: string;
  readonly paymentId: string;
  readonly amountMinor: string;
  readonly idempotencyKey: string;
  readonly exp: number;
  readonly nonce: string;
}

type TokenClaims = SessionClaims | ApprovalClaims;

export class SandboxAuth {
  private readonly secret: string;
  private readonly credentials: readonly StaffCredential[];
  private readonly sessionDurationMs: number;
  private readonly managerApprovalMs: number;

  constructor(config: ApiConfig, private readonly now: () => Date = () => new Date()) {
    this.secret = config.authSecret ?? "development-auth-secret-change-me";
    this.credentials = config.staffCredentials ?? [
      { id: "cashier-01", name: "Demo Cashier", role: "CASHIER", pin: "1234" },
      { id: "manager-01", name: "Demo Manager", role: "MANAGER", pin: "2468" }
    ];
    this.sessionDurationMs = (config.sessionDurationMinutes ?? 480) * 60_000;
    this.managerApprovalMs = (config.managerApprovalMinutes ?? 5) * 60_000;
  }

  login(staffId: string, pin: string): { token: string; session: StaffSession } {
    const credential = this.requireCredential(staffId, pin);
    const expiresAt = new Date(this.now().getTime() + this.sessionDurationMs);
    const claims: SessionClaims = {
      kind: "session",
      sub: credential.id,
      name: credential.name,
      role: credential.role,
      exp: expiresAt.getTime(),
      nonce: randomUUID()
    };
    return {
      token: this.sign(claims),
      session: { id: credential.id, name: credential.name, role: credential.role, expiresAt }
    };
  }

  verifySession(token: string): StaffSession {
    const claims = this.verify(token);
    if (claims.kind !== "session") throw unauthorized();
    return {
      id: claims.sub,
      name: claims.name,
      role: claims.role,
      expiresAt: new Date(claims.exp)
    };
  }

  createManagerApproval(input: {
    managerId: string;
    managerPin: string;
    requestedBy: StaffSession;
    paymentId: string;
    amountMinor: string;
    idempotencyKey: string;
  }): { token: string; approvedBy: string; expiresAt: Date } {
    const manager = this.requireCredential(input.managerId, input.managerPin);
    if (manager.role !== "MANAGER") {
      throw new ApplicationError("Manager authorization failed", "FORBIDDEN", 403);
    }
    const expiresAt = new Date(this.now().getTime() + this.managerApprovalMs);
    return {
      token: this.sign({
        kind: "manager_approval",
        approvedBy: manager.id,
        requestedBy: input.requestedBy.id,
        paymentId: input.paymentId,
        amountMinor: input.amountMinor,
        idempotencyKey: input.idempotencyKey,
        exp: expiresAt.getTime(),
        nonce: randomUUID()
      }),
      approvedBy: manager.id,
      expiresAt
    };
  }

  verifyManagerApproval(
    token: string,
    session: StaffSession,
    paymentId: string,
    amountMinor: string,
    idempotencyKey: string
  ): { approvedBy: string } {
    const claims = this.verify(token);
    if (
      claims.kind !== "manager_approval" ||
      claims.requestedBy !== session.id ||
      claims.paymentId !== paymentId ||
      claims.amountMinor !== amountMinor ||
      claims.idempotencyKey !== idempotencyKey
    ) {
      throw new ApplicationError("Manager approval does not match this refund", "FORBIDDEN", 403);
    }
    return { approvedBy: claims.approvedBy };
  }

  private requireCredential(staffId: string, pin: string): StaffCredential {
    const credential = this.credentials.find((candidate) => candidate.id === staffId.trim());
    const expected = credential?.pin ?? "invalid-credential-placeholder";
    if (!credential || !secureEqual(this.digest(pin), this.digest(expected))) {
      throw new ApplicationError("Staff ID or PIN is incorrect", "INVALID_CREDENTIALS", 401);
    }
    return credential;
  }

  private sign(claims: TokenClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private verify(token: string): TokenClaims {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) throw unauthorized();
    const expected = createHmac("sha256", this.secret).update(payload).digest("base64url");
    if (!secureEqual(signature, expected)) throw unauthorized();
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw unauthorized();
    }
    if (!isClaims(claims) || claims.exp <= this.now().getTime()) throw unauthorized();
    return claims;
  }

  private digest(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("hex");
  }
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isClaims(value: unknown): value is TokenClaims {
  if (value === null || typeof value !== "object") return false;
  const claims = value as Record<string, unknown>;
  if (typeof claims.exp !== "number" || typeof claims.nonce !== "string") return false;
  if (claims.kind === "session") {
    return typeof claims.sub === "string" && typeof claims.name === "string"
      && (claims.role === "CASHIER" || claims.role === "MANAGER");
  }
  return claims.kind === "manager_approval"
    && typeof claims.approvedBy === "string"
    && typeof claims.requestedBy === "string"
    && typeof claims.paymentId === "string"
    && typeof claims.amountMinor === "string"
    && typeof claims.idempotencyKey === "string";
}

function unauthorized(): ApplicationError {
  return new ApplicationError("Authentication is required or has expired", "UNAUTHORIZED", 401);
}
