CREATE TABLE IF NOT EXISTS contact_email_verifications (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  result TEXT NOT NULL,
  reason TEXT,
  safe_to_send INTEGER NOT NULL DEFAULT 0,
  disposable INTEGER NOT NULL DEFAULT 0,
  accept_all INTEGER NOT NULL DEFAULT 0,
  role INTEGER NOT NULL DEFAULT 0,
  free INTEGER NOT NULL DEFAULT 0,
  did_you_mean TEXT,
  mx_domain TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  verified_at TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_email_verifications_provider
  ON contact_email_verifications(contact_id, provider);

CREATE INDEX IF NOT EXISTS idx_contact_email_verifications_safe
  ON contact_email_verifications(provider, safe_to_send, verified_at DESC);
