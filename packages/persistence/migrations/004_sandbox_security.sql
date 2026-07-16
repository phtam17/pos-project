CREATE TABLE IF NOT EXISTS provider_webhook_inbox (
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  received_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  processed_at timestamptz,
  last_error text,
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS provider_webhook_inbox_status_idx
  ON provider_webhook_inbox (status, updated_at);
