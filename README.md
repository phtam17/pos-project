# Open POS skeleton

A processor-neutral point-of-sale starter for a single merchant. It deliberately keeps payment-card data outside the application: the register sends an amount and merchant reference to a payment-provider adapter and stores only the provider result and receipt-safe metadata.

The included card and Vietnam QR providers are simulators. They are suitable for development only and must be replaced by contracted, certified provider integrations before accepting live payments.

This repository is an executable engineering skeleton, not a production-ready or PCI-certified POS. Authentication/RBAC, transactional webhook inbox processing, fully atomic financial finalization, and a real provider's durable settlement cursor remain deployment work.

## What is included

- React register interface for products, cart, checkout, cash, simulated card payments, and a Vietnam QR sandbox.
- Fastify API with authoritative totals, idempotent money mutations, refunds, receipts, webhooks, and health endpoints.
- Domain state machines for carts, orders, payment attempts, payments, and refunds.
- Provider-neutral payment contracts plus deterministic card and Vietnam QR simulators.
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

If an existing `.env` contains a PostgreSQL URL but Docker is not running, set
`PERSISTENCE_MODE=memory`. This explicitly selects the zero-setup sandbox and
prevents the API from trying the inactive database.

The simulator uses the final two cents of the total:

- `01` returns a decline.
- `02` first returns an unknown result and resolves when its status is queried.
- Every other amount succeeds.

No card number, CVV, PIN, track data, or EMV data is collected by this project.

## Try the Vietnam QR sandbox

The zero-setup demo includes a separate `Vietnam QR` tender that models the proposed
Alipay+ flow without moving real money:

1. Add products to the cart and select **Vietnam QR**.
2. The register creates an order-specific, expiring QR code.
3. Choose **VCB Digibank**, **MoMo**, **ZaloPay**, or **ShopeePay VN** to simulate
   that app sending a signed approval.
4. Use **Simulate decline** or **Expire / cancel QR** to exercise recovery paths.
5. An approved payment produces a normal receipt labeled with the selected wallet.

The displayed QR encodes a sandbox URL and cannot be paid by a real banking app. The
simulator uses an illustrative VND rate of 25,500 VND/USD and a 2.5% settlement fee
so FX, fee, refund, and reconciliation behavior can be developed before an acquirer
provides real sandbox credentials. Neither value is a commercial quote.

## Test order history and refunds

The **Orders** tab is backed by the API repository, not browser session state. It can
search by order number, item name, or SKU; filter by status; open payment details;
reprint a refund-aware receipt; and issue full or partial sandbox refunds.

1. Set a development key in `.env`, for example
   `MANAGER_API_KEY=replace-me-to-enable-refunds`, and restart `npm run dev` if it
   was already running.
2. Complete a card, cash, or Vietnam QR sandbox sale.
3. Open **Orders**, select the sale, and choose **Refund**.
4. Choose **Full remaining** or enter a smaller amount. Enter any non-empty manager
   ID and use the exact `MANAGER_API_KEY` value as the manager key.
5. Confirm the refund. The order detail and receipt show the refund history, the
   refunded amount, and the remaining net payment. A fully refunded order moves to
   the **Refunded** status filter.

Memory mode keeps order history only until the API process restarts. PostgreSQL mode
persists the same history across restarts; use the PostgreSQL setup below when you
want to demonstrate that behavior. The manager key is only a development safeguard,
not a substitute for staff authentication and role-based access control.

## Run with PostgreSQL

```sh
cp .env.example .env
# Ensure PERSISTENCE_MODE=postgres in .env.
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
