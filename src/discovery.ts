import type { Account, Env } from "./types"
import { aiJson } from "./ai"
import { audit, getSetting, id, nowIso, setSetting } from "./db"

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

const genericMailboxPattern =
  /^(info|contact|hello|enquiries?|inquiries?|support|sales|commercial|office|admin|marketing|press|media|privacy|security|abuse|help|customerservice|customer\.service|partnerships?|alliances?|procurement|supplier|vendors?)\d*$/i

export function isGenericRoleEmail(email: string) {
  const local = email.split("@")[0]?.toLowerCase().replace(/[._+-]/g, "") || ""
  return !local || genericMailboxPattern.test(local)
}

function stripTags(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
}

function cleanPersonName(value: string) {
  const clean = stripTags(value)
    .replace(/^(?:email|e-mail|contact|contacting|mailto)\s*[:\-]?\s*/i, "")
    .trim()
  if (clean.length < 5 || clean.length > 80) return null
  const words = clean.split(/\s+/)
  if (words.length < 2 || words.length > 5) return null
  if (!words.every((word) => /^[\p{L}][\p{L}'’.-]*$/u.test(word))) return null
  if (/\b(team|office|support|sales|contact|enquiries|inquiries|department|bank|group|company|limited|ltd|plc)\b/i.test(clean)) {
    return null
  }
  return clean
}

function extractTargetRole(value: string) {
  const text = stripTags(value)
  const patterns = [
    /\bchief executive officer\b|\bCEO\b/i,
    /\bmanaging director\b|\bMD\b/i,
    /\bchief technology officer\b|\bCTO\b/i,
    /\bchief information officer\b|\bCIO\b/i,
    /\bchief digital officer\b|\bCDO\b/i,
    /\bhead of payments?\b|\bpayments? director\b/i,
    /\bhead of transaction banking\b|\btransaction banking director\b/i,
    /\bhead of treasury(?: technology)?\b|\btreasury director\b/i,
    /\bhead of liquidity\b|\bliquidity director\b/i,
    /\bpayments? transformation(?: director| lead| head)?\b/i,
    /\bhead of innovation\b|\binnovation director\b/i,
    /\bhead of partnerships?\b|\bpartnerships? director\b|\balliances? director\b/i,
    /\bhead of business development\b|\bbusiness development director\b/i,
    /\bhead of procurement\b|\bprocurement director\b/i,
    /\bhead of vendor management\b|\bvendor management director\b/i,
    /\bfounder\b|\bco-founder\b/i,
    /\bvice president\b|\bVP\b/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match[0].trim()
  }
  return null
}

function roleScore(role: string) {
  if (/chief|CEO|CTO|CIO|CDO|managing director/i.test(role)) return 95
  if (/head of payments|payments? director|transaction banking|treasury|liquidity|transformation/i.test(role)) return 90
  if (/head of partnerships|partnerships? director|alliance|business development|innovation/i.test(role)) return 85
  if (/procurement|vendor management/i.test(role)) return 75
  if (/founder|vice president|\bVP\b/i.test(role)) return 80
  return 0
}

type NamedPublicContact = {
  name: string
  role: string
  email: string
}

function collectJsonLdPeople(value: unknown, output: NamedPublicContact[], domain: string) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdPeople(item, output, domain)
    return
  }
  if (!value || typeof value !== "object") return

  const item = value as Record<string, unknown>
  const type = item["@type"]
  const types = Array.isArray(type) ? type.map(String) : [String(type || "")]
  if (types.some((entry) => entry.toLowerCase() === "person")) {
    const name = cleanPersonName(String(item.name || ""))
    const role = extractTargetRole(String(item.jobTitle || item.roleName || ""))
    const rawEmail = String(item.email || "").replace(/^mailto:/i, "").trim().toLowerCase()
    const emailDomain = rawEmail.split("@")[1] || ""
    if (
      name &&
      role &&
      rawEmail &&
      emailDomain.endsWith(domain) &&
      !isGenericRoleEmail(rawEmail)
    ) {
      output.push({ name, role, email: rawEmail })
    }
  }

  for (const child of Object.values(item)) {
    if (child && typeof child === "object") collectJsonLdPeople(child, output, domain)
  }
}

export function extractNamedPublicContacts(html: string, domainInput: string) {
  const domain = normalizeDomain(domainInput)
  const output: NamedPublicContact[] = []
  const seen = new Set<string>()

  for (const script of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      collectJsonLdPeople(JSON.parse(script[1]), output, domain)
    } catch {}
  }

  for (const match of html.matchAll(
    /<a\b[^>]*href=["']mailto:([^"'?\s>]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const email = String(match[1] || "").trim().toLowerCase()
    const emailDomain = email.split("@")[1] || ""
    if (!emailDomain.endsWith(domain) || isGenericRoleEmail(email)) continue

    const name = cleanPersonName(match[2] || "")
    if (!name) continue

    const offset = match.index || 0
    const context = html.slice(Math.max(0, offset - 500), Math.min(html.length, offset + match[0].length + 500))
    const role = extractTargetRole(context)
    if (!role || roleScore(role) < 60) continue
    output.push({ name, role, email })
  }

  return output.filter((contact) => {
    if (seen.has(contact.email)) return false
    seen.add(contact.email)
    return true
  })
}

async function contactDiscoveryPages(origin: string) {
  const fixed = [
    "/",
    "/contact",
    "/contact-us",
    "/about",
    "/about-us",
    "/leadership",
    "/management",
    "/team",
    "/partnerships",
    "/partners",
    "/innovation",
    "/corporate",
    "/business",
    "/payments",
    "/transaction-banking",
    "/treasury",
  ]

  try {
    const response = await fetch(new URL("/sitemap.xml", origin), {
      redirect: "follow",
      headers: { "User-Agent": "GIBPResearchBot/1.0 (+https://www.gibp.global)" },
    })
    if (response.ok) {
      const xml = (await response.text()).slice(0, 1_000_000)
      for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
        try {
          const url = new URL(match[1].trim())
          if (
            normalizeDomain(url.hostname) === normalizeDomain(new URL(origin).hostname) &&
            /contact|about|leadership|management|team|partner|alliance|innovation|corporate|business|payment|transaction|treasury|liquidity|procurement|vendor/i.test(url.pathname)
          ) {
            fixed.push(url.pathname + url.search)
          }
        } catch {}
      }
    }
  } catch {}

  return [...new Set(fixed)].slice(0, 10)
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


function parseCsv(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (char === '"' && quoted && next === '"') {
      field += '"'
      i += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === "," && !quoted) {
      row.push(field.trim())
      field = ""
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1
      row.push(field.trim())
      field = ""
      if (row.some(Boolean)) rows.push(row)
      row = []
    } else {
      field += char
    }
  }

  if (field || row.length) {
    row.push(field.trim())
    if (row.some(Boolean)) rows.push(row)
  }
  return rows
}

async function upsertDirectoryBank(
  env: Env,
  input: {
    name: string
    domain?: string | null
    countryCode?: string | null
    source: string
    sourceUrl: string
    sourceId?: string | null
    metadata?: Record<string, unknown>
    fitScore?: number
    signalStrength?: number
  },
) {
  const name = input.name.trim()
  const domain = input.domain ? normalizeDomain(input.domain) : null
  if (!name || name.length < 2) return false

  const existing = await env.GROWTH_DB.prepare(
    `SELECT id FROM accounts
     WHERE lower(name)=lower(?)
        OR lower(legal_name)=lower(?)
        OR (? IS NOT NULL AND lower(domain)=lower(?))
     LIMIT 1`,
  )
    .bind(name, name, domain, domain)
    .first<{ id: string }>()

  const accountId = existing?.id || id()
  const now = nowIso()
  const fitScore = Math.max(55, Math.min(95, Number(input.fitScore || 78)))
  const signalStrength = Math.max(5, Math.min(25, Number(input.signalStrength || 10)))

  if (!existing) {
    await env.GROWTH_DB.prepare(
      `INSERT INTO accounts
        (id,name,legal_name,domain,country_code,account_type,pipeline,status,
         score,fit_score,source,source_url,research_json,created_at,updated_at)
       VALUES (?,?,?,?,?,'bank','direct','candidate',?,?,?, ?,?,?,?)`,
    )
      .bind(
        accountId,
        name,
        name,
        domain,
        input.countryCode || null,
        Math.round(fitScore * 0.65 + signalStrength * 2 * 0.35),
        fitScore,
        input.source,
        input.sourceUrl,
        JSON.stringify({
          directory: input.source,
          source_id: input.sourceId || null,
          ...(input.metadata || {}),
        }),
        now,
        now,
      )
      .run()
  } else {
    await env.GROWTH_DB.prepare(
      `UPDATE accounts SET
        domain=COALESCE(domain,?),
        country_code=COALESCE(country_code,?),
        fit_score=MAX(fit_score,?),
        updated_at=?
       WHERE id=?`,
    )
      .bind(domain, input.countryCode || null, fitScore, now, accountId)
      .run()
  }

  const signalUrl = input.sourceId
    ? `${input.sourceUrl}#${encodeURIComponent(input.sourceId)}`
    : `${input.sourceUrl}#${encodeURIComponent(name)}`

  await env.GROWTH_DB.prepare(
    `INSERT OR IGNORE INTO signals
      (id,account_id,kind,title,url,source,observed_at,strength,raw_json,created_at)
     VALUES (?,?,'directory_presence',?,?,?, ?,?,?,?)`,
  )
    .bind(
      id(),
      accountId,
      `Listed by ${input.source}`,
      signalUrl,
      input.source,
      now,
      signalStrength,
      JSON.stringify(input.metadata || {}),
      now,
    )
    .run()

  return !existing
}

async function discoverPraBanks(env: Env) {
  const pageUrl =
    "https://www.bankofengland.co.uk/prudential-regulation/authorisations/which-firms-does-the-pra-regulate"

  try {
    const page = await fetch(pageUrl, {
      headers: { "User-Agent": "GIBPGrowth/1.0 (+https://www.gibp.global)" },
    })
    if (!page.ok) {
      await audit(env, "discovery", "pra_directory_failed", "source", "bank_of_england", {
        status: page.status,
      })
      return { found: 0, created: 0 }
    }

    const html = await page.text()
    const matches = [...html.matchAll(/href=["']([^"']*banks-list-\d+\.csv[^"']*)["']/gi)]
    if (!matches.length) {
      await audit(env, "discovery", "pra_directory_failed", "source", "bank_of_england", {
        reason: "csv_link_not_found",
      })
      return { found: 0, created: 0 }
    }

    const csvUrl = new URL(matches[0][1].replaceAll("&amp;", "&"), page.url).toString()
    const csvResponse = await fetch(csvUrl, {
      headers: { "User-Agent": "GIBPGrowth/1.0 (+https://www.gibp.global)" },
    })
    if (!csvResponse.ok) {
      await audit(env, "discovery", "pra_directory_failed", "source", "bank_of_england", {
        status: csvResponse.status,
        stage: "csv",
      })
      return { found: 0, created: 0 }
    }

    const rows = parseCsv(await csvResponse.text())
    const headerIndex = rows.findIndex((row) =>
      row.some((cell) => /firm\s*name/i.test(cell)),
    )
    if (headerIndex < 0) {
      await audit(env, "discovery", "pra_directory_failed", "source", "bank_of_england", {
        reason: "header_not_found",
      })
      return { found: 0, created: 0 }
    }

    const headers = rows[headerIndex].map((cell) => cell.trim().toLowerCase())
    const nameIndex = headers.findIndex((cell) => /firm\s*name/.test(cell))
    const frnIndex = headers.findIndex((cell) => /^frn\b/.test(cell))
    const leiIndex = headers.findIndex((cell) => /^lei\b/.test(cell))
    let created = 0
    let found = 0

    for (const row of rows.slice(headerIndex + 1)) {
      const name = row[nameIndex]?.trim()
      if (!name || /^uk banks|international banks|branches/i.test(name)) continue
      found += 1
      if (
        await upsertDirectoryBank(env, {
          name,
          countryCode: "GB",
          source: "bank_of_england_pra",
          sourceUrl: csvUrl,
          sourceId: row[leiIndex]?.trim() || row[frnIndex]?.trim() || name,
          metadata: {
            frn: row[frnIndex]?.trim() || null,
            lei: row[leiIndex]?.trim() || null,
          },
          fitScore: 80,
          signalStrength: 10,
        })
      ) {
        created += 1
      }
    }

    await audit(env, "discovery", "pra_directory", "source", "bank_of_england", {
      found,
      created,
      csv_url: csvUrl,
    })
    return { found, created }
  } catch (error) {
    await audit(env, "discovery", "pra_directory_exception", "source", "bank_of_england", {
      error: error instanceof Error ? error.message : "unknown",
    })
    return { found: 0, created: 0 }
  }
}

async function discoverWikidataBanks(env: Env) {
  const previousOffset = Number((await getSetting(env, "wikidata_bank_offset")) || 0)
  const offset = Number.isFinite(previousOffset) ? Math.max(0, previousOffset) : 0
  const query = `
SELECT ?item ?itemLabel ?website ?countryCode WHERE {
  ?item wdt:P31 wd:Q22687;
        wdt:P856 ?website.
  OPTIONAL {
    ?item wdt:P17 ?country.
    ?country wdt:P297 ?countryCode.
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?item
LIMIT 100
OFFSET ${offset}
`
  const url = new URL("https://query.wikidata.org/sparql")
  url.searchParams.set("query", query)
  url.searchParams.set("format", "json")

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": "GIBPGrowth/1.0 (+https://www.gibp.global)",
      },
    })
    if (!response.ok) {
      await audit(env, "discovery", "wikidata_directory_failed", "source", "wikidata", {
        status: response.status,
        offset,
      })
      return { found: 0, created: 0, offset }
    }

    const payload = (await response.json()) as {
      results?: {
        bindings?: Array<{
          item?: { value?: string }
          itemLabel?: { value?: string }
          website?: { value?: string }
          countryCode?: { value?: string }
        }>
      }
    }

    const bindings = payload.results?.bindings || []
    let created = 0
    for (const item of bindings) {
      const name = item.itemLabel?.value?.trim()
      const website = item.website?.value?.trim()
      if (!name || !website || /^Q\d+$/.test(name)) continue
      if (
        await upsertDirectoryBank(env, {
          name,
          domain: website,
          countryCode: item.countryCode?.value || null,
          source: "wikidata_bank_directory",
          sourceUrl: item.item?.value || "https://www.wikidata.org/",
          sourceId: item.item?.value?.split("/").pop() || name,
          metadata: { wikidata: item.item?.value || null },
          fitScore: 76,
          signalStrength: 10,
        })
      ) {
        created += 1
      }
    }

    const nextOffset = bindings.length < 100 ? 0 : offset + 100
    await setSetting(env, "wikidata_bank_offset", String(nextOffset))
    await audit(env, "discovery", "wikidata_directory", "source", "wikidata", {
      found: bindings.length,
      created,
      offset,
      next_offset: nextOffset,
    })
    return { found: bindings.length, created, offset }
  } catch (error) {
    await audit(env, "discovery", "wikidata_directory_exception", "source", "wikidata", {
      error: error instanceof Error ? error.message : "unknown",
      offset,
    })
    return { found: 0, created: 0, offset }
  }
}

