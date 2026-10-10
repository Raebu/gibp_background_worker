import type { Env } from "./types"
import { aiJson } from "./ai"
import { audit, getSetting, id, nowIso, setSetting } from "./db"
import { sendInternalResend } from "./email"

const partnerQuery =
  '("payments partnership" OR "payment technology partnership" OR "banking technology partnership" OR "payments transformation partner" OR "transaction banking partnership" OR "fintech partnership")'

const procurementKeywords =
  /\b(payment|payments|bank|banking|treasury|financial|fintech|settlement|clearing|cross-border|iso\s*20022|swift|liquidity|transaction banking|payment rail|money movement)\b/i

function clampScore(value: unknown) {
  return Math.max(0, Math.min(100, Number(value || 0)))
}

async function gdeltBackoffActive(env: Env) {
  const until = await getSetting(env, "gdelt_backoff_until")
  return Boolean(until && new Date(until).getTime() > Date.now())
}

async function activateGdeltBackoff(env: Env, source: string) {
  const until = new Date(Date.now() + 24 * 3600_000).toISOString()
  await setSetting(env, "gdelt_backoff_until", until)
  await audit(env, "discovery", "gdelt_backoff", "source", source, { until })
}

async function upsertPartnerAccount(
  env: Env,
  candidate: {
    name: string
    account_type?: string
    strength?: number
    article_index: number
  },
  article: { title: string; url: string; seendate?: string },
) {
  const existing = await env.GROWTH_DB.prepare(
    "SELECT id,pipeline FROM accounts WHERE lower(name)=lower(?) OR lower(legal_name)=lower(?) LIMIT 1",
  )
    .bind(candidate.name, candidate.name)
    .first<{ id: string; pipeline: string }>()

  const accountId = existing?.id || id()
  const now = nowIso()
  if (!existing) {
    await env.GROWTH_DB.prepare(
      `INSERT INTO accounts
        (id,name,account_type,pipeline,status,source,source_url,created_at,updated_at)
       VALUES (?,?,?,'partner','candidate','gdelt_partner',?,?,?)`,
    )
      .bind(
        accountId,
        candidate.name,
        candidate.account_type || "partner",
        article.url,
        now,
        now,
      )
      .run()
  } else if (existing.pipeline === "direct") {
    await env.GROWTH_DB.prepare(
      "UPDATE accounts SET pipeline='partner', updated_at=? WHERE id=?",
    )
      .bind(now, accountId)
      .run()
  }

  await env.GROWTH_DB.prepare(
    `INSERT OR IGNORE INTO signals
      (id,account_id,kind,title,url,source,observed_at,strength,raw_json,created_at)
     VALUES (?,?,'partner_signal',?,?,'gdelt_partner',?,?,?,?)`,
  )
    .bind(
      id(),
      accountId,
      article.title,
      article.url,
      article.seendate || now,
      Math.max(1, Math.min(40, Number(candidate.strength || 10))),
      JSON.stringify(article),
      now,
    )
    .run()
}

export async function discoverPartnerCandidates(env: Env) {
  if (await gdeltBackoffActive(env)) {
    return { articles: 0, organisations: 0, skipped: true, reason: "gdelt_backoff" }
  }

  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc")
  url.searchParams.set("query", env.PARTNER_DISCOVERY_QUERY || partnerQuery)
  url.searchParams.set("mode", "ArtList")
  url.searchParams.set("format", "json")
  url.searchParams.set("maxrecords", "35")
  url.searchParams.set("sort", "HybridRel")

  const response = await fetch(url)
  if (!response.ok) {
    await audit(env, "discovery", "partner_feed_failed", "source", "gdelt", {
      status: response.status,
    })
    if (response.status === 429) await activateGdeltBackoff(env, "gdelt_partner")
    return { articles: 0, organisations: 0 }
  }

  const payload = (await response.json()) as {
    articles?: Array<{ title: string; url: string; seendate?: string }>
  }
  const articles = payload.articles || []
  if (!articles.length) return { articles: 0, organisations: 0 }

  const candidates =
    (await aiJson<
      Array<{
        name: string
        account_type?: string
        article_index: number
        strength: number
      }>
    >(
      env,
      `Extract organisations that could distribute, implement, integrate or refer GIBP.
Return a JSON array only with name, account_type, article_index and strength (1-40).
Prioritise payment consultancies, systems integrators, banking technology companies, payment infrastructure vendors, regional fintech distributors and financial-services transformation firms.
Exclude journalists, individuals and organisations that are clearly only buyers unless they also have a partner/distribution role.`,
      articles.map((article, index) => `${index}: ${article.title}`).join("\n").slice(0, 12000),
    )) || []

  let stored = 0
  for (const candidate of candidates.slice(0, 12)) {
    if (!candidate.name || candidate.name.length < 3) continue
    const article = articles[candidate.article_index]
    if (!article) continue
    await upsertPartnerAccount(env, candidate, article)
    stored += 1
  }

  await audit(env, "discovery", "partner_batch", "source", "gdelt", {
    articles: articles.length,
    organisations: stored,
  })
  return { articles: articles.length, organisations: stored }
}

