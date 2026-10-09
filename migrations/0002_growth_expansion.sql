PRAGMA foreign_keys = ON;

ALTER TABLE accounts ADD COLUMN pipeline TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE conversations ADD COLUMN pipeline TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE conversations ADD COLUMN opportunity_id TEXT;

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT,
  external_id TEXT,
  buyer_name TEXT,
  country_code TEXT,
  deadline TEXT,
  estimated_value REAL,
  currency TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  summary TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_source_external
  ON opportunities(source, external_id)
  WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_source_url
  ON opportunities(source, source_url)
  WHERE source_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_opportunities_kind_score
  ON opportunities(kind, status, score DESC);

CREATE INDEX IF NOT EXISTS idx_opportunities_deadline
  ON opportunities(deadline);

CREATE TABLE IF NOT EXISTS opportunity_handoffs (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL UNIQUE REFERENCES opportunities(id) ON DELETE CASCADE,
  priority TEXT NOT NULL DEFAULT 'normal',
  reason TEXT NOT NULL,
  briefing_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opportunity_handoffs_status
  ON opportunity_handoffs(status, created_at DESC);

INSERT OR IGNORE INTO settings (key,value,updated_at)
VALUES ('outreach_ramp_cap','5',datetime('now'));
