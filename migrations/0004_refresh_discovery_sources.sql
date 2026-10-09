PRAGMA foreign_keys = ON;

-- Force one immediate commissioning pass after replacing the rate-limited
-- single-source discovery path with deterministic official directory sources
-- and corrected procurement API parameters.
DELETE FROM settings
WHERE key IN (
  'last_discovery_at',
  'last_procurement_at',
  'last_bank_directory_discovery_at'
);
