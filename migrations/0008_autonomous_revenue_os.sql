PRAGMA foreign_keys = ON;

ALTER TABLE accounts ADD COLUMN priority_adjustment INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN partner_track TEXT;
ALTER TABLE conversations ADD COLUMN qualification_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN nurture_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN last_signal_at TEXT;

CREATE TABLE IF NOT EXISTS account_dossiers (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  current_initiatives_json TEXT NOT NULL DEFAULT '[]',
  likely_problem TEXT,
  likely_use_cases_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  stakeholder_map_json TEXT NOT NULL DEFAULT '[]',
  recommended_offer TEXT,
  objections_json TEXT NOT NULL DEFAULT '[]',
  next_best_action TEXT,
  confidence INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_dossiers_confidence
  ON account_dossiers(confidence DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS qualification_profiles (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  problem TEXT,
  architecture TEXT,
  objective TEXT,
  geography TEXT,
  scale_context TEXT,
  budget_context TEXT,
  timeline TEXT,
  decision_process TEXT,
  influence TEXT,
  stakeholders_json TEXT NOT NULL DEFAULT '[]',
  missing_json TEXT NOT NULL DEFAULT '[]',
  completeness INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_stakeholders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  name TEXT,
  role TEXT,
  email TEXT,
  influence_score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'identified',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_stakeholders_source
  ON account_stakeholders(account_id, source, source_key);
CREATE INDEX IF NOT EXISTS idx_account_stakeholders_account
  ON account_stakeholders(account_id, influence_score DESC);

CREATE TABLE IF NOT EXISTS conversion_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  score INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversion_requests_status
  ON conversion_requests(status, score DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_requests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  booking_url TEXT,
  scheduled_at TEXT,
  provider_response_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meeting_requests_conversation
  ON meeting_requests(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_requests_status
  ON meeting_requests(status, scheduled_at);

CREATE TABLE IF NOT EXISTS authority_briefings (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  topic_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  executive_summary TEXT NOT NULL,
  key_points_json TEXT NOT NULL DEFAULT '[]',
  source_json TEXT NOT NULL DEFAULT '[]',
  affected_accounts_json TEXT NOT NULL DEFAULT '[]',
  score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_authority_briefings_status
  ON authority_briefings(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS commercial_outcomes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL,
  value REAL,
  currency TEXT,
  reason TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commercial_outcomes_account
  ON commercial_outcomes(account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_commercial_outcomes_outcome
  ON commercial_outcomes(outcome, occurred_at DESC);

CREATE TABLE IF NOT EXISTS commercial_learnings (
  dimension TEXT NOT NULL,
  dimension_value TEXT NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  positive_count INTEGER NOT NULL DEFAULT 0,
  serious_count INTEGER NOT NULL DEFAULT 0,
  won_count INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (dimension, dimension_value)
);

CREATE TABLE IF NOT EXISTS jurisdiction_policy_evidence (
  country_code TEXT PRIMARY KEY REFERENCES jurisdiction_policies(country_code) ON DELETE CASCADE,
  source_title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  review_due_at TEXT NOT NULL,
  notes TEXT
);

INSERT OR REPLACE INTO jurisdiction_policy_evidence
  (country_code,source_title,source_url,reviewed_at,review_due_at,notes)
VALUES
  ('GB','ICO business-to-business marketing guidance','https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/',datetime('now'),datetime('now','+180 day'),'Corporate B2B policy evidence. Named-person data still requires UK GDPR handling and objection rights.'),
  ('US','FTC CAN-SPAM compliance guide','https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business',datetime('now'),datetime('now','+180 day'),'Commercial email policy evidence.'),
  ('CA','CRTC CASL guidance','https://crtc.gc.ca/eng/com500/guide.htm',datetime('now'),datetime('now','+180 day'),'Consent-oriented policy evidence.'),
  ('AU','ACMA spam compliance guidance','https://www.acma.gov.au/spam-compliance',datetime('now'),datetime('now','+180 day'),'Consent-oriented policy evidence.');


CREATE TABLE IF NOT EXISTS approved_evidence (
  id TEXT PRIMARY KEY,
  evidence_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'approved',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approved_evidence_category
  ON approved_evidence(category,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS search_demand (
  query TEXT PRIMARY KEY,
  landing_path TEXT,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  average_position REAL,
  country_code TEXT,
  source TEXT NOT NULL DEFAULT 'search_console',
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_demand_opportunity
  ON search_demand(clicks DESC,impressions DESC,average_position);
