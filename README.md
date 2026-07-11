# Open POS skeleton

A processor-neutral point-of-sale starter for a single merchant. It deliberately keeps payment-card data outside the application: the register sends an amount and merchant reference to a payment-provider adapter and stores only the provider result and receipt-safe metadata.

The included payment provider is a simulator. It is suitable for development only and must be replaced by a certified terminal/provider integration before accepting live cards.

This repository is an executable engineering skeleton, not a production-ready or PCI-certified POS. Authentication/RBAC, transactional webhook inbox processing, fully atomic financial finalization, and a real provider's durable settlement cursor remain deployment work.

## What is included

- React register interface for products, cart, checkout, cash, and simulated card payments.
- Fastify API with authoritative totals, idempotent money mutations, refunds, receipts, webhooks, and health endpoints.
- Domain state machines for carts, orders, payment attempts, payments, and refunds.
- Provider-neutral payment contract plus a deterministic simulated terminal.
- In-memory persistence for a zero-setup demo and PostgreSQL persistence for durable environments.
- Outbox, audit, and reconciliation foundations.
- Tests for money calculations, transitions, idempotency, payment failures, and API workflows.

## Prerequisites

- Node.js 22 or newer.
- npm 11 or newer.
- Docker, only if using PostgreSQL locally.

## Run the zero-setup demo

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. With no `DATABASE_URL`, the API uses an in-memory repository populated with sample products.

The simulator uses the final two cents of the total:

- `01` returns a decline.
- `02` first returns an unknown result and resolves when its status is queried.
- Every other amount succeeds.

No card number, CVV, PIN, track data, or EMV data is collected by this project.

The refund endpoint is disabled unless `MANAGER_API_KEY` is configured. The key is a development safeguard, not a substitute for staff authentication and RBAC.

## Run with PostgreSQL

```sh
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

Root scripts load `.env` when it exists. The register build also reads its `VITE_` variables from that root file.

## Verify the project

```sh
npm run verify
```

`GET /health` is a process liveness check. `GET /ready` also checks the configured repository.

## Workspace layout

```text
apps/register                 Cashier UI
apps/api                      HTTP API and webhook ingress
apps/worker                   Outbox/reconciliation worker
packages/domain               Pure business model and state machines
packages/application          Checkout, pay, refund, and receipt use cases
packages/payment-contract     Certified-provider boundary
packages/payments-simulated   Development-only terminal adapter
packages/persistence          Memory/PostgreSQL repositories and migrations
docs                          Architecture, security, and provider checklists
```

## Before a real-card pilot

1. Select the target country, acquirer, exact terminal model, firmware, and integration mode.
2. Replace the simulator with the provider's certified SDK/API adapter.
3. Confirm Visa, Mastercard, Amex, JCB, and UnionPay separately for insert and tap.
4. Obtain the terminal's PCI PTS, P2PE, EMV L1/L2, and processor-specific L3 evidence.
5. Have the acquirer or a qualified assessor confirm the applicable PCI DSS validation path.
6. Complete production UAT with physical test cards and reconcile test settlements.

See [the provider acceptance checklist](docs/provider-acceptance-checklist.md) and [security boundaries](docs/security.md).
