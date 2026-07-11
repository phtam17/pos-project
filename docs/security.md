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

## Production security work still required

- Persist and deduplicate forged, duplicate, delayed, and out-of-order provider events.
- Add authenticated staff/device identity, trusted RBAC, location isolation, and manager approval. `MANAGER_API_KEY` only gates the demo refund endpoint; it is not a complete identity system.
- Add automated log/trace leakage scanning and verify that analytics and support tooling cannot receive account data.
- Make aggregate, idempotency, audit, and outbox writes one database transaction per use case.
- Reject simulator, memory persistence, default secrets, and missing identity configuration at production startup.

Before deployment, document the complete data flow and obtain the applicable PCI DSS validation instructions from the acquirer.
