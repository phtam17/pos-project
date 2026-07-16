# Security boundaries

This skeleton reduces payment-data exposure; it does not certify a merchant or make a deployment PCI DSS compliant.

## Prohibited data

The register, API, database, logs, traces, analytics, support tools, and backups must never receive or store:

- full PAN or unmasked card number;
- magnetic-track or equivalent chip data;
- CVV, CVC, CID, or other card verification codes;
- PIN, PIN block, or PIN-entry telemetry;
- EMV cryptograms, terminal master/session keys, or key-injection material;
- opaque terminal payloads unless their contents and retention have been reviewed.

Only provider references and receipt-safe metadata explicitly documented by the provider may cross the adapter boundary.

## Required production controls

- Use an exact provider-supported PCI PTS terminal and preferably a PCI-listed P2PE solution.
- Follow the solution's P2PE Instruction Manual, terminal inventory, inspection, replacement, and chain-of-custody requirements.
- Verify webhook signatures over raw request bytes, enforce a replay window, and deduplicate event identifiers.
- Keep provider secrets server-side in a secret manager. Never embed them in the register bundle.
- Use per-device identity, staff RBAC, manager approval for refunds, and location/merchant authorization on every operation.
- Encrypt transport, disks, and backups; test restoration; define retention and deletion schedules.
- Redact structured logs and add automated tests that fail when prohibited field names or card-like values appear.
- Patch terminals and applications, monitor dependencies, rotate credentials, and maintain incident-response contacts.

## Behaviors covered in tests

- duplicate Pay clicks and idempotency-key misuse;
- concurrent payment keys, stale provider-status races, and crashes immediately after an idempotency claim;
- process or network failure after card presentation;
- refund totals exceeding captured totals;
- invalid cart/order/payment state transitions;
- raw card-like fields at the HTTP and provider-adapter boundaries;
- malformed JSON, provider-response loss, paginated settlement replay, multi-currency batches, and settlement amount mismatches.
- signed sandbox staff sessions, cashier/manager authorization boundaries, exact-amount
  manager refund approvals, login rate limits, and actor-attributed audit entries;
- transactional provider-event claiming, duplicate webhook delivery, and rollback
  of failed in-memory inbox processing.

## Sandbox controls implemented here

- HMAC-signed, expiring local staff sessions with cashier and manager roles.
- Short-lived manager approvals bound to the requesting session, payment, refund
  amount, and idempotent refund operation.
- A unique provider webhook inbox processed in a PostgreSQL transaction (with a
  rollback-capable serialized transaction in memory mode).
- Process-local request/credential-attempt rate limiting, structured log redaction, and
  sanitized client errors.
- Manager-visible audit history, manual transaction reset, optional automatic
  demo reset, and startup rejection of live mode.
- Strict startup checks when `PUBLIC_SANDBOX=true`, including non-default secrets,
  stronger PINs, explicit CORS origins, and automatic reset.

These are demonstrator controls. Local PIN credentials, stateless HMAC tokens, and
an in-process limiter are not substitutes for trusted production identity, token
revocation, a distributed limiter, or device authorization.

## Production security work still required

- Enforce provider-specific timestamp/replay windows and ordering rules in addition
  to the persisted unique event IDs already used by the sandbox inbox.
- Replace local sandbox staff credentials with trusted staff/device identity,
  revocable sessions, location isolation, and centrally managed RBAC.
- Add automated log/trace leakage scanning and verify that analytics and support tooling cannot receive account data.
- Make aggregate, idempotency, audit, and outbox writes one database transaction per use case.
- Reject simulator, memory persistence, default secrets, and missing identity configuration at production startup.

Before deployment, document the complete data flow and obtain the applicable PCI DSS validation instructions from the acquirer.
