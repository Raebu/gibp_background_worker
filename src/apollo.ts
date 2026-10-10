import type { Account, Env } from "./types"
import { isGenericRoleAddress } from "./compliance"
import { audit, countToday, id, nowIso } from "./db"

const APOLLO_PEOPLE_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/api_search"
const APOLLO_PEOPLE_MATCH_URL = "https://api.apollo.io/api/v1/people/match"
const APOLLO_CREDIT_USAGE_URL = "https://api.apollo.io/api/v1/usage_stats/credit_usage_stats"

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


type ApolloCandidateRow = {
  id: string
  account_id: string
  provider_person_id: string
  first_name: string | null
  last_name_display: string | null
  title: string | null
  organization_name: string | null
  score: number
  metadata_json: string
}

type ApolloEnrichedPerson = {
  id?: string
  name?: string
  first_name?: string
  last_name?: string
  title?: string
  email?: string
  email_status?: string
  organization?: {
    name?: string
    primary_domain?: string
  }
}

type ApolloPeopleMatchResponse = {
  person?: ApolloEnrichedPerson | null
  data?: {
    person?: ApolloEnrichedPerson | null
  }
  match_confidence?: string
}

type ApolloCreditUsageResponse = {
  credit_usage_stats?: {
    lead_credit?: {
      limit?: number
      consumed?: number
      left_over?: number
    }
  }
}

function normalizeDomain(value: string) {
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .toLowerCase()
}

function emailMatchesCorporateDomain(email: string, domainInput: string) {
  const emailDomain = email.split("@")[1]?.toLowerCase() || ""
  const domain = normalizeDomain(domainInput)
  return Boolean(
    emailDomain &&
      domain &&
      (emailDomain === domain || emailDomain.endsWith(`.${domain}`)),
  )
}

export function apolloBusinessEmailEligible(
  emailInput: string,
  emailStatusInput: string,
  domainInput: string,
) {
  const email = emailInput.trim().toLowerCase()
  const emailStatus = emailStatusInput.trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false
  if (email.startsWith("email_not_unlocked@")) return false
  if (emailStatus !== "verified") return false
  if (isGenericRoleAddress(email)) return false
  return emailMatchesCorporateDomain(email, domainInput)
}

export async function getApolloLeadCreditBalance(env: Env) {
  if (!env.APOLLO_API_KEY) {
    return { available: false, left: 0, limit: 0, consumed: 0 }
  }

  const response = await fetch(APOLLO_CREDIT_USAGE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "x-api-key": env.APOLLO_API_KEY,
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    await audit(env, "contacts", "apollo_credit_usage_failed", "provider", "apollo", {
      status: response.status,
    })
    return { available: false, left: 0, limit: 0, consumed: 0 }
  }

  const payload = (await response.json()) as ApolloCreditUsageResponse
  const lead = payload.credit_usage_stats?.lead_credit
  const snapshot = {
    available: true,
    left: Number(lead?.left_over || 0),
    limit: Number(lead?.limit || 0),
    consumed: Number(lead?.consumed || 0),
  }

  await audit(env, "contacts", "apollo_credit_snapshot", "provider", "apollo", snapshot)
  return snapshot
}

