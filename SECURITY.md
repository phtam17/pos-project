# Security policy

Open POS is a sandbox engineering project. It does not process real card or QR
payments and is not PCI-certified. Please never submit real cardholder data,
bank credentials, production secrets, personal information, or live payment
provider payloads to this repository or its demo.

## Supported version

Security fixes are made on the latest `main` branch. There are no supported
production releases yet.

## Report a vulnerability privately

Use **Security → Advisories → Report a vulnerability** in this GitHub
repository. Do not put exploit details, secrets, or personal data in a public
issue. If private vulnerability reporting is temporarily unavailable, open a
public issue containing only a request for a private reporting channel and no
sensitive technical details.

Include, when safe:

- the affected commit or version;
- the security impact and prerequisites;
- minimal reproduction steps using synthetic sandbox data;
- suggested remediation, if known.

The project aims to acknowledge reports within seven days, but this is a
personal side project and response or remediation times cannot be guaranteed.
Coordinated disclosure is requested until a fix is available.

## Scope

In scope are authorization bypasses, cross-guest data access, secret or
prohibited payment-data exposure, refund/amount integrity failures, webhook or
idempotency bypasses, and vulnerabilities in the public sandbox deployment.

The intentionally simulated payment results, illustrative FX/fee values,
automatic demo reset, lack of uptime guarantees, and loss of free-tier demo
data are not vulnerabilities.

See [docs/security.md](docs/security.md) for the system's trust boundaries and
the controls still required before any real-money deployment.
