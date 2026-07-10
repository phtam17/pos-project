CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tax_rate_bps integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 100000),
  active boolean NOT NULL DEFAULT true,
  snapshot jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_active_name_idx ON products (active, name);

CREATE TABLE IF NOT EXISTS carts (
  id text PRIMARY KEY,
  location_id text NOT NULL DEFAULT 'default',
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CHECKED_OUT', 'ABANDONED')),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  snapshot jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS carts_location_status_idx ON carts (location_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS cart_lines (
  id text PRIMARY KEY,
  cart_id text NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id text REFERENCES products(id) ON DELETE SET NULL,
  sku text NOT NULL,
  name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tax_rate_bps integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 100000),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cart_lines_cart_idx ON cart_lines (cart_id);

CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  order_number text NOT NULL UNIQUE,
  cart_id text UNIQUE REFERENCES carts(id) ON DELETE SET NULL,
  location_id text NOT NULL DEFAULT 'default',
  register_id text NOT NULL DEFAULT 'default',
  status text NOT NULL CHECK (status IN ('OPEN', 'PAYMENT_PENDING', 'PAID', 'CANCELED', 'REFUNDED')),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  snapshot jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS orders_location_created_idx ON orders (location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_lines (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  product_id text,
  sku text NOT NULL,
  name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tax_rate_bps integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 100000),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  line_subtotal_minor bigint NOT NULL CHECK (line_subtotal_minor >= 0),
  line_tax_minor bigint NOT NULL DEFAULT 0 CHECK (line_tax_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS order_lines_order_idx ON order_lines (order_id);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_reference text,
  terminal_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('CREATED', 'AWAITING_CARD', 'PROCESSING', 'CAPTURED', 'DECLINED', 'CANCELED', 'UNKNOWN')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key text NOT NULL UNIQUE,
  failure_code text,
  failure_message text,
  card_brand text,
  card_last4 varchar(4),
  entry_method text,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  snapshot jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_provider_reference_idx
  ON payment_attempts (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_attempts_order_idx ON payment_attempts (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_attempts_unknown_idx ON payment_attempts (updated_at)
  WHERE status = 'UNKNOWN';

CREATE TABLE IF NOT EXISTS payments (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  attempt_id text NOT NULL UNIQUE REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_payment_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  card_brand text,
  card_last4 varchar(4),
  entry_method text,
  snapshot jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);

CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS payments_captured_idx ON payments (captured_at DESC);

CREATE TABLE IF NOT EXISTS refunds (
  id text PRIMARY KEY,
  payment_id text NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_refund_id text,
  status text NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key text NOT NULL UNIQUE,
  reason text,
  failure_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  processed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS refunds_provider_reference_idx
  ON refunds (provider, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS refunds_payment_idx ON refunds (payment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
  response_status integer,
  response_body jsonb,
  resource_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idempotency_records_expiry_idx ON idempotency_records (expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  action text NOT NULL,
  actor_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_aggregate_idx
  ON audit_events (aggregate_type, aggregate_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS outbox_events (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  locked_until timestamptz
);

CREATE INDEX IF NOT EXISTS outbox_events_pending_idx
  ON outbox_events (occurred_at)
  WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS settlement_batches (
  id text PRIMARY KEY,
  provider text NOT NULL,
  provider_batch_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'RECONCILED')),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_minor bigint NOT NULL,
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  refund_minor bigint NOT NULL DEFAULT 0 CHECK (refund_minor >= 0),
  net_minor bigint NOT NULL,
  payout_id text,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_batch_id),
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS settlement_batches_period_idx
  ON settlement_batches (period_start, period_end);

CREATE TABLE IF NOT EXISTS settlement_lines (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES settlement_batches(id) ON DELETE CASCADE,
  payment_id text REFERENCES payments(id) ON DELETE RESTRICT,
  refund_id text REFERENCES refunds(id) ON DELETE RESTRICT,
  provider_transaction_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('PAYMENT', 'REFUND', 'FEE', 'ADJUSTMENT')),
  gross_minor bigint NOT NULL,
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  net_minor bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (batch_id, provider_transaction_id),
  CHECK (num_nonnulls(payment_id, refund_id) <= 1)
);

CREATE INDEX IF NOT EXISTS settlement_lines_payment_idx ON settlement_lines (payment_id)
  WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS settlement_lines_refund_idx ON settlement_lines (refund_id)
  WHERE refund_id IS NOT NULL;
