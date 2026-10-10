import type { Account, Env } from "./types"
import { audit, id, nowIso } from "./db"

const APOLLO_PEOPLE_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/api_search"

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
