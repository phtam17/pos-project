ALTER TABLE products
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'Other',
  ADD COLUMN IF NOT EXISTS barcode text;

CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_idx
  ON products (barcode)
  WHERE barcode IS NOT NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tip_minor bigint NOT NULL DEFAULT 0 CHECK (tip_minor >= 0);

CREATE TABLE IF NOT EXISTS merchant_settings (
  id text PRIMARY KEY,
  version bigint NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
