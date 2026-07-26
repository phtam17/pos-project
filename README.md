# Open POS skeleton

[![CI](https://github.com/phtam17/pos-project/actions/workflows/ci.yml/badge.svg)](https://github.com/phtam17/pos-project/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A processor-neutral point-of-sale starter for a single merchant. It deliberately keeps payment-card data outside the application: the register sends an amount and merchant reference to a payment-provider adapter and stores only the provider result and receipt-safe metadata.

The included card and Vietnam QR providers are simulators. They are suitable for development only and must be replaced by contracted, certified provider integrations before accepting live payments.

This repository is an executable engineering skeleton, not a production-ready or PCI-certified POS. It now has sandbox staff roles, manager-bound refund approvals, a transactional webhook inbox, rate limits, audit history, redacted API logs, and demo reset controls. Those controls demonstrate the intended design; trusted identity, distributed rate limiting, fully atomic financial finalization, hardened secret storage, and a real provider's durable settlement cursor remain deployment work.

## What is included

- React register interface for products, cart, checkout, cash, simulated card payments, and a Vietnam QR sandbox.
- Fastify API with authoritative totals, idempotent money mutations, refunds, receipts, webhooks, and health endpoints.
- Domain state machines for carts, orders, payment attempts, payments, and refunds.
- Provider-neutral payment contracts plus deterministic card and Vietnam QR simulators.
- In-memory persistence for a zero-setup demo and PostgreSQL persistence for durable environments.
- Staff login, cashier/manager roles, manager-authorized refunds, audit history, and sandbox reset controls.
- Transactional webhook inbox deduplication, redacted API logging, rate limiting, outbox, and reconciliation foundations.
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

Sign in with one of the local sandbox accounts:

- Cashier: `cashier-01` / `1234`
- Manager: `manager-01` / `2468`

The manager account can open **Manage**. The cashier account can run sales and can
request a refund, but a manager must enter their own PIN to approve the exact
payment and amount. These credentials are intentionally visible for a local demo;
the register hides them when `PUBLIC_SANDBOX=true`.

The top-right environment control reports `Sandbox · Memory` or
`Sandbox · PostgreSQL` and shows live readiness for the API, persistence layer,
card simulator, Vietnam QR simulator, staff authentication, and reset controls. An
always-visible banner states that the build is simulation-only. In memory mode, the
register also warns that restarting the API erases demo transactions.

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
3. Choose **VCB Digibank**, **MoMo**, **ZaloPay**, or **ShopeePay VN** to record
   the customer opening/scanning the QR before approval.
4. Use **Approve now**, **Approve after 5s**, or **Duplicate callback**. The register
   polls the original payment attempt every 1.5 seconds and automatically detects
   an expired quote without creating a replacement charge.
5. Use **Decline** or **Expire now** to exercise the terminal recovery paths.
6. The live panel, order detail, and receipt show the selected wallet, approximate
   VND amount, illustrative FX rate, 2.5% fee, merchant net, and payment timeline.

The displayed QR encodes a sandbox URL and cannot be paid by a real banking app. The
simulator uses an illustrative VND rate of 25,500 VND/USD and a 2.5% settlement fee
so FX, fee, refund, and reconciliation behavior can be developed before an acquirer
provides real sandbox credentials. Neither value is a commercial quote.

The payment-attempt snapshot persists the wallet selection, VND quote, exchange
rate, fee, net amount, expiration, and idempotent timeline events. The timeline
records QR creation, customer scan, approval, provider confirmation, settlement,
refunds, delayed callbacks, and ignored duplicates. PostgreSQL therefore retains
the demonstration data across API restarts instead of reconstructing it from a
provider-reference string.

## Test order history and refunds

The **Orders** tab is backed by the API repository, not browser session state. It can
search by order number, item name, or SKU; filter by status; open payment details;
reprint a refund-aware receipt; and issue full or partial sandbox refunds.

1. Sign in as the cashier or manager and complete a card, cash, or Vietnam QR
   sandbox sale.
2. Open **Orders**, select the sale, and choose **Refund**.
3. Choose **Full remaining** or enter a smaller amount.
4. Enter `manager-01` and the local manager PIN, `2468`. The API issues a
   short-lived signed approval bound to the requesting staff session, payment ID,
   exact amount, and idempotent refund operation; changing or reusing it for a
   different operation makes the approval invalid.
5. Confirm the refund. The order detail and receipt show the refund history, the
   refunded amount, and the remaining net payment. A fully refunded order moves to
   the **Refunded** status filter.

Memory mode keeps order history only until the API process restarts. PostgreSQL mode
persists the same history across restarts; use the PostgreSQL setup below when you
want to demonstrate that behavior.

## Manage the sandbox merchant

Open **Manage** to maintain the demo without editing seed files:

- Create and edit products, assign categories and barcodes, configure prices and
  tax rates, and activate or deactivate catalog entries.
- Set the store, location, register, and currency labels used by the register.
- Customize receipt headers, footers, and SKU visibility.
- Enable authoritative line discounts and optional tip shortcuts. Discounted
  taxable amounts, tax, tips, checkout totals, orders, and receipts are calculated
  by the API rather than trusted from the browser.
- Review actor-attributed audit history and manually reset all transaction data
  while retaining the catalog and merchant configuration.

Merchant settings and catalog edits last until restart in memory mode and persist
across restarts in PostgreSQL mode. Changing the merchant currency affects newly
created carts; an already-open cart keeps its original currency snapshot.

## Share a sandbox demo safely

The API refuses any `APP_MODE` except `sandbox`; this codebase cannot be switched
into a live-looking payment mode. For a demo exposed beyond your own computer, set
`PUBLIC_SANDBOX=true`. Startup then requires all of the following:

- newly generated `AUTH_SECRET` and `SIMULATED_WEBHOOK_SECRET` values of at least
  32 characters (the example and development placeholders are rejected);
- guest-only access by default; if `PUBLIC_STAFF_LOGIN_ENABLED=true`, distinct
  non-default cashier and manager PINs of at least six digits;
- explicit HTTPS `CORS_ORIGINS`, or a same-origin production build served from
  `STATIC_DIR` with cross-origin access disabled;
- `RATE_LIMIT_ENABLED=true`;
- authentication and automatic demo reset enabled, with a positive
  `DEMO_RESET_INTERVAL_MINUTES`.

Public mode adds a one-click **Enter sandbox demo** option. Each visitor receives a
signed guest session whose carts, orders, payment attempts, payments, and receipts
are isolated from every other visitor. Guest access is cashier-only: it cannot open
merchant management, reconciliation, audit history, or manager-authorized refunds.
The public deployment disables the staff login API and form unless the owner
explicitly opts in with `PUBLIC_STAFF_LOGIN_ENABLED=true` and hardened PINs.

The built-in limiter is process-local and suitable only for this single-process
sandbox. Use a shared store, trusted identity provider, TLS, and a real secret
manager before treating any deployment as production infrastructure.

## Deploy the public sandbox

`Dockerfile` builds one production container that serves the register and API
from the same origin. `render.yaml` defines a cost-bounded Render Blueprint with
one free web instance, managed PostgreSQL, generated secrets, migrations,
sample catalog seeding, CI-gated deploys, health checks, and hourly resets.

The Blueprint is configuration only: it does not create resources or charges
until you review and apply it from your own Render account. Render's free
PostgreSQL database expires after 30 days and has no backups, so this path is a
disposable public demonstration rather than durable hosting.

See [the public deployment guide](docs/public-deployment.md) for deployment,
monitoring, spending safeguards, and the GitHub security settings to enable
after the repository becomes public.

## Run with PostgreSQL

```sh
cp .env.example .env
# Ensure PERSISTENCE_MODE=postgres in .env.
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

The Compose database port is bound to `127.0.0.1` so PostgreSQL is reachable from
the host development tools without being exposed on every network interface.

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

## License, security, and privacy

Open POS is available under the [Apache License 2.0](LICENSE). Report security
issues through the private process in [SECURITY.md](SECURITY.md), and review the
[public sandbox privacy note](PRIVACY.md) before hosting the demo. Contributions
should follow [CONTRIBUTING.md](CONTRIBUTING.md).
