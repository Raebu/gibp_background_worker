PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT,
  domain TEXT,
  country_code TEXT,
  account_type TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'candidate',
  score INTEGER NOT NULL DEFAULT 0,
  fit_score INTEGER NOT NULL DEFAULT 0,
  signal_score INTEGER NOT NULL DEFAULT 0,
  engagement_score INTEGER NOT NULL DEFAULT 0,
  risk_score INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  source_url TEXT,
  research_json TEXT NOT NULL DEFAULT '{}',
  last_researched_at TEXT,
  next_action_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_domain ON accounts(lower(domain)) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_status_score ON accounts(status, score DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_next_action ON accounts(next_action_at);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT,
  role TEXT,
  email TEXT NOT NULL,
  email_source TEXT NOT NULL DEFAULT 'public_web',
  source_url TEXT,
  country_code TEXT,
  timezone TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  seniority_score INTEGER NOT NULL DEFAULT 0,
  consent_status TEXT NOT NULL DEFAULT 'unknown',
  lawful_basis TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_contact_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON contacts(lower(email));
CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status, seniority_score DESC);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  source TEXT,
  observed_at TEXT NOT NULL,
  strength INTEGER NOT NULL DEFAULT 10,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_unique_url ON signals(account_id, url) WHERE url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signals_account_time ON signals(account_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'discovery',
  score INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  outbound_count INTEGER NOT NULL DEFAULT 0,
  inbound_count INTEGER NOT NULL DEFAULT 0,
  next_action_at TEXT,
  human_handoff_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_contact_open ON conversations(contact_id) WHERE state NOT IN ('closed','lost');
CREATE INDEX IF NOT EXISTS idx_conversation_due ON conversations(state, next_action_at);
CREATE INDEX IF NOT EXISTS idx_conversation_score ON conversations(score DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  provider_id TEXT,
  message_id TEXT,
  subject TEXT,
  text TEXT,
  classification TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages(provider_id);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);

CREATE TABLE IF NOT EXISTS website_intent (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  path TEXT,
  weight INTEGER NOT NULL DEFAULT 5,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intent_conversation ON website_intent(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jurisdiction_policies (
  country_code TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 0,
  requires_consent INTEGER NOT NULL DEFAULT 1,
  allow_corporate_b2b INTEGER NOT NULL DEFAULT 0,
  max_initial_per_day INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  locked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  priority TEXT NOT NULL DEFAULT 'normal',
  reason TEXT NOT NULL,
  briefing_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_category_time ON audit_events(category, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR REPLACE INTO jurisdiction_policies
(country_code, mode, allowed, requires_consent, allow_corporate_b2b, max_initial_per_day, notes, updated_at)
VALUES
('GB','corporate_b2b',1,0,1,20,'Corporate B2B only. Personal-data rules, transparency and objection/opt-out handling still apply.',datetime('now')),
('US','corporate_b2b',1,0,1,20,'Commercial email must satisfy CAN-SPAM requirements including identification, postal address and opt-out.',datetime('now')),
('CA','consent_only',1,1,1,10,'Send only where express or qualifying implied consent is recorded.',datetime('now')),
('AU','consent_only',1,1,1,10,'Send only where consent is recorded; sender identification and unsubscribe are required.',datetime('now'));
