import { SimulatedPaymentProvider } from "@pos/payments-simulated";
import { createRepository } from "@pos/persistence";

import { runWorkerOnce } from "./worker.js";

const repository = createRepository({
  ...(process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {})
});
const provider = new SimulatedPaymentProvider({
  webhookSecret: process.env.SIMULATED_WEBHOOK_SECRET ?? "development-only-secret"
});

try {
  const result = await runWorkerOnce({
    repository,
    provider,
    ...(process.env.SETTLEMENT_CURSOR
      ? { settlementCursor: process.env.SETTLEMENT_CURSOR }
      : {})
  });
  console.info(JSON.stringify({ worker: "complete", ...result }));
} finally {
  await repository.close();
}
