# Public sandbox deployment

This guide publishes the simulator as an anonymous demonstration. It does not
turn VariPOS into a real payment system.

## Deployment shape

The production container serves the built React register and Fastify API from
one origin. The included `render.yaml` provisions:

- one free Render web service built from `Dockerfile`;
- one free managed Render PostgreSQL database with public database access
  blocked;
- database migrations and idempotent sample-product seeding before deploy;
- generated 256-bit authentication and webhook secrets;
- guest-only access, hourly transaction resets, CI-gated automatic deploys,
  one instance, no preview environments, and a `/ready` health check.

Public mode also resets transaction data at every process start. This matters on
free hosting because a sleeping service cannot run its hourly timer; waking or
restarting the service still begins from a clean transaction dataset.

The same-origin design deliberately disables cross-origin API access. Render
terminates HTTPS at its load balancer and forwards traffic to the container.

## Deploy with Render Blueprint

1. Push `main` and wait for the `verify` GitHub Actions workflow to pass.
2. In Render, choose **New → Blueprint** and connect this repository.
3. Review the two resources from `render.yaml` before applying them. The file
   explicitly selects the free plans; do not accept an unexpected paid-plan
   substitution.
4. Apply the Blueprint. Render builds the container, runs `npm run db:prepare`,
   and checks `/ready` before routing traffic to it.
5. Open the generated `onrender.com` URL. The page should show only **Enter
   sandbox demo**—not staff ID or PIN fields.
6. Confirm `GET /health` returns `status: live`, `GET /ready` returns
   `status: ready`, and the environment panel reports PostgreSQL.

No custom `VITE_API_BASE_URL` or CORS origin is required because the browser
and API share the same HTTPS origin.

## Free-tier limitations and cost guardrails

As of July 2026, Render's free PostgreSQL databases expire after 30 days, have
no backups, and may restart or undergo maintenance. Free web services can spin
down and have monthly usage limits. This is appropriate for a disposable
sandbox, not a durable pilot.

Before applying the Blueprint:

- leave the Render workspace without a payment method if service suspension is
  preferable to any surprise charge; or set the build-pipeline monthly spend
  limit to `$0` in **Workspace Settings → Build Pipeline**;
- keep preview environments disabled and the service at one instance;
- enable email notifications for failed deploys and unhealthy services in
  **Integrations → Notifications**;
- review the workspace Billing page periodically for free-instance hours,
  bandwidth, and pipeline-minute usage.

For a longer-lived demo, deliberately select a paid PostgreSQL plan after
reviewing current pricing and backup behavior. Never upgrade by accident: the
Blueprint keeps `plan: free` until it is consciously edited.

## Monitoring and operations

Render uses `/ready` for deployment and uptime health. `/health` remains a
lightweight liveness endpoint suitable for an external uptime monitor. Fastify
emits structured request and error logs and redacts authorization headers,
manager credentials, PINs, and raw webhook bodies.

Recommended public-demo checks:

- alert on repeated `/ready` failures and HTTP 5xx responses;
- retain only the minimum logs needed to diagnose the sandbox;
- confirm the hourly reset continues advancing in the environment panel;
- rotate `AUTH_SECRET` and `SIMULATED_WEBHOOK_SECRET` after any suspected
  exposure (existing sessions become invalid);
- redeploy or retire the URL before the free database expires.

## Staff access

`PUBLIC_STAFF_LOGIN_ENABLED=false` is the safe default. It disables both the
staff login API and the corresponding form. Guests cannot obtain manager
approvals, issue refunds, manage the catalog, view reconciliation, or read the
shared audit log.

If owner staff access is intentionally enabled on a public URL, set
`PUBLIC_STAFF_LOGIN_ENABLED=true` and provide distinct non-default cashier and
manager PINs of at least six digits. A separate access-controlled owner
deployment is safer than exposing staff authentication beside an anonymous
demo.

## GitHub security settings

After changing the repository visibility to public:

1. Enable private vulnerability reporting.
2. Enable Dependabot alerts and security updates.
3. Enable secret scanning and push protection.
4. Confirm the CodeQL workflow completes under **Security**.
5. Protect `main` so the `verify` check must pass before future changes or
   deployments.

The repository includes `SECURITY.md`, weekly Dependabot configuration, and a
public-repository CodeQL workflow. GitHub's platform security features must
still be enabled in repository settings where they are not automatic.
