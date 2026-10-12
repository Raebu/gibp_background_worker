PRAGMA foreign_keys = ON;

ALTER TABLE website_intent ADD COLUMN source_site TEXT NOT NULL DEFAULT 'gibp.global';
ALTER TABLE conversion_requests ADD COLUMN source_site TEXT;
ALTER TABLE meeting_requests ADD COLUMN source_site TEXT;
ALTER TABLE conversion_attribution ADD COLUMN source_site TEXT;

UPDATE website_intent
SET source_site=CASE
  WHEN lower(COALESCE(json_extract(metadata_json,'$.site'),''))='gibp.app' THEN 'gibp.app'
  ELSE 'gibp.global'
END;

CREATE INDEX IF NOT EXISTS idx_website_intent_source_site
  ON website_intent(source_site,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversion_requests_source_site
  ON conversion_requests(source_site,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_requests_source_site
  ON meeting_requests(source_site,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversion_attribution_source_site
  ON conversion_attribution(source_site,occurred_at DESC);

CREATE TABLE IF NOT EXISTS account_lifecycle (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'prospect'
    CHECK(stage IN ('prospect','lead','trial','customer','partner','former_customer')),
  source_site TEXT,
  external_user_id TEXT,
  first_product_seen_at TEXT,
  onboarding_started_at TEXT,
  onboarding_completed_at TEXT,
  activated_at TEXT,
  customer_since TEXT,
  churned_at TEXT,
  last_product_activity_at TEXT,
  health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK(health_status IN ('unknown','healthy','watch','dormant','expansion')),
  expansion_score INTEGER NOT NULL DEFAULT 0,
  mrr REAL,
  currency TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_lifecycle_stage
  ON account_lifecycle(stage,health_status,last_product_activity_at DESC);

CREATE TABLE IF NOT EXISTS identity_links (
  identity_key TEXT PRIMARY KEY,
  identity_type TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  source_site TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 100,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_links_account
  ON identity_links(account_id,last_seen_at DESC);

CREATE TABLE IF NOT EXISTS product_events (
  event_key TEXT PRIMARY KEY,
  source_site TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  external_user_id TEXT,
  event_type TEXT NOT NULL,
  path TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_events_surface
  ON product_events(source_site,event_type,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_events_account
  ON product_events(account_id,occurred_at DESC);

CREATE TABLE IF NOT EXISTS lifecycle_signals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_site TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id,signal_type,status)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_signals_open
  ON lifecycle_signals(status,score DESC,updated_at DESC);

CREATE TABLE IF NOT EXISTS search_demand_sites (
  source_site TEXT NOT NULL,
  query TEXT NOT NULL,
  landing_path TEXT,
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  average_position REAL,
  country_code TEXT,
  last_seen_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(source_site,query)
);

CREATE INDEX IF NOT EXISTS idx_search_demand_sites_rank
  ON search_demand_sites(source_site,clicks DESC,impressions DESC);

CREATE TABLE IF NOT EXISTS surface_experiment_assignments (
  id TEXT PRIMARY KEY,
  source_site TEXT NOT NULL,
  experiment_key TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  variant_key TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  UNIQUE(source_site,experiment_key,subject_key)
);

CREATE INDEX IF NOT EXISTS idx_surface_experiment_assignments
  ON surface_experiment_assignments(source_site,experiment_key,variant_key);

CREATE TABLE IF NOT EXISTS surface_experiment_events (
  event_key TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES surface_experiment_assignments(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  value REAL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_surface_experiment_events
  ON surface_experiment_events(assignment_id,event_type,occurred_at DESC);

CREATE TABLE IF NOT EXISTS synthetic_journey_checks (
  id TEXT PRIMARY KEY,
  source_site TEXT NOT NULL,
  check_kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  duration_ms INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_synthetic_journey_checks
  ON synthetic_journey_checks(source_site,checked_at DESC);

CREATE TABLE IF NOT EXISTS site_daily_metrics (
  metric_date TEXT NOT NULL,
  source_site TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(metric_date,source_site)
);
