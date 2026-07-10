# ADR 0001: Semi-integrated payment boundary

Status: accepted

## Decision

The POS will not read cards or implement EMV kernels. It will send amount, currency, terminal identifier, merchant reference, and idempotency key to a certified provider integration. The adapter returns a normalized result and receipt-safe metadata.

The first adapter is a simulator. A production adapter must use a provider/acquirer-supported terminal path whose certifications apply without this application performing card capture.

## Consequences

- The product can focus on checkout, orders, receipts, refunds, and reconciliation.
- Card-account data is kept out of application storage and logs.
- Payment providers remain replaceable at a code boundary.
- Terminal hardware and L3 certification can still create operational provider lock-in.
- Provider capabilities and asynchronous/unknown results must be modeled explicitly.