export async function enrichApolloCandidateEmail(
  env: Env,
  account: Account,
  candidate: ApolloCandidateRow,
) {
  if (!env.APOLLO_API_KEY) {
    return { enriched: false, reason: "apollo_not_configured", credits_spent: 0 }
  }
  if (!account.domain) {
    return { enriched: false, reason: "domain_required", credits_spent: 0 }
  }

  const reserve = Math.max(
    0,
    Number(env.APOLLO_MIN_LEAD_CREDITS_RESERVE || 20),
  )
  const balanceBefore = await getApolloLeadCreditBalance(env)
  if (!balanceBefore.available) {
    return { enriched: false, reason: "credit_balance_unavailable", credits_spent: 0 }
  }
  if (balanceBefore.left <= reserve) {
    await audit(env, "contacts", "apollo_enrichment_blocked", "candidate", candidate.id, {
      reason: "credit_reserve",
      left: balanceBefore.left,
      reserve,
    })
    return { enriched: false, reason: "credit_reserve", credits_spent: 0 }
  }

  await audit(env, "contacts", "apollo_enrichment_attempt", "account", account.id, {
    candidate_id: candidate.id,
    provider_person_id: candidate.provider_person_id,
    score: candidate.score,
    lead_credits_before: balanceBefore.left,
  })

  const url = new URL(APOLLO_PEOPLE_MATCH_URL)
  url.searchParams.set("id", candidate.provider_person_id)
  url.searchParams.set("reveal_personal_emails", "false")
  url.searchParams.set("reveal_phone_number", "false")
  url.searchParams.set("run_waterfall_email", "false")
  url.searchParams.set("run_waterfall_phone", "false")

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "x-api-key": env.APOLLO_API_KEY,
    },
    signal: AbortSignal.timeout(12_000),
  })

  if (!response.ok) {
    await audit(env, "contacts", "apollo_enrichment_failed", "candidate", candidate.id, {
      status: response.status,
    })
    return {
      enriched: false,
      reason: `apollo_http_${response.status}`,
      credits_spent: 0,
    }
  }

  const payload = (await response.json()) as ApolloPeopleMatchResponse
  const person = payload.person || payload.data?.person || null
  const email = String(person?.email || "").trim().toLowerCase()
  const emailStatus = String(person?.email_status || "").trim().toLowerCase()
  const fullName =
    String(person?.name || "").trim() ||
    [person?.first_name, person?.last_name].filter(Boolean).join(" ").trim()
  const title = String(person?.title || candidate.title || "").trim()

  const balanceAfter = await getApolloLeadCreditBalance(env)
  const creditsSpent =
    balanceBefore.available && balanceAfter.available
      ? Math.max(0, balanceBefore.left - balanceAfter.left)
      : 0

  if (
    !person ||
    !fullName ||
    fullName.split(/\s+/).length < 2 ||
    scoreApolloCandidateTitle(title) < 75 ||
    !apolloBusinessEmailEligible(email, emailStatus, account.domain)
  ) {
    await env.GROWTH_DB.prepare(
      "UPDATE contact_candidates SET status='rejected', metadata_json=?, updated_at=? WHERE id=?",
    )
      .bind(
        JSON.stringify({
          rejection_reason: "enrichment_validation_failed",
          match_confidence: payload.match_confidence || null,
          email_status: emailStatus || null,
          credits_spent: creditsSpent,
        }),
        nowIso(),
        candidate.id,
      )
      .run()

    await audit(env, "contacts", "apollo_enrichment_rejected", "candidate", candidate.id, {
      account_id: account.id,
      email_status: emailStatus || null,
      match_confidence: payload.match_confidence || null,
      credits_spent: creditsSpent,
    })

    return {
      enriched: false,
      reason: "enrichment_validation_failed",
      credits_spent: creditsSpent,
    }
  }

  const now = nowIso()
  await env.GROWTH_DB.prepare(
    `INSERT INTO contacts
      (id,account_id,name,role,email,email_source,source_url,country_code,timezone,is_public,
       verified,seniority_score,consent_status,lawful_basis,status,last_contact_at,created_at,updated_at)
     VALUES (?,?,?,?,?,'apollo_verified_work',NULL,?,NULL,0,1,?,'unknown',
       'legitimate_interests_corporate_b2b','active',NULL,?,?)
     ON CONFLICT(email) DO UPDATE SET
       account_id=excluded.account_id,
       name=excluded.name,
       role=excluded.role,
       email_source=excluded.email_source,
       country_code=COALESCE(excluded.country_code,contacts.country_code),
       verified=1,
       seniority_score=MAX(contacts.seniority_score,excluded.seniority_score),
       lawful_basis=excluded.lawful_basis,
       status='active',
       updated_at=excluded.updated_at`,
  )
    .bind(
      id(),
      account.id,
      fullName,
      title,
      email,
      account.country_code,
      Math.max(candidate.score, scoreApolloCandidateTitle(title)),
      now,
      now,
    )
    .run()

  await env.GROWTH_DB.prepare(
    "UPDATE contact_candidates SET status='enriched', metadata_json=?, updated_at=? WHERE id=?",
  )
    .bind(
      JSON.stringify({
        match_confidence: payload.match_confidence || null,
        email_status: emailStatus,
        credits_spent: creditsSpent,
        lead_credits_remaining: balanceAfter.available ? balanceAfter.left : null,
      }),
      now,
      candidate.id,
    )
    .run()

  await audit(env, "contacts", "apollo_enrichment_success", "candidate", candidate.id, {
    account_id: account.id,
    title,
    email_domain: email.split("@")[1] || null,
    match_confidence: payload.match_confidence || null,
    credits_spent: creditsSpent,
    lead_credits_remaining: balanceAfter.available ? balanceAfter.left : null,
  })

  return {
    enriched: true,
    contact_email: email,
    credits_spent: creditsSpent,
    lead_credits_remaining: balanceAfter.available ? balanceAfter.left : null,
  }
}

export async function apolloEnrichmentAttemptsToday(env: Env) {
  return countToday(
    env,
    `SELECT COUNT(*) AS total
     FROM audit_events
     WHERE category='contacts'
       AND action='apollo_enrichment_attempt'
       AND created_at >= datetime('now','start of day')`,
  )
}
