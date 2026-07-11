ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_idempotency_key_key;

ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_order_id_idempotency_key_key
  UNIQUE (order_id, idempotency_key);

ALTER TABLE refunds
  DROP CONSTRAINT IF EXISTS refunds_idempotency_key_key;

ALTER TABLE refunds
  ADD CONSTRAINT refunds_payment_id_idempotency_key_key
  UNIQUE (payment_id, idempotency_key);
