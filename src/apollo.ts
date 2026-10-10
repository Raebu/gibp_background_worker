import type { Account, Env } from "./types"
import { audit, countToday, getSetting, id, nowIso, setSetting } from "./db"
import { isGenericRoleAddress } from "./compliance"

const APOLLO_PEOPLE_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/api_search"
const APOLLO_PEOPLE_MATCH_URL = "https://api.apollo.io/api/v1/people/match"

const targetTitles = [
  "Head of Payments",
  "Payments Director",
  "Head of Transaction Banking",
  "Transaction Banking Director",
  "Head of Treasury",
  "Treasury Director",
  "Head of Liquidity",
  "Liquidity Director",
  "Head of Payments Technology",
  "Head of Treasury Technology",
  "Chief Technology Officer",
  "Chief Information Officer",
  "Chief Digital Officer",
  "Chief Operating Officer",
  "Head of Innovation",
  "Innovation Director",
  "Head of Partnerships",
  "Partnerships Director",
  "Head of Business Development",
  "Business Development Director",
]

type ApolloSearchPerson = {
  id?: string
  first_name?: string
  last_name_obfuscated?: string
  title?: string
  has_email?: boolean
  organization?: {
    name?: string
  }
}

type ApolloPeopleSearchResponse = {
  total_entries?: number
  people?: ApolloSearchPerson[]
}

export function scoreApolloCandidateTitle(titleInput: string) {
  const title = titleInput.toLowerCase()

  if (/head of payments?|payments? director|payments? technology|payments? transformation/.test(title)) {
    return 100
  }
  if (/transaction banking/.test(title)) return 98
  if (/treasury|liquidity/.test(title)) return 95
  if (/settlement|clearing|money movement|cross[- ]border/.test(title)) return 92
  if (/chief technology officer|\bcto\b|chief information officer|\bcio\b|chief digital officer|\bcdo\b/.test(title)) {
    return 90
  }
  if (/head of innovation|innovation director/.test(title)) return 86
  if (/head of partnerships?|partnerships? director|alliance/.test(title)) return 84
  if (/head of business development|business development director/.test(title)) return 82
  if (/chief operating officer|\bcoo\b/.test(title)) return 78

  return 0
}

