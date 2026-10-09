import type { Account, Env } from "./types"
import { aiJson } from "./ai"
import { audit, id, nowIso } from "./db"

const defaultQuery =
  '("payment modernization" OR "payments transformation" OR "cross-border payments" OR "ISO 20022" OR "instant payments" OR "transaction banking" OR "liquidity management")'

function normalizeDomain(value: string) {
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .toLowerCase()
}

async function discoverWebsiteFromWikidata(name: string) {
  const search = new URL("https://www.wikidata.org/w/api.php")
  search.searchParams.set("action", "wbsearchentities")
  search.searchParams.set("search", name)
  search.searchParams.set("language", "en")
  search.searchParams.set("format", "json")
  search.searchParams.set("limit", "3")
  search.searchParams.set("origin", "*")
  const result = (await (await fetch(search)).json()) as {
    search?: Array<{ id: string; label: string; description?: string }>
  }
  const candidate = result.search?.find((item) =>
    /bank|payment|financial|fintech|treasury|exchange|clearing|settlement|technology/i.test(
      `${item.label} ${item.description || ""}`,
    ),
  ) || result.search?.[0]
  if (!candidate) return null

  const entity = (await (
    await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${candidate.id}.json`)
  ).json()) as Record<string, any>
  const claims = entity.entities?.[candidate.id]?.claims?.P856 || []
  const website = claims[0]?.mainsnak?.datavalue?.value
  return typeof website === "string" ? website : null
}

async function gleifLookup(name: string) {
  const url = new URL("https://api.gleif.org/api/v1/lei-records")
  url.searchParams.set("filter[entity.legalName]", name)
  url.searchParams.set("page[size]", "1")
  const response = await fetch(url, { headers: { Accept: "application/vnd.api+json" } })
  if (!response.ok) return null
  const payload = (await response.json()) as any
  const item = payload.data?.[0]
  if (!item) return null
  return {
    legal_name: item.attributes?.entity?.legalName?.name || item.attributes?.entity?.legalName || null,
    country_code:
      item.attributes?.entity?.legalAddress?.country ||
      item.attributes?.entity?.headquartersAddress?.country ||
      null,
    lei: item.attributes?.lei || null,
  }
}

async function robotsAllows(origin: string, path: string) {
  try {
    const response = await fetch(new URL("/robots.txt", origin), {
      headers: { "User-Agent": "GIBPResearchBot/1.0 (+https://www.gibp.global)" },
    })
    if (!response.ok) return true
    const text = await response.text()
    let applies = false
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (/^user-agent:\s*\*/i.test(line)) {
        applies = true
        continue
      }
      if (/^user-agent:/i.test(line)) {
        applies = false
        continue
      }
      if (applies) {
        const match = line.match(/^disallow:\s*(.*)$/i)
        if (match && match[1] && path.startsWith(match[1].trim())) return false
      }
    }
  } catch {}
  return true
}

function roleScore(email: string) {
  const local = email.split("@")[0].toLowerCase()
  if (/partner|alliance|businessdevelopment|business\.development/.test(local)) return 85
  if (/payment|treasury|transaction|innovation|digital/.test(local)) return 78
  if (/commercial|sales|enterprise|corporate/.test(local)) return 68
  if (/procurement|supplier|vendor/.test(local)) return 62
  if (/info|contact|hello|enquir/.test(local)) return 35
  if (/press|media|privacy|abuse|support/.test(local)) return 5
  return 28
}

export async function discoverNewsCandidates(env: Env) {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc")
  url.searchParams.set("query", env.DISCOVERY_QUERY || defaultQuery)
  url.searchParams.set("mode", "ArtList")
  url.searchParams.set("format", "json")
  url.searchParams.set("maxrecords", "40")
  url.searchParams.set("sort", "HybridRel")
  const response = await fetch(url)
  if (!response.ok) return { articles: 0, organisations: 0 }

  const payload = (await response.json()) as {
    articles?: Array<{
      title: string
      url: string
      domain?: string
      seendate?: string
      sourcecountry?: string
    }>
  }
  const articles = payload.articles || []
  if (!articles.length) return { articles: 0, organisations: 0 }

  const extracted =
    (await aiJson<Array<{ name: string; account_type: string; article_index: number; strength: number }>>(
      env,
      `Extract target organisations for institutional GIBP business development.
Return a JSON array only. Include banks, payment companies, fintech platforms, treasury/payment technology providers, liquidity providers, clearing/settlement networks, market infrastructure firms and systems integrators.
Do not return journalists, governments, people, trade bodies unless they are potential technology/commercial partners.
Use exact organisation names from the titles. strength must be 1-40.`,
      articles
        .map((article, index) => `${index}: ${article.title}`)
        .join("\n")
        .slice(0, 12000),
    )) || []

  let created = 0
  for (const candidate of extracted.slice(0, 15)) {
    if (!candidate.name || candidate.name.length < 3) continue
    const article = articles[candidate.article_index]
    if (!article) continue

    const existing = await env.GROWTH_DB.prepare(
      "SELECT id FROM accounts WHERE lower(name)=lower(?) OR lower(legal_name)=lower(?) LIMIT 1",
    )
      .bind(candidate.name, candidate.name)
      .first<{ id: string }>()

    const accountId = existing?.id || id()
    const now = nowIso()
    if (!existing) {
      await env.GROWTH_DB.prepare(
        `INSERT INTO accounts
          (id,name,account_type,status,source,source_url,created_at,updated_at)
         VALUES (?,?,?,'candidate','gdelt',?,?,?)`,
      )
        .bind(accountId, candidate.name, candidate.account_type || "unknown", article.url, now, now)
        .run()
      created += 1
    }

    await env.GROWTH_DB.prepare(
      `INSERT OR IGNORE INTO signals
        (id,account_id,kind,title,url,source,observed_at,strength,raw_json,created_at)
       VALUES (?,?, 'news_trigger', ?, ?, 'gdelt', ?, ?, ?, ?)`,
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

  await audit(env, "discovery", "gdelt", "batch", undefined, {
    articles: articles.length,
    organisations: extracted.length,
    created,
  })
  return { articles: articles.length, organisations: extracted.length }
}

export async function enrichAccount(env: Env, account: Account) {
  let domain = account.domain
  let country = account.country_code
  let legalName = account.legal_name
  const research: Record<string, unknown> = JSON.parse(account.research_json || "{}")

  if (!domain) {
    try {
      const website = await discoverWebsiteFromWikidata(account.name)
      if (website) domain = normalizeDomain(website)
    } catch {}
  }

  try {
    const gleif = await gleifLookup(account.name)
    if (gleif) {
      legalName ||= gleif.legal_name
      country ||= gleif.country_code
      research.lei = gleif.lei
    }
  } catch {}

  let homepageText = ""
  if (domain) {
    try {
      const origin = `https://${domain}`
      if (await robotsAllows(origin, "/")) {
        const response = await fetch(origin, {
          redirect: "follow",
          headers: { "User-Agent": "GIBPResearchBot/1.0 (+https://www.gibp.global)" },
        })
        if (response.ok && (response.headers.get("content-type") || "").includes("text/html")) {
          homepageText = (await response.text())
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .slice(0, 12000)
        }
      }
    } catch {}
  }

  const analysis =
    (await aiJson<{
      account_type: string
      fit_score: number
      summary: string
      likely_use_cases: string[]
      reasons: string[]
      red_flags: string[]
    }>(
      env,
      `Research an organisation for GIBP institutional business development.
GIBP is a provider-neutral financial intent, policy, liquidity and execution layer for institutional value movement.
Return JSON only: account_type, fit_score 0-100, summary, likely_use_cases[], reasons[], red_flags[].
Do not invent customers, regulatory status, integrations or facts not present in the material.`,
      `Organisation: ${account.name}\nCountry: ${country || "unknown"}\nDomain: ${domain || "unknown"}\nHomepage text: ${homepageText || "unavailable"}`,
    )) || null

  if (analysis) {
    research.analysis = analysis
  }

  const signal = await env.GROWTH_DB.prepare(
    "SELECT COALESCE(MAX(strength),0) AS max_strength FROM signals WHERE account_id=?",
  )
    .bind(account.id)
    .first<{ max_strength: number }>()

  const fitScore = Math.max(0, Math.min(100, Number(analysis?.fit_score ?? account.fit_score ?? 0)))
  const signalScore = Math.max(0, Math.min(100, Number(signal?.max_strength || 0) * 2))
  const totalScore = Math.max(0, Math.min(100, Math.round(fitScore * 0.65 + signalScore * 0.35)))

  await env.GROWTH_DB.prepare(
    `UPDATE accounts
     SET legal_name=?, domain=?, country_code=?, account_type=?, fit_score=?, signal_score=?, score=?,
         research_json=?, status=?, last_researched_at=?, updated_at=?
     WHERE id=?`,
  )
    .bind(
      legalName,
      domain,
      country,
      analysis?.account_type || account.account_type,
      fitScore,
      signalScore,
      totalScore,
      JSON.stringify(research),
      totalScore >= 55 ? "qualified" : "monitor",
      nowIso(),
      nowIso(),
      account.id,
    )
    .run()

  if (domain) await crawlPublicContacts(env, account.id, domain, country)
  await audit(env, "research", "account_enriched", "account", account.id, {
    domain,
    country,
    fitScore,
    signalScore,
    totalScore,
  })
}

