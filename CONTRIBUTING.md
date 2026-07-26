# Contributing

VariPOS welcomes focused improvements to the sandbox architecture, register
experience, tests, and documentation.

Before opening an issue or pull request:

- read `README.md`, `SECURITY.md`, and `docs/security.md`;
- use only synthetic sandbox data—never include card numbers, bank credentials,
  customer personal information, provider secrets, or production payloads;
- keep real provider integrations behind the provider-neutral adapter boundary;
- preserve the visible simulation-only disclosures.

## Local workflow

```sh
npm ci
npm run verify
```

The API uses memory persistence when no `DATABASE_URL` is configured. For a
PostgreSQL change, also start the Compose database, run migrations and seeding,
and execute `npm run smoke:postgres` as described in `README.md`.

Prefer a small change with tests demonstrating the intended failure and
behavior. Update the relevant architecture or security documentation when a
trust boundary, persistence guarantee, or payment state changes.

By submitting a contribution, you agree that it may be distributed under the
repository's Apache License 2.0.
