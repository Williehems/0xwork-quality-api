-- 0xwork-quality-api schema

CREATE TABLE IF NOT EXISTS wallet_bindings (
  tg_user_id   BIGINT PRIMARY KEY,
  tg_username  TEXT,
  wallet       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wallet_bindings ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;
UPDATE wallet_bindings SET onboarded_at = updated_at WHERE onboarded_at IS NULL;

CREATE INDEX IF NOT EXISTS wallet_bindings_wallet_idx ON wallet_bindings (LOWER(wallet));

CREATE TABLE IF NOT EXISTS runtime_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS comment_seen (
  tg_user_id   BIGINT NOT NULL,
  task_id      BIGINT NOT NULL,
  last_count   INT    NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tg_user_id, task_id)
);

CREATE TABLE IF NOT EXISTS submission_notified (
  tg_user_id  BIGINT NOT NULL,
  task_id     BIGINT NOT NULL,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tg_user_id, task_id)
);