export async function discoverOfficialBankDirectories(env: Env) {
  const last = await getSetting(env, "last_bank_directory_discovery_at")
  if (last && Date.now() - new Date(last).getTime() < 24 * 3600_000) {
    return { skipped: true, reason: "not_due" }
  }

  const pra = await discoverPraBanks(env)
  const wikidata = await discoverWikidataBanks(env)
  await setSetting(env, "last_bank_directory_discovery_at", nowIso())
  return { pra, wikidata }
}

export async function discoverNewsCandidates(env: Env) {
  if (await gdeltBackoffActive(env)) {
    return { articles: 0, organisations: 0, skipped: true, reason: "gdelt_backoff" }
  }

  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc")
  url.searchParams.set("query", env.DISCOVERY_QUERY || defaultQuery)
  url.searchParams.set("mode", "ArtList")
  url.searchParams.set("format", "json")
  url.searchParams.set("maxrecords", "40")
  url.searchParams.set("sort", "HybridRel")
  const response = await fetch(url)
  if (!response.ok) {
    await audit(env, "discovery", "gdelt_feed_failed", "source", "gdelt", {
      status: response.status,
      retry_after: response.headers.get("retry-after"),
    })
    if (response.status === 429) await activateGdeltBackoff(env, "gdelt")
    return { articles: 0, organisations: 0 }
  }

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
  const normalizedDomain = normalizeDomain(domain)
  const origin = `https://${normalizedDomain}`
  const pages = await contactDiscoveryPages(origin)
  const seen = new Set<string>()
  let stored = 0
  let pagesChecked = 0

  for (const path of pages) {
    try {
      if (!(await robotsAllows(origin, path))) continue
      const response = await fetch(new URL(path, origin), {
        redirect: "follow",
        headers: { "User-Agent": "GIBPResearchBot/1.0 (+https://www.gibp.global)" },
      })
      if (!response.ok || !(response.headers.get("content-type") || "").includes("text/html")) continue
      pagesChecked += 1
      const html = (await response.text()).slice(0, 750_000)

      for (const contact of extractNamedPublicContacts(html, normalizedDomain)) {
        if (seen.has(contact.email)) continue
        seen.add(contact.email)

        const score = roleScore(contact.role)
        if (score < 60) continue

        const now = nowIso()
        await env.GROWTH_DB.prepare(
          `INSERT INTO contacts
            (id,account_id,name,role,email,email_source,source_url,country_code,is_public,verified,
             seniority_score,consent_status,lawful_basis,status,created_at,updated_at)
           VALUES (?, ?, ?, ?, ?, 'official_named_public', ?, ?, 1, 1, ?, 'unknown',
             'corporate_b2b_public_professional', 'active', ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             name=excluded.name,
             role=excluded.role,
             source_url=excluded.source_url,
             is_public=1,
             verified=1,
             seniority_score=MAX(contacts.seniority_score, excluded.seniority_score),
             updated_at=excluded.updated_at`,
        )
          .bind(
            id(),
            accountId,
            contact.name,
            contact.role,
            contact.email,
            response.url,
            countryCode,
            score,
            now,
            now,
          )
          .run()
        stored += 1
      }
    } catch {}
  }

  await audit(env, "contacts", "public_scan", "account", accountId, {
    domain: normalizedDomain,
    pages_checked: pagesChecked,
    named_contacts: stored,
  })
  return stored
}

