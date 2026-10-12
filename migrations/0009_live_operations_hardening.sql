PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS outbound_dispatches (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  classification TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  claim_token TEXT NOT NULL,
  provider_id TEXT,
  message_id TEXT,
  claimed_at TEXT NOT NULL,
  sent_at TEXT,
  failed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbound_dispatches_status
  ON outbound_dispatches(status, claimed_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_key TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received
  ON webhook_events(received_at DESC);

CREATE TABLE IF NOT EXISTS operations_alerts (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  detail_json TEXT NOT NULL DEFAULT '{}',
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_operations_alerts_status
  ON operations_alerts(status, severity, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS dead_letters (
  id TEXT PRIMARY KEY,
  job_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'retrying',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_status
  ON dead_letters(status, created_at DESC);

CREATE TABLE IF NOT EXISTS deliverability_checks (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  check_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliverability_checks_domain
  ON deliverability_checks(domain, checked_at DESC);

CREATE TABLE IF NOT EXISTS daily_commercial_reports (
  report_date TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS conversion_attribution (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  stage TEXT NOT NULL,
  source TEXT NOT NULL,
  value REAL,
  currency TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversion_attribution_account
  ON conversion_attribution(account_id, occurred_at DESC);

INSERT OR IGNORE INTO settings (key,value,updated_at)
VALUES
  ('outbound_paused','false',datetime('now')),
  ('outbound_pause_reason','',datetime('now')),
  ('outbound_pause_source','',datetime('now'));
