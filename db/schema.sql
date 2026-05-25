-- 0xwork-quality-api schema

CREATE TABLE IF NOT EXISTS wallet_bindings (
  tg_user_id   BIGINT PRIMARY KEY,
  tg_username  TEXT,
  wallet       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wallet_bindings_wallet_idx ON wallet_bindings (LOWER(wallet));
