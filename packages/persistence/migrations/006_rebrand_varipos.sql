-- Update only the former project-default merchant name. Customized names are preserved.
UPDATE merchant_settings
SET snapshot = jsonb_set(snapshot, '{merchantName}', to_jsonb('VariPOS'::text), false)
WHERE id = 'default'
  AND snapshot ->> 'merchantName' = 'Open POS';
