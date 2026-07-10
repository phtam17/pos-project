# Architecture

## Shape

The project starts as a modular monolith. The HTTP API owns pricing, totals, order state, and money state. The register is an untrusted client. A provider adapter controls a certified terminal without exposing payment-account data to the POS.

```text
Register UI ---> API ---> repository ---> PostgreSQL
                  |
                  +---> PaymentProvider ---> certified provider/terminal
                  ^              |
                  |              v
                  +--------- signed webhook

Worker <--- outbox / provider settlements ---> reconciliation records
```

Module boundaries are ordinary TypeScript packages so they remain easy to test and deploy together. They are not independent network services.

## Source of truth

- The API reloads current products and recalculates the cart. Client-supplied totals are ignored.
- Checkout snapshots product name, SKU, unit price, quantity, and allocated tax into immutable order lines.
- A provider result, verified webhook, or provider status query is authoritative for card-payment state.
- A UI timeout never proves failure. An attempt enters `UNKNOWN` until the original provider reference is resolved.
- Captures and refunds are immutable financial facts. An order's paid/refunded status is derived from those facts.

## Delivery guarantees

- Money mutations require an `Idempotency-Key` scoped to operation and merchant.
- Reusing the same key with a different canonical request hash is rejected.
- Domain state transitions reject duplicates and invalid reversals.
- Provider events use an inbox/event identifier for deduplication.
- Domain changes and outbox writes share the repository transaction boundary in PostgreSQL.

## Offline policy

The MVP does not accept cards offline. The register can retain a cart locally, but it never queues card data or blindly replays a payment request. Offline card acceptance can be introduced only through a certified provider feature with explicit limits and provisional states.

## Provider replacement

Implement `PaymentProvider` and pass its shared contract tests. Capability flags must remain explicit: the application must not assume every provider supports offline authorization, partial authorization, separate capture, unreferenced refunds, tipping, or all card brands.