export async function discoverApolloContactCandidates(env: Env, account: Account) {
  if (!env.APOLLO_API_KEY) {
    return { searched: 0, stored: 0, skipped: true, reason: "apollo_not_configured" }
  }
  if (!account.domain) {
    return { searched: 0, stored: 0, skipped: true, reason: "domain_required" }
  }

  const response = await fetch(APOLLO_PEOPLE_SEARCH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "x-api-key": env.APOLLO_API_KEY,
    },
    body: JSON.stringify({
      q_organization_domains_list: [account.domain],
      person_titles: targetTitles,
      include_similar_titles: true,
      person_seniorities: ["director", "vp", "c_suite"],
      contact_email_status: ["verified"],
      per_page: 50,
      page: 1,
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    await audit(env, "contacts", "apollo_candidate_search_failed", "account", account.id, {
      domain: account.domain,
      status: response.status,
    })
    return {
      searched: 1,
      stored: 0,
      failed: true,
      status: response.status,
    }
  }

  const payload = (await response.json()) as ApolloPeopleSearchResponse
  const people = payload.people || []
  const now = nowIso()
  let stored = 0

  for (const person of people) {
    const providerPersonId = String(person.id || "").trim()
    const title = String(person.title || "").trim()
    const score = scoreApolloCandidateTitle(title)

    if (!providerPersonId || !person.has_email || score < 75) continue

    await env.GROWTH_DB.prepare(
      `INSERT INTO contact_candidates
        (id,account_id,provider,provider_person_id,first_name,last_name_display,title,
         organization_name,score,email_available,email_status_filter,status,metadata_json,
         created_at,updated_at)
       VALUES (?,?, 'apollo', ?,?,?,?,?, ?,1,'verified','candidate',?,?,?)
       ON CONFLICT(provider,account_id,provider_person_id) DO UPDATE SET
         first_name=excluded.first_name,
         last_name_display=excluded.last_name_display,
         title=excluded.title,
         organization_name=excluded.organization_name,
         score=MAX(contact_candidates.score,excluded.score),
         email_available=1,
         email_status_filter='verified',
         metadata_json=excluded.metadata_json,
         updated_at=excluded.updated_at`,
    )
      .bind(
        id(),
        account.id,
        providerPersonId,
        person.first_name || null,
        person.last_name_obfuscated || null,
        title,
        person.organization?.name || account.name,
        score,
        JSON.stringify({
          search_email_status: "verified",
          full_identity_requires_enrichment: true,
          search_credit_cost: 0,
        }),
        now,
        now,
      )
      .run()

    stored += 1
  }

  await audit(env, "contacts", "apollo_candidate_search", "account", account.id, {
    domain: account.domain,
    total_matches: Number(payload.total_entries || 0),
    returned: people.length,
    stored,
  })

  return {
    searched: 1,
    total_matches: Number(payload.total_entries || 0),
    returned: people.length,
    stored,
  }
}


type ApolloMatchedPerson = {
  id?: string
  first_name?: string
  last_name?: string
  name?: string
  title?: string
  email?: string
  email_status?: string
  organization?: {
    name?: string
    primary_domain?: string
    website_url?: string
  }
}

type ApolloPeopleMatchResponse = {
  person?: ApolloMatchedPerson | null
}

type ApolloCandidateRow = {
  id: string
  account_id: string
  provider_person_id: string
  first_name: string | null
  last_name_display: string | null
  title: string | null
  organization_name: string | null
  score: number
  status: string
  account_name: string
  account_domain: string
  country_code: string | null
}

function normalizeDomain(domain: string) {
  return domain
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .trim()
    .toLowerCase()
}

async function emailMatchesAccountDomain(env: Env, accountId: string, email: string, domain: string) {
  const emailDomain = normalizeDomain(email.split("@")[1] || "")
  const normalized = normalizeDomain(domain)

  if (emailDomain === normalized || emailDomain.endsWith(`.${normalized}`)) {
    return true
  }

  const aliases = await env.GROWTH_DB.prepare(
    `SELECT domain
     FROM account_email_domains
     WHERE account_id=?`,
  )
    .bind(accountId)
    .all<{ domain: string }>()

  return (aliases.results || []).some((row) => {
    const alias = normalizeDomain(String(row.domain || ""))
    return alias.length > 0 && (emailDomain === alias || emailDomain.endsWith(`.${alias}`))
  })
}

export function apolloEnrichmentDailyCap(env: Env) {
  return Math.max(0, Math.min(5, Number(env.APOLLO_ENRICHMENT_DAILY_CAP || 0)))
}

export async function enrichTopApolloCandidate(env: Env, commissioningCap?: number) {
  if (!env.APOLLO_API_KEY) {
    return { attempted: 0, matched: 0, stored: 0, skipped: true, reason: "apollo_not_configured" }
  }

  const configuredCap = apolloEnrichmentDailyCap(env)
  const isCommissioningOverride = commissioningCap !== undefined

  if (isCommissioningOverride) {
    if (env.SEND_MODE !== "dry_run" || configuredCap !== 0) {
      return { attempted: 0, matched: 0, stored: 0, skipped: true, reason: "commissioning_guard" }
    }
  }

  const dailyCap = isCommissioningOverride
    ? Math.max(0, Math.min(2, Number(commissioningCap || 0)))
    : configuredCap

  if (dailyCap <= 0) {
    return { attempted: 0, matched: 0, stored: 0, skipped: true, reason: "enrichment_disabled" }
  }

  const usedToday = await countToday(
    env,
    `SELECT COUNT(*) AS total
     FROM audit_events
     WHERE category='contacts'
       AND action='apollo_enrichment_spend'
       AND created_at >= datetime('now','start of day')`,
  )
  if (usedToday >= dailyCap) {
    return {
      attempted: 0,
      matched: 0,
      stored: 0,
      skipped: true,
      reason: "daily_credit_cap",
      daily_cap: dailyCap,
      spent_today: usedToday,
    }
  }

  const candidate = await env.GROWTH_DB.prepare(
    `UPDATE contact_candidates
     SET status='enriching', updated_at=?
     WHERE id=(
       SELECT cc.id
       FROM contact_candidates cc
       JOIN accounts a ON a.id=cc.account_id
       JOIN jurisdiction_policies jp
         ON jp.country_code=upper(COALESCE(a.country_code,''))
       WHERE cc.provider='apollo'
         AND cc.status='candidate'
         AND cc.email_available=1
         AND cc.email_status_filter='verified'
         AND cc.score >= 90
         AND a.status='qualified'
         AND a.domain IS NOT NULL
         AND a.domain != ''
         AND jp.allowed=1
         AND jp.requires_consent=0
         AND jp.allow_corporate_b2b=1
         AND NOT EXISTS (
           SELECT 1 FROM contacts ct
           WHERE ct.account_id=a.id
             AND ct.status IN ('active','research_only')
         )
       ORDER BY cc.score DESC, cc.created_at ASC
       LIMIT 1
     )
       AND status='candidate'
     RETURNING
       id,account_id,provider_person_id,first_name,last_name_display,title,
       organization_name,score,status,
       (SELECT name FROM accounts WHERE id=account_id) AS account_name,
       (SELECT domain FROM accounts WHERE id=account_id) AS account_domain,
       (SELECT country_code FROM accounts WHERE id=account_id) AS country_code`,
  )
    .bind(nowIso())
    .first<ApolloCandidateRow>()

  if (!candidate) {
    return { attempted: 0, matched: 0, stored: 0, skipped: true, reason: "no_eligible_candidate" }
  }

  try {
    const response = await fetch(APOLLO_PEOPLE_MATCH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "x-api-key": env.APOLLO_API_KEY,
      },
      body: JSON.stringify({
        id: candidate.provider_person_id,
        reveal_personal_emails: false,
        reveal_phone_number: false,
        run_waterfall_email: false,
        run_waterfall_phone: false,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      await env.GROWTH_DB.prepare(
        "UPDATE contact_candidates SET status='candidate', updated_at=? WHERE id=?",
      )
        .bind(nowIso(), candidate.id)
        .run()
      await audit(env, "contacts", "apollo_enrichment_failed", "candidate", candidate.id, {
        status: response.status,
        account_id: candidate.account_id,
      })
      return { attempted: 1, matched: 0, stored: 0, failed: true, status: response.status }
    }

    const payload = (await response.json()) as ApolloPeopleMatchResponse
    const person = payload.person || null

    if (!person?.id) {
      await env.GROWTH_DB.prepare(
        "UPDATE contact_candidates SET status='unmatched', updated_at=? WHERE id=?",
      )
        .bind(nowIso(), candidate.id)
        .run()
      await audit(env, "contacts", "apollo_enrichment_unmatched", "candidate", candidate.id, {
        account_id: candidate.account_id,
      })
      return { attempted: 1, matched: 0, stored: 0 }
    }

    await audit(env, "contacts", "apollo_enrichment_spend", "candidate", candidate.id, {
      credits_max: 1,
      account_id: candidate.account_id,
      provider_person_id: candidate.provider_person_id,
    })

    const email = String(person.email || "").trim().toLowerCase()
    const emailStatus = String(person.email_status || "").trim().toLowerCase()
    const name =
      String(person.name || "").trim() ||
      [person.first_name, person.last_name].filter(Boolean).join(" ").trim()
    const title = String(person.title || candidate.title || "").trim()
    const titleScore = scoreApolloCandidateTitle(title)

    let rejectionReason = ""
    if (!email) rejectionReason = "missing_work_email"
    else if (emailStatus !== "verified") rejectionReason = "work_email_not_verified"
    else if (!(await emailMatchesAccountDomain(env, candidate.account_id, email, candidate.account_domain))) rejectionReason = "corporate_domain_mismatch"
    else if (isGenericRoleAddress(email)) rejectionReason = "generic_role_address"
    else if (!name || name.length < 3) rejectionReason = "full_name_missing"
    else if (titleScore < 75) rejectionReason = "role_below_threshold"

    if (rejectionReason) {
      await env.GROWTH_DB.prepare(
        "UPDATE contact_candidates SET status='rejected', metadata_json=?, updated_at=? WHERE id=?",
      )
        .bind(
          JSON.stringify({
            enrichment: {
              matched: true,
              email_status: emailStatus || null,
              rejection_reason: rejectionReason,
              credit_cost_max: 1,
            },
          }),
          nowIso(),
          candidate.id,
        )
        .run()
      await audit(env, "contacts", "apollo_enrichment_rejected", "candidate", candidate.id, {
        reason: rejectionReason,
        account_id: candidate.account_id,
      })
      return { attempted: 1, matched: 1, stored: 0, rejected: true, reason: rejectionReason }
    }

    const now = nowIso()
    const contactId = id()
    await env.GROWTH_DB.prepare(
      `INSERT INTO contacts
        (id,account_id,name,role,email,email_source,source_url,country_code,is_public,verified,
         seniority_score,consent_status,lawful_basis,status,created_at,updated_at)
       VALUES (?,?,?,?,?,'apollo_verified',NULL,?,0,1,?,'unknown',
         'third_party_professional_data_review_required','research_only',?,?)
       ON CONFLICT(email) DO UPDATE SET
         account_id=excluded.account_id,
         name=excluded.name,
         role=excluded.role,
         verified=MAX(contacts.verified,excluded.verified),
         seniority_score=MAX(contacts.seniority_score,excluded.seniority_score),
         updated_at=excluded.updated_at`,
    )
      .bind(
        contactId,
        candidate.account_id,
        name,
        title,
        email,
        candidate.country_code,
        titleScore,
        now,
        now,
      )
      .run()

    await env.GROWTH_DB.prepare(
      "UPDATE contact_candidates SET status='enriched', metadata_json=?, updated_at=? WHERE id=?",
    )
      .bind(
        JSON.stringify({
          enrichment: {
            matched: true,
            email_status: emailStatus,
            work_email_stored: true,
            contact_status: "research_only",
            credit_cost_max: 1,
          },
        }),
        now,
        candidate.id,
      )
      .run()

    await audit(env, "contacts", "apollo_enrichment_stored", "candidate", candidate.id, {
      account_id: candidate.account_id,
      contact_id: contactId,
      contact_status: "research_only",
      title_score: titleScore,
    })

    return {
      attempted: 1,
      matched: 1,
      stored: 1,
      candidate_id: candidate.id,
      account_id: candidate.account_id,
      contact_status: "research_only",
      daily_cap: dailyCap,
      spent_today_before: usedToday,
    }
  } catch (error) {
    await env.GROWTH_DB.prepare(
      "UPDATE contact_candidates SET status='candidate', updated_at=? WHERE id=?",
    )
      .bind(nowIso(), candidate.id)
      .run()
    await audit(env, "contacts", "apollo_enrichment_exception", "candidate", candidate.id, {
      account_id: candidate.account_id,
      error: error instanceof Error ? error.message : "unknown",
    })
    throw error
  }
}


const APOLLO_COMMISSIONING_ID = "apollo_email_v1"
const APOLLO_COMMISSIONING_SETTING = "apollo_enrichment_commissioning_v1_complete"

export async function runApolloEnrichmentCommissioningTest(env: Env) {
  if (env.SEND_MODE !== "dry_run") {
    return { skipped: true, reason: "send_mode_not_dry_run" }
  }

  if (apolloEnrichmentDailyCap(env) !== 0) {
    return { skipped: true, reason: "persistent_enrichment_cap_must_remain_zero" }
  }

  const completed = await getSetting(env, APOLLO_COMMISSIONING_SETTING)
  if (completed) {
    return { skipped: true, reason: "already_completed", completed_at: completed }
  }

  const priorAttempts = await countToday(
    env,
    `SELECT COUNT(*) AS total
     FROM audit_events
     WHERE category='contacts'
       AND action='apollo_commissioning_attempt'
       AND entity_id=?`,
    APOLLO_COMMISSIONING_ID,
  )

  if (priorAttempts >= 2) {
    const completedAt = nowIso()
    await setSetting(env, APOLLO_COMMISSIONING_SETTING, completedAt)
    return { skipped: true, reason: "attempt_limit_already_reached", attempts: priorAttempts }
  }

  const results: Array<Record<string, unknown>> = []

  for (let attempt = priorAttempts + 1; attempt <= 2; attempt += 1) {
    await audit(env, "contacts", "apollo_commissioning_attempt", "commissioning", APOLLO_COMMISSIONING_ID, {
      attempt,
      max_attempts: 2,
      persistent_cap: 0,
      send_mode: "dry_run",
    })

    try {
      results.push(await enrichTopApolloCandidate(env, 2))
    } catch (error) {
      await audit(env, "contacts", "apollo_commissioning_exception", "commissioning", APOLLO_COMMISSIONING_ID, {
        attempt,
        error: error instanceof Error ? error.message : "unknown",
      })
      results.push({ attempted: 1, matched: 0, stored: 0, failed: true, reason: "exception" })
    }
  }

  const completedAt = nowIso()
  await setSetting(env, APOLLO_COMMISSIONING_SETTING, completedAt)
  await audit(env, "contacts", "apollo_commissioning_complete", "commissioning", APOLLO_COMMISSIONING_ID, {
    attempts: 2,
    results,
    persistent_cap: 0,
    send_mode: "dry_run",
  })

  return {
    completed: true,
    attempts: 2,
    results,
    persistent_cap: 0,
    send_mode: "dry_run",
  }
}