type OcdsParty = {
  name?: string
  roles?: string[]
  address?: { countryName?: string; country?: string }
}

type OcdsRelease = {
  ocid?: string
  id?: string
  date?: string
  tag?: string[]
  uri?: string
  parties?: OcdsParty[]
  buyer?: { name?: string }
  tender?: {
    id?: string
    title?: string
    description?: string
    status?: string
    value?: { amount?: number; currency?: string }
    tenderPeriod?: { endDate?: string }
    documents?: Array<{ url?: string }>
  }
}

function extractBuyer(release: OcdsRelease) {
  return (
    release.buyer?.name ||
    release.parties?.find((party) => party.roles?.includes("buyer"))?.name ||
    null
  )
}

function extractCountry(release: OcdsRelease) {
  const buyer = release.parties?.find((party) => party.roles?.includes("buyer"))
  const country = buyer?.address?.country || buyer?.address?.countryName
  if (!country) return null
  if (/united kingdom|great britain|england|scotland|wales|northern ireland/i.test(country)) {
    return "GB"
  }
  return country.length === 2 ? country.toUpperCase() : null
}

async function scoreProcurement(env: Env, release: OcdsRelease, source: string) {
  const title = release.tender?.title || ""
  const description = release.tender?.description || ""
  if (!procurementKeywords.test(`${title} ${description}`)) return null

  const deterministic =
    50 +
    (/payment|settlement|clearing|transaction banking/i.test(title) ? 20 : 0) +
    (/cross-border|iso\s*20022|swift|liquidity/i.test(`${title} ${description}`) ? 15 : 0) +
    (release.tender?.value?.amount ? 5 : 0)

  const ai =
    (await aiJson<{ score: number; summary: string; reasons: string[]; risks: string[] }>(
      env,
      `Assess a public procurement opportunity for GIBP.
GIBP is a provider-neutral financial intent, policy, liquidity and execution layer for institutional value movement across banks, payment rails and digital money.
Return JSON only with score 0-100, summary, reasons[] and risks[].
High scores require a credible relationship to payments execution, orchestration, transaction banking, liquidity, settlement, financial infrastructure or closely adjacent integration work.
Do not assume GIBP has certifications, customers or regulated permissions that are not stated.`,
      JSON.stringify({
        source,
        title,
        description: description.slice(0, 6000),
        buyer: extractBuyer(release),
        value: release.tender?.value,
        deadline: release.tender?.tenderPeriod?.endDate,
      }),
    )) || null

  return {
    score: clampScore(ai?.score ?? deterministic),
    summary: ai?.summary || description.slice(0, 500),
    reasons: ai?.reasons || [],
    risks: ai?.risks || [],
  }
}

async function storeProcurementRelease(env: Env, release: OcdsRelease, source: string) {
  const analysis = await scoreProcurement(env, release, source)
  if (!analysis) return false

  const title = release.tender?.title || "Untitled procurement opportunity"
  const externalId = release.ocid || release.id || release.tender?.id || null
  const sourceUrl =
    release.tender?.documents?.find((document) => document.url)?.url ||
    release.uri ||
    null
  const score = analysis.score
  const status = score >= Number(env.RFP_MIN_SCORE || 70) ? "qualified" : "monitor"
  const now = nowIso()

  await env.GROWTH_DB.prepare(
    `INSERT INTO opportunities
      (id,kind,title,source,source_url,external_id,buyer_name,country_code,deadline,
       estimated_value,currency,score,status,summary,metadata_json,created_at,updated_at)
     VALUES (?,'rfp',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source,external_id) DO UPDATE SET
       title=excluded.title,
       source_url=COALESCE(excluded.source_url,opportunities.source_url),
       buyer_name=COALESCE(excluded.buyer_name,opportunities.buyer_name),
       country_code=COALESCE(excluded.country_code,opportunities.country_code),
       deadline=COALESCE(excluded.deadline,opportunities.deadline),
       estimated_value=COALESCE(excluded.estimated_value,opportunities.estimated_value),
       currency=COALESCE(excluded.currency,opportunities.currency),
       score=MAX(opportunities.score,excluded.score),
       status=CASE WHEN excluded.score >= ? THEN 'qualified' ELSE opportunities.status END,
       summary=excluded.summary,
       metadata_json=excluded.metadata_json,
       updated_at=excluded.updated_at`,
  )
    .bind(
      id(),
      title,
      source,
      sourceUrl,
      externalId,
      extractBuyer(release),
      extractCountry(release) || "GB",
      release.tender?.tenderPeriod?.endDate || null,
      release.tender?.value?.amount || null,
      release.tender?.value?.currency || null,
      score,
      status,
      analysis.summary,
      JSON.stringify({ release, analysis }),
      now,
      now,
      Number(env.RFP_MIN_SCORE || 70),
    )
    .run()

  return true
}

