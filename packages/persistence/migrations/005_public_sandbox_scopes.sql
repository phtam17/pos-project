ALTER TABLE carts
  ADD COLUMN IF NOT EXISTS sandbox_scope_id text NOT NULL DEFAULT 'shared';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS sandbox_scope_id text NOT NULL DEFAULT 'shared';

CREATE INDEX IF NOT EXISTS carts_sandbox_scope_idx
  ON carts (sandbox_scope_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS orders_sandbox_scope_idx
  ON orders (sandbox_scope_id, created_at DESC);
