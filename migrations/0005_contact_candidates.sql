PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS contact_candidates (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_person_id TEXT NOT NULL,
  first_name TEXT,
  last_name_display TEXT,
  title TEXT,
  organization_name TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  email_available INTEGER NOT NULL DEFAULT 0,
  email_status_filter TEXT,
  status TEXT NOT NULL DEFAULT 'candidate',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_candidates_provider_person
  ON contact_candidates(provider, account_id, provider_person_id);

CREATE INDEX IF NOT EXISTS idx_contact_candidates_account_score
  ON contact_candidates(account_id, status, score DESC);

CREATE INDEX IF NOT EXISTS idx_contact_candidates_status_score
  ON contact_candidates(status, score DESC);
