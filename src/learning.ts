import type { Env } from "./types"
import { aiJson } from "./ai"
import { audit, id, nowIso } from "./db"

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export async function recordCommercialOutcome(env: Env, body: any) {
  const allowed = new Set([
    "meeting_booked",
    "qualified_opportunity",
    "proposal_requested",
    "proposal_sent",
    "won",
    "lost",
    "deferred",
    "partner_agreed",
    "rfp_submitted",
  ])
  const outcome = String(body?.outcome || "")
  if (!allowed.has(outcome)) throw new Error("unsupported_outcome")

  let accountId = body.account_id ? String(body.account_id) : null
  const conversationId = body.conversation_id ? String(body.conversation_id) : null
  if (!accountId && conversationId) {
    const conversation = await env.GROWTH_DB.prepare(
      "SELECT account_id FROM conversations WHERE id=?",
    ).bind(conversationId).first<{ account_id: string }>()
    accountId = conversation?.account_id || null
  }
  if (!accountId) throw new Error("account_required")

  const occurredAt = body.occurred_at ? String(body.occurred_at).slice(0, 100) : nowIso()
  await env.GROWTH_DB.prepare(
    `INSERT INTO commercial_outcomes
     (id,conversation_id,account_id,outcome,value,currency,reason,occurred_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id(),
    conversationId,
    accountId,
    outcome,
    body.value == null ? null : Number(body.value),
    body.currency ? String(body.currency).slice(0, 10) : null,
    body.reason ? String(body.reason).slice(0, 2000) : null,
    occurredAt,
    nowIso(),
  ).run()

  await audit(env, "learning", "commercial_outcome", "account", accountId, {
    conversation_id: conversationId,
    outcome,
    value: body.value ?? null,
    currency: body.currency ?? null,
  })
  return { recorded: true, account_id: accountId, outcome }
}

function learningWeight(sample: number, positive: number, serious: number, won: number) {
  if (sample < 5) return 0
  const positiveRate = positive / sample
  const seriousRate = serious / sample
  const wonRate = won / sample
  return Math.round(clamp((positiveRate - 0.15) * 12 + seriousRate * 10 + wonRate * 15, -7, 10))
}

export async function recomputeCommercialLearnings(env: Env) {
  const dimensions = [
    {
      name: "country",
      sql: `SELECT COALESCE(NULLIF(a.country_code,''),'UNKNOWN') AS value,
                   COUNT(*) AS sample,
                   SUM(CASE WHEN c.inbound_count>0 AND c.score>=35 THEN 1 ELSE 0 END) AS positive,
                   SUM(CASE WHEN c.state='serious' OR c.human_handoff_at IS NOT NULL THEN 1 ELSE 0 END) AS serious,
                   SUM(CASE WHEN EXISTS (
                     SELECT 1 FROM commercial_outcomes co
                     WHERE co.conversation_id=c.id AND co.outcome IN ('won','partner_agreed')
                   ) THEN 1 ELSE 0 END) AS won
            FROM conversations c JOIN accounts a ON a.id=c.account_id
            GROUP BY COALESCE(NULLIF(a.country_code,''),'UNKNOWN')`,
    },
    {
      name: "pipeline",
      sql: `SELECT COALESCE(NULLIF(a.pipeline,''),'direct') AS value,
                   COUNT(*) AS sample,
                   SUM(CASE WHEN c.inbound_count>0 AND c.score>=35 THEN 1 ELSE 0 END) AS positive,
                   SUM(CASE WHEN c.state='serious' OR c.human_handoff_at IS NOT NULL THEN 1 ELSE 0 END) AS serious,
                   SUM(CASE WHEN EXISTS (
                     SELECT 1 FROM commercial_outcomes co
                     WHERE co.conversation_id=c.id AND co.outcome IN ('won','partner_agreed')
                   ) THEN 1 ELSE 0 END) AS won
            FROM conversations c JOIN accounts a ON a.id=c.account_id
            GROUP BY COALESCE(NULLIF(a.pipeline,''),'direct')`,
    },
    {
      name: "role",
      sql: `SELECT lower(COALESCE(NULLIF(trim(ct.role),''),'unknown')) AS value,
                   COUNT(*) AS sample,
                   SUM(CASE WHEN c.inbound_count>0 AND c.score>=35 THEN 1 ELSE 0 END) AS positive,
                   SUM(CASE WHEN c.state='serious' OR c.human_handoff_at IS NOT NULL THEN 1 ELSE 0 END) AS serious,
                   SUM(CASE WHEN EXISTS (
                     SELECT 1 FROM commercial_outcomes co
                     WHERE co.conversation_id=c.id AND co.outcome IN ('won','partner_agreed')
                   ) THEN 1 ELSE 0 END) AS won
            FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
            GROUP BY lower(COALESCE(NULLIF(trim(ct.role),''),'unknown'))`,
    },
  ]

  let stored = 0
  for (const dimension of dimensions) {
    const rows = await env.GROWTH_DB.prepare(dimension.sql).all<any>()
    for (const row of rows.results || []) {
      const sample = Number(row.sample || 0)
      const positive = Number(row.positive || 0)
      const serious = Number(row.serious || 0)
      const won = Number(row.won || 0)
      const weight = learningWeight(sample, positive, serious, won)

      await env.GROWTH_DB.prepare(
        `INSERT INTO commercial_learnings
         (dimension,dimension_value,sample_size,positive_count,serious_count,won_count,weight,updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(dimension,dimension_value) DO UPDATE SET
          sample_size=excluded.sample_size,positive_count=excluded.positive_count,
          serious_count=excluded.serious_count,won_count=excluded.won_count,
          weight=excluded.weight,updated_at=excluded.updated_at`,
      ).bind(
        dimension.name, row.value, sample, positive, serious, won, weight, nowIso(),
      ).run()
      stored += 1
    }
  }

  await env.GROWTH_DB.prepare(
    `UPDATE accounts SET priority_adjustment=CAST(ROUND((
       COALESCE((SELECT weight FROM commercial_learnings cl
                 WHERE cl.dimension='country'
                   AND cl.dimension_value=COALESCE(NULLIF(accounts.country_code,''),'UNKNOWN')),0)
       +
       COALESCE((SELECT weight FROM commercial_learnings cl
                 WHERE cl.dimension='pipeline'
                   AND cl.dimension_value=COALESCE(NULLIF(accounts.pipeline,''),'direct')),0)
     )/2.0) AS INTEGER)`,
  ).run()

  await env.GROWTH_DB.prepare(
    `UPDATE accounts SET score=MIN(100,MAX(0,
       ROUND(fit_score*0.65 + signal_score*0.35 + priority_adjustment)
     ))`,
  ).run()

  return { stored }
}

export function topicKeyForSignal(title: string) {
  const value = title.toLowerCase()
  if (/iso\s*20022/.test(value)) return "iso-20022"
  if (/instant payment|real[- ]time payment|faster payment/.test(value)) return "real-time-payments"
  if (/cross[- ]border|correspondent bank/.test(value)) return "cross-border-payments"
  if (/liquidity|treasury/.test(value)) return "liquidity-treasury"
  if (/stablecoin|digital asset|tokeni[sz]/.test(value)) return "digital-money"
  if (/open banking|open finance/.test(value)) return "open-banking"
  if (/payment.*modern|payment.*transform|orchestrat/.test(value)) return "payments-transformation"
  if (/fraud|compliance|regulat|remediation/.test(value)) return "risk-compliance"
  return "institutional-payments"
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
}

export async function generateAuthorityBriefings(env: Env) {
  const rows = await env.GROWTH_DB.prepare(
    `SELECT s.account_id,s.kind,s.title,s.url,s.source,s.observed_at,s.strength,a.name AS account_name
     FROM signals s JOIN accounts a ON a.id=s.account_id
     WHERE s.observed_at>=datetime('now','-7 day')
       AND s.url IS NOT NULL AND s.strength>=15
     ORDER BY s.strength DESC,s.observed_at DESC LIMIT 150`,
  ).all<any>()

  const groups = new Map<string, any[]>()
  for (const row of rows.results || []) {
    const key = topicKeyForSignal(row.title)
    groups.set(key, [...(groups.get(key) || []), row])
  }

  const minSources = Math.max(2, Number(env.AUTHORITY_MIN_SIGNAL_COUNT || 3))
  let published = 0
  for (const [topicKey, group] of [...groups.entries()].sort((a,b) => b[1].length-a[1].length)) {
    const unique = [...new Map(group.map((item) => [item.url, item])).values()]
    if (unique.length < minSources) continue

    const existing = await env.GROWTH_DB.prepare(
      "SELECT updated_at FROM authority_briefings WHERE topic_key=?",
    ).bind(topicKey).first<{ updated_at: string }>()
    if (existing && Date.now()-new Date(existing.updated_at).getTime() < 24*3600_000) continue

    const generated = await aiJson<any>(
      env,
      `Create a concise GIBP market briefing from supplied public signal headlines. Return JSON only with title, executive_summary and key_points[]. Do not add facts not explicit in the supplied titles. Do not imply GIBP has a relationship with any named organisation. Frame relevance at market level and keep uncertainty explicit.`,
      JSON.stringify(unique.slice(0,12).map((item:any) => ({
        title:item.title, source:item.source, url:item.url, observed_at:item.observed_at,
      }))),
    ) || {}

    const fallbackTitle = topicKey.split("-").map((w) => w.charAt(0).toUpperCase()+w.slice(1)).join(" ")
    const title = String(generated.title || `GIBP Market Briefing: ${fallbackTitle}`).slice(0,200)
    const summary = String(generated.executive_summary ||
      `A seven-day public-signal briefing covering ${fallbackTitle.toLowerCase()} developments relevant to institutional payments.`).slice(0,3000)
    const keyPoints = Array.isArray(generated.key_points) ? generated.key_points.map(String).slice(0,8) : []
    const affected = [...new Set(unique.map((item:any) => item.account_id))]
    const score = Math.min(100, Math.round(unique.length*10 + Math.max(...unique.map((x:any)=>Number(x.strength||0)))))

    await env.GROWTH_DB.prepare(
      `INSERT INTO authority_briefings
       (id,slug,topic_key,title,executive_summary,key_points_json,source_json,affected_accounts_json,
        score,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'published',?,?)
       ON CONFLICT(topic_key) DO UPDATE SET
        slug=excluded.slug,title=excluded.title,executive_summary=excluded.executive_summary,
        key_points_json=excluded.key_points_json,source_json=excluded.source_json,
        affected_accounts_json=excluded.affected_accounts_json,score=excluded.score,
        status='published',updated_at=excluded.updated_at`,
    ).bind(
      id(), slugify(`${topicKey}-${title}`), topicKey, title, summary,
      JSON.stringify(keyPoints), JSON.stringify(unique.slice(0,15)),
      JSON.stringify(affected), score, nowIso(), nowIso(),
    ).run()
    published += 1
    if (published>=2) break
  }

  await audit(env, "authority", "briefings_generated", "batch", undefined, { published })
  return { published }
}