async function fetchOcdsFeed(env: Env, source: string, endpoint: string) {
  const to = new Date()
  const from = new Date(Date.now() - 30 * 3600_000)
  const url = new URL(endpoint)
  const fromValue = from.toISOString().slice(0, 19)
  const toValue = to.toISOString().slice(0, 19)

  if (source === "find_a_tender") {
    url.searchParams.set("updatedFrom", fromValue)
    url.searchParams.set("updatedTo", toValue)
  } else {
    url.searchParams.set("publishedFrom", fromValue)
    url.searchParams.set("publishedTo", toValue)
  }
  url.searchParams.set("stages", "planning,tender")
  url.searchParams.set("limit", "100")

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "GIBPGrowth/1.0 (+https://www.gibp.global)",
      },
    })
    if (!response.ok) {
      await audit(env, "procurement", "source_failed", "source", source, {
        status: response.status,
      })
      return 0
    }
    const payload = (await response.json()) as { releases?: OcdsRelease[] }
    let stored = 0
    for (const release of payload.releases || []) {
      if (await storeProcurementRelease(env, release, source)) stored += 1
    }
    return stored
  } catch (error) {
    await audit(env, "procurement", "source_exception", "source", source, {
      error: error instanceof Error ? error.message : "unknown",
    })
    return 0
  }
}

async function discoverGlobalProcurementSignals(env: Env) {
  if (await gdeltBackoffActive(env)) {
    return 0
  }

  const query =
    '("request for proposal" OR tender OR procurement) ("payments" OR "transaction banking" OR "financial infrastructure" OR "cross-border payments" OR "payment platform")'
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc")
  url.searchParams.set("query", query)
  url.searchParams.set("mode", "ArtList")
  url.searchParams.set("format", "json")
  url.searchParams.set("maxrecords", "35")
  url.searchParams.set("sort", "HybridRel")

  try {
    const response = await fetch(url)
    if (!response.ok) {
      await audit(env, "procurement", "global_signal_failed", "source", "gdelt_procurement", {
        status: response.status,
        retry_after: response.headers.get("retry-after"),
      })
      if (response.status === 429) await activateGdeltBackoff(env, "gdelt_procurement")
      return 0
    }
    const payload = (await response.json()) as {
      articles?: Array<{ title: string; url: string; seendate?: string; sourcecountry?: string }>
    }
    const articles = payload.articles || []
    if (!articles.length) return 0

    const extracted =
      (await aiJson<
        Array<{
          article_index: number
          buyer_name?: string
          title: string
          country_code?: string
          score: number
          summary: string
        }>
      >(
        env,
        `Extract genuine procurement, tender or RFP opportunities that may fit GIBP.
Return a JSON array only with article_index, buyer_name, title, country_code, score and summary.
Only include opportunities credibly related to payment execution/orchestration, transaction banking, liquidity, settlement, clearing, cross-border payments or financial infrastructure.
Exclude ordinary partnership announcements and general news. Score 0-100.`,
        articles.map((article, index) => `${index}: ${article.title}`).join("\n").slice(0, 12000),
      )) || []

    let stored = 0
    for (const candidate of extracted.slice(0, 12)) {
      const article = articles[candidate.article_index]
      if (!article || clampScore(candidate.score) < 55) continue
      const now = nowIso()
      const score = clampScore(candidate.score)
      const status = score >= Number(env.RFP_MIN_SCORE || 70) ? "qualified" : "monitor"
      await env.GROWTH_DB.prepare(
        `INSERT INTO opportunities
          (id,kind,title,source,source_url,external_id,buyer_name,country_code,score,status,
           summary,metadata_json,created_at,updated_at)
         VALUES (?,'rfp',?,'gdelt_procurement',?,?,?,?,?,?,?, ?,?,?)
         ON CONFLICT(source,source_url) DO UPDATE SET
           score=MAX(opportunities.score,excluded.score),
           status=CASE WHEN excluded.score >= ? THEN 'qualified' ELSE opportunities.status END,
           summary=excluded.summary,
           metadata_json=excluded.metadata_json,
           updated_at=excluded.updated_at`,
      )
        .bind(
          id(),
          candidate.title || article.title,
          article.url,
          article.url,
          candidate.buyer_name || null,
          candidate.country_code || null,
          score,
          status,
          candidate.summary || article.title,
          JSON.stringify({ article, candidate }),
          now,
          now,
          Number(env.RFP_MIN_SCORE || 70),
        )
        .run()
      stored += 1
    }
    return stored
  } catch (error) {
    await audit(env, "procurement", "global_signal_exception", "source", "gdelt_procurement", {
      error: error instanceof Error ? error.message : "unknown",
    })
    return 0
  }
}

