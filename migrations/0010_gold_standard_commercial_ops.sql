PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS job_heartbeats (
  job_kind TEXT PRIMARY KEY,
  expected_interval_minutes INTEGER NOT NULL DEFAULT 60,
  last_started_at TEXT,
  last_success_at TEXT,
  last_failed_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_duration_ms INTEGER,
  last_error TEXT,
  last_result_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_governance (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  never_contact INTEGER NOT NULL DEFAULT 0,
  manual_review_required INTEGER NOT NULL DEFAULT 0,
  manual_review_approved_at TEXT,
  vip INTEGER NOT NULL DEFAULT 0,
  strategic_account INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_governance_flags
  ON account_governance(never_contact,manual_review_required,vip,strategic_account);

ALTER TABLE contacts ADD COLUMN identity_verified_at TEXT;
ALTER TABLE contacts ADD COLUMN role_verified_at TEXT;

UPDATE contacts
SET identity_verified_at=COALESCE(identity_verified_at,updated_at),
    role_verified_at=CASE
      WHEN role IS NOT NULL AND trim(role)!=''
      THEN COALESCE(role_verified_at,updated_at)
      ELSE role_verified_at
    END;

CREATE TABLE IF NOT EXISTS contact_data_quality (
  contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  identity_score INTEGER NOT NULL,
  role_score INTEGER NOT NULL,
  source_score INTEGER NOT NULL,
  verification_score INTEGER NOT NULL,
  jurisdiction_score INTEGER NOT NULL,
  freshness_score INTEGER NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  computed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_data_quality_score
  ON contact_data_quality(score,computed_at DESC);

CREATE TABLE IF NOT EXISTS sending_blackouts (
  country_code TEXT NOT NULL,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(country_code,date)
);

CREATE INDEX IF NOT EXISTS idx_sending_blackouts_date
  ON sending_blackouts(date,country_code);

CREATE TABLE IF NOT EXISTS crm_sync_records (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  external_id TEXT,
  direction TEXT NOT NULL DEFAULT 'outbound',
  payload_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_synced_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(provider,entity_type,entity_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_sync_records_status
  ON crm_sync_records(provider,status,updated_at);

CREATE TABLE IF NOT EXISTS crm_inbound_events (
  event_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  primary_metric TEXT NOT NULL DEFAULT 'positive_reply',
  status TEXT NOT NULL DEFAULT 'active',
  min_samples_per_variant INTEGER NOT NULL DEFAULT 50,
  winner_variant_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiment_variants (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 50,
  config_json TEXT NOT NULL DEFAULT '{}',
  is_control INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(experiment_id,variant_key)
);

CREATE TABLE IF NOT EXISTS experiment_assignments (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES experiment_variants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL,
  UNIQUE(experiment_id,contact_id)
);

CREATE INDEX IF NOT EXISTS idx_experiment_assignments_variant
  ON experiment_assignments(variant_id,assigned_at DESC);

CREATE TABLE IF NOT EXISTS experiment_events (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES experiment_assignments(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  value REAL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_experiment_events_assignment
  ON experiment_events(assignment_id,event_type,occurred_at DESC);

CREATE TABLE IF NOT EXISTS funnel_snapshots (
  snapshot_date TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO experiments
  (id,name,scope,primary_metric,status,min_samples_per_variant,started_at,created_at,updated_at)
VALUES
  ('exp-initial-subject-cta-v1','Initial subject + CTA','initial_outreach','positive_reply','active',50,
   datetime('now'),datetime('now'),datetime('now'));

INSERT OR IGNORE INTO experiment_variants
  (id,experiment_id,variant_key,weight,config_json,is_control,created_at)
VALUES
  ('exp-initial-subject-cta-v1-control','exp-initial-subject-cta-v1','control',50,
   '{"subject_mode":"existing","cta_mode":"architecture"}',1,datetime('now')),
  ('exp-initial-subject-cta-v1-priority','exp-initial-subject-cta-v1','priority',50,
   '{"subject_mode":"priority","cta_mode":"benchmark"}',0,datetime('now'));
