# `@pos/persistence`

The persistence package keeps the application independent of its storage engine.
`createRepository()` selects a seeded `MemoryPosRepository` when `DATABASE_URL` is
not set and a pooled `PostgresPosRepository` when it is set.

```ts
import { createRepository } from "@pos/persistence";

const repository = createRepository();
const products = await repository.listProducts({ activeOnly: true });
```

PostgreSQL setup:

```sh
DATABASE_URL=postgres://... npm run db:migrate
DATABASE_URL=postgres://... npm run db:seed
```

All monetary columns are PostgreSQL `bigint`. The adapter sends minor units as
decimal strings and reconstructs domain `Money` values with `BigInt`; floating
point values never cross the database boundary. Normalized columns support
constraints, indexes, and reconciliation, while an encoded aggregate snapshot
preserves immutable checkout data and domain timestamps.

The initial migration includes products, versioned carts and orders, payment
attempts, captured payments, refunds, idempotency records, append-only audit
events, an outbox, and settlement batches/lines. Run migrations before starting
an API configured with PostgreSQL.
