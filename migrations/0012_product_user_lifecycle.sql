PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS product_user_lifecycle (
  external_user_id TEXT PRIMARY KEY,
  source_site TEXT NOT NULL DEFAULT 'gibp.app',
  stage TEXT NOT NULL DEFAULT 'trial'
    CHECK(stage IN ('lead','trial','customer','former_customer')),
  onboarding_started_at TEXT,
  onboarding_completed_at TEXT,
  activated_at TEXT,
  customer_since TEXT,
  churned_at TEXT,
  last_product_activity_at TEXT NOT NULL,
  health_status TEXT NOT NULL DEFAULT 'healthy'
    CHECK(health_status IN ('healthy','watch','dormant','expansion')),
  expansion_score INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_user_lifecycle_health
  ON product_user_lifecycle(stage,health_status,last_product_activity_at DESC);

CREATE TABLE IF NOT EXISTS product_user_signals (
  id TEXT PRIMARY KEY,
  external_user_id TEXT NOT NULL
    REFERENCES product_user_lifecycle(external_user_id) ON DELETE CASCADE,
  source_site TEXT NOT NULL DEFAULT 'gibp.app',
  signal_type TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(external_user_id,signal_type,status)
);

CREATE INDEX IF NOT EXISTS idx_product_user_signals_open
  ON product_user_signals(status,score DESC,updated_at DESC);
