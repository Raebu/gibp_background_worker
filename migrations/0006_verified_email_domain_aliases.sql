CREATE TABLE IF NOT EXISTS account_email_domains (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  verification_method TEXT NOT NULL,
  source_url TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_domains_unique
  ON account_email_domains(account_id, lower(domain));

CREATE INDEX IF NOT EXISTS idx_account_email_domains_domain
  ON account_email_domains(lower(domain));

-- Bank of America explicitly states that official employee communications use @bofa.com.
-- Keep the website/account identity at bankofamerica.com while allowing only this
-- independently verified corporate email-domain alias.
INSERT INTO account_email_domains
  (id, account_id, domain, verification_method, source_url, verified_at, created_at)
SELECT
  lower(hex(randomblob(16))),
  a.id,
  'bofa.com',
  'official_first_party_source',
  'https://careers.bankofamerica.com/en-us/job-recruitment-scams',
  datetime('now'),
  datetime('now')
FROM accounts a
WHERE lower(a.domain)='bankofamerica.com'
  AND NOT EXISTS (
    SELECT 1
    FROM account_email_domains d
    WHERE d.account_id=a.id
      AND lower(d.domain)='bofa.com'
  );

-- The two commissioning matches were rejected only because the old validator
-- required the website domain itself. Re-queue those candidates for any future
-- explicitly approved enrichment test; this migration does not call Apollo.
UPDATE contact_candidates
SET status='candidate',
    updated_at=datetime('now')
WHERE status='rejected'
  AND account_id IN (
    SELECT id FROM accounts WHERE lower(domain)='bankofamerica.com'
  )
  AND metadata_json LIKE '%corporate_domain_mismatch%';