export async function discoverUkProcurement(env: Env) {
  const contractsFinder = await fetchOcdsFeed(
    env,
    "contracts_finder",
    "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search",
  )

  const findATender = await fetchOcdsFeed(
    env,
    "find_a_tender",
    "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages",
  )

  const globalSignals = await discoverGlobalProcurementSignals(env)

  const result = {
    contracts_finder: contractsFinder,
    find_a_tender: findATender,
    global_signals: globalSignals,
  }
  await audit(env, "procurement", "uk_batch", "source", "uk_public_procurement", result)
  return result
}

export async function processProcurementHandoffs(env: Env) {
  const threshold = Math.max(80, Number(env.RFP_HANDOFF_SCORE || 82))
  const rows = await env.GROWTH_DB.prepare(
    `SELECT *
     FROM opportunities o
     WHERE o.kind='rfp'
       AND o.status='qualified'
       AND o.score >= ?
       AND (o.deadline IS NULL OR o.deadline > datetime('now','+2 day'))
       AND NOT EXISTS (
         SELECT 1 FROM opportunity_handoffs h WHERE h.opportunity_id=o.id
       )
     ORDER BY o.score DESC, COALESCE(o.deadline,'9999-12-31') ASC
     LIMIT 5`,
  )
    .bind(threshold)
    .all<{
      id: string
      title: string
      source: string
      source_url: string | null
      buyer_name: string | null
      country_code: string | null
      deadline: string | null
      estimated_value: number | null
      currency: string | null
      score: number
      summary: string | null
      metadata_json: string
    }>()

  let created = 0
  for (const opportunity of rows.results || []) {
    const briefing = {
      type: "procurement",
      title: opportunity.title,
      buyer: opportunity.buyer_name,
      source: opportunity.source,
      source_url: opportunity.source_url,
      country: opportunity.country_code,
      deadline: opportunity.deadline,
      estimated_value: opportunity.estimated_value,
      currency: opportunity.currency,
      score: opportunity.score,
      summary: opportunity.summary,
      evidence: JSON.parse(opportunity.metadata_json || "{}"),
      boundary:
        "Autonomous discovery and qualification only. A human must approve any tender response, pricing, legal terms, certifications or binding commitment.",
    }

    await env.GROWTH_DB.prepare(
      `INSERT INTO opportunity_handoffs
        (id,opportunity_id,priority,reason,briefing_json,status,created_at)
       VALUES (?,?,?,'High-fit live procurement opportunity',?,'ready',?)`,
    )
      .bind(
        id(),
        opportunity.id,
        opportunity.deadline ? "high" : "normal",
        JSON.stringify(briefing),
        nowIso(),
      )
      .run()

    await env.GROWTH_DB.prepare(
      "UPDATE opportunities SET status='handoff',updated_at=? WHERE id=?",
    )
      .bind(nowIso(), opportunity.id)
      .run()

    if (env.HANDOFF_TO) {
      await sendInternalResend(env, {
        to: env.HANDOFF_TO,
        subject: `SERIOUS GIBP PROCUREMENT OPPORTUNITY — ${opportunity.title}`,
        text: `A high-fit public procurement opportunity is ready for review.\n\n${JSON.stringify(briefing, null, 2)}`,
      })
    }
    created += 1
  }

  return created
}