export async function crawlPublicContacts(
  env: Env,
  accountId: string,
  domain: string,
  countryCode: string | null,
) {
  const origin = `https://${normalizeDomain(domain)}`
  const pages = ["/", "/contact", "/about", "/partnerships", "/innovation", "/corporate"]
  const seen = new Set<string>()

  for (const path of pages.slice(0, 5)) {
    try {
      if (!(await robotsAllows(origin, path))) continue
      const response = await fetch(new URL(path, origin), {
        redirect: "follow",
        headers: { "User-Agent": "GIBPResearchBot/1.0 (+https://www.gibp.global)" },
      })
      if (!response.ok || !(response.headers.get("content-type") || "").includes("text/html")) continue
      const html = (await response.text()).slice(0, 500_000)
      const emails = [
        ...html.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi),
        ...html.matchAll(/mailto:([^"'?\s>]+)/gi),
      ].map((match) => (match[1] || match[0]).replace(/^mailto:/i, "").toLowerCase())

      for (const email of emails) {
        if (seen.has(email)) continue
        seen.add(email)
        const emailDomain = email.split("@")[1]
        if (!emailDomain || !emailDomain.endsWith(normalizeDomain(domain))) continue
        const score = roleScore(email)
        if (score < 20) continue

        const now = nowIso()
        await env.GROWTH_DB.prepare(
          `INSERT INTO contacts
            (id,account_id,email,email_source,source_url,country_code,is_public,verified,seniority_score,status,created_at,updated_at)
           VALUES (?, ?, ?, 'public_web', ?, ?, 1, 1, ?, 'active', ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             source_url=excluded.source_url,
             is_public=1,
             verified=1,
             seniority_score=MAX(contacts.seniority_score, excluded.seniority_score),
             updated_at=excluded.updated_at`,
        )
          .bind(id(), accountId, email, response.url, countryCode, score, now, now)
          .run()
      }
    } catch {}
  }
}
