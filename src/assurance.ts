import type { Account, Contact, Env, GrowthJob } from "./types"
import { getSetting, id, nowIso, setSetting } from "./db"
import { workingTimeDecision } from "./lifecycle"

const HOUR_MS = 3600_000

export async function recordJobStarted(env: Env, kind: GrowthJob["kind"], expectedMinutes = 60) {
  const now = nowIso()
  await env.GROWTH_DB.prepare(
    `INSERT INTO job_heartbeats
      (job_kind,expected_interval_minutes,last_started_at,updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(job_kind) DO UPDATE SET
       expected_interval_minutes=excluded.expected_interval_minutes,
       last_started_at=excluded.last_started_at,
       updated_at=excluded.updated_at`,
  ).bind(kind, expectedMinutes, now, now).run()
  return now
}

export async function recordJobSucceeded(
  env: Env,
  kind: GrowthJob["kind"],
  startedAt: string,
  result: unknown,
) {
  const now = nowIso()
  const duration = Math.max(0, Date.now() - new Date(startedAt).getTime())
  await env.GROWTH_DB.prepare(
    `UPDATE job_heartbeats
     SET last_success_at=?,consecutive_failures=0,last_duration_ms=?,
         last_error=NULL,last_result_json=?,updated_at=?
     WHERE job_kind=?`,
  ).bind(now, duration, JSON.stringify(result).slice(0, 20000), now, kind).run()
}

export async function recordJobFailed(
  env: Env,
  kind: GrowthJob["kind"],
  startedAt: string,
  error: unknown,
) {
  const now = nowIso()
  const duration = Math.max(0, Date.now() - new Date(startedAt).getTime())
  await env.GROWTH_DB.prepare(
    `UPDATE job_heartbeats
     SET last_failed_at=?,consecutive_failures=consecutive_failures+1,last_duration_ms=?,
         last_error=?,updated_at=?
     WHERE job_kind=?`,
  ).bind(
    now,
    duration,
    String(error instanceof Error ? error.stack || error.message : error).slice(0, 5000),
    now,
    kind,
  ).run()
}

export async function heartbeatHealth(env: Env) {
  const rows = await env.GROWTH_DB.prepare(
    `SELECT * FROM job_heartbeats ORDER BY job_kind`,
  ).all<any>()

  const stale: any[] = []
  const failing: any[] = []
  for (const row of rows.results || []) {
    const expectedMs = Math.max(30, Number(row.expected_interval_minutes || 60)) * 60_000
    const successMs = row.last_success_at ? new Date(row.last_success_at).getTime() : 0
    if (!successMs || Date.now() - successMs > expectedMs * 2.5) stale.push(row)
    if (Number(row.consecutive_failures || 0) >= 2) failing.push(row)
  }

  return {
    total: rows.results?.length || 0,
    stale,
    failing,
    heartbeats: rows.results || [],
  }
}

export async function accountGovernanceDecision(env: Env, accountId: string) {
  const row = await env.GROWTH_DB.prepare(
    `SELECT * FROM account_governance WHERE account_id=?`,
  ).bind(accountId).first<any>()

  if (!row) return { allowed: true, reason: "ok", governance: null }
  if (row.never_contact) return { allowed: false, reason: "account_never_contact", governance: row }

  const approvalRequired = Boolean(row.manual_review_required || row.vip)
  if (approvalRequired && !row.manual_review_approved_at) {
    return {
      allowed: false,
      reason: row.vip ? "vip_manual_review_required" : "account_manual_review_required",
      governance: row,
    }
  }

  return { allowed: true, reason: "ok", governance: row }
}

function withinDays(value: string | null | undefined, days: number) {
  if (!value) return false
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) && Date.now() - ms <= days * 86400_000
}

export async function assessContactQuality(
  env: Env,
  contact: Contact,
  account: Account,
) {
  const freshnessDays = Math.max(30, Number(env.CONTACT_FRESHNESS_DAYS || 90))
  const identityAt = contact.identity_verified_at || contact.updated_at
  const roleAt = contact.role_verified_at || contact.updated_at

  const identityScore = contact.name?.trim()
    ? withinDays(identityAt, freshnessDays) ? 20 : 10
    : 0
  const roleScore = contact.role?.trim()
    ? withinDays(roleAt, freshnessDays) ? 20 : 8
    : 0
  const sourceScore =
    contact.source_url && contact.is_public ? 15 :
    contact.is_public ? 10 :
    contact.consent_status === "express" ? 12 : 4

  const qev = await env.GROWTH_DB.prepare(
    `SELECT result,safe_to_send,disposable,accept_all,role,verified_at
     FROM contact_email_verifications
     WHERE contact_id=? AND provider='quickemailverification'
     ORDER BY verified_at DESC LIMIT 1`,
  ).bind(contact.id).first<any>()

  const qevFresh = qev?.verified_at && withinDays(qev.verified_at, 30)
  const verificationScore =
    contact.verified && qevFresh && qev?.result === "valid" && qev?.safe_to_send &&
      !qev?.disposable && !qev?.accept_all && !qev?.role
      ? 25
      : contact.verified ? 10 : 0

  const country = (contact.country_code || account.country_code || "").toUpperCase()
  const policy = country
    ? await env.GROWTH_DB.prepare(
        `SELECT jp.allowed,pe.review_due_at
         FROM jurisdiction_policies jp
         LEFT JOIN jurisdiction_policy_evidence pe ON pe.country_code=jp.country_code
         WHERE jp.country_code=?`,
      ).bind(country).first<any>()
    : null
  const jurisdictionScore =
    policy?.allowed && policy?.review_due_at && new Date(policy.review_due_at).getTime() > Date.now()
      ? 10
      : policy?.allowed ? 5 : 0

  const freshestEvidence = [contact.updated_at, identityAt, roleAt, qev?.verified_at]
    .filter(Boolean)
    .map((x) => new Date(String(x)).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0]
  const freshnessScore = freshestEvidence && Date.now() - freshestEvidence <= freshnessDays * 86400_000 ? 10 : 0

  const reasons: string[] = []
  if (!contact.name?.trim()) reasons.push("identity_missing")
  if (!withinDays(identityAt, freshnessDays)) reasons.push("identity_stale")
  if (!contact.role?.trim()) reasons.push("role_missing")
  if (!withinDays(roleAt, freshnessDays)) reasons.push("role_stale")
  if (!contact.source_url && !contact.is_public) reasons.push("weak_source_evidence")
  if (verificationScore < 25) reasons.push("email_verification_not_current_safe")
  if (jurisdictionScore < 10) reasons.push("jurisdiction_evidence_not_current")

  const score = identityScore + roleScore + sourceScore + verificationScore + jurisdictionScore + freshnessScore
  await env.GROWTH_DB.prepare(
    `INSERT INTO contact_data_quality
      (contact_id,score,identity_score,role_score,source_score,verification_score,
       jurisdiction_score,freshness_score,reasons_json,computed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(contact_id) DO UPDATE SET
       score=excluded.score,identity_score=excluded.identity_score,role_score=excluded.role_score,
       source_score=excluded.source_score,verification_score=excluded.verification_score,
       jurisdiction_score=excluded.jurisdiction_score,freshness_score=excluded.freshness_score,
       reasons_json=excluded.reasons_json,computed_at=excluded.computed_at`,
  ).bind(
    contact.id, score, identityScore, roleScore, sourceScore, verificationScore,
    jurisdictionScore, freshnessScore, JSON.stringify(reasons), nowIso(),
  ).run()

  return {
    score,
    minimum: Math.max(50, Number(env.QUALITY_MIN_SCORE || 75)),
    reasons,
    identity_at: identityAt,
    role_at: roleAt,
  }
}

export async function refreshContactQualityBatch(env: Env, limit = 100) {
  const rows = await env.GROWTH_DB.prepare(
    `SELECT ct.*,a.name AS a_name,a.legal_name AS a_legal_name,a.domain AS a_domain,
            a.country_code AS a_country_code,a.account_type AS a_account_type,a.pipeline AS a_pipeline,
            a.status AS a_status,a.score AS a_score,a.fit_score AS a_fit_score,a.signal_score AS a_signal_score,
            a.engagement_score AS a_engagement_score,a.risk_score AS a_risk_score,
            a.priority_adjustment AS a_priority_adjustment,a.partner_track AS a_partner_track,
            a.source AS a_source,a.source_url AS a_source_url,a.research_json AS a_research_json,
            a.last_researched_at AS a_last_researched_at,a.next_action_at AS a_next_action_at,
            a.created_at AS a_created_at,a.updated_at AS a_updated_at
     FROM contacts ct
     JOIN accounts a ON a.id=ct.account_id
     LEFT JOIN contact_data_quality dq ON dq.contact_id=ct.id
     WHERE ct.status='active'
       AND (dq.contact_id IS NULL OR dq.computed_at<datetime('now','-1 day'))
     ORDER BY ct.updated_at DESC LIMIT ?`,
  ).bind(Math.max(1, Math.min(500, limit))).all<any>()

  let refreshed = 0
  for (const row of rows.results || []) {
    const account: Account = {
      id: row.account_id,
      name: row.a_name,
      legal_name: row.a_legal_name,
      domain: row.a_domain,
      country_code: row.a_country_code,
      account_type: row.a_account_type,
      pipeline: row.a_pipeline,
      status: row.a_status,
      score: row.a_score,
      fit_score: row.a_fit_score,
      signal_score: row.a_signal_score,
      engagement_score: row.a_engagement_score,
      risk_score: row.a_risk_score,
      priority_adjustment: row.a_priority_adjustment,
      partner_track: row.a_partner_track,
      source: row.a_source,
      source_url: row.a_source_url,
      research_json: row.a_research_json,
      last_researched_at: row.a_last_researched_at,
      next_action_at: row.a_next_action_at,
      created_at: row.a_created_at,
      updated_at: row.a_updated_at,
    }
    await assessContactQuality(env, row as Contact, account)
    refreshed += 1
  }
  return { refreshed }
}

function localDateKey(timezone: string, date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value || ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

async function isBlackout(env: Env, country: string, timezone: string, date: Date) {
  if (!country) return null
  const key = localDateKey(timezone, date)
  return env.GROWTH_DB.prepare(
    "SELECT name,source,manual FROM sending_blackouts WHERE country_code=? AND date=?",
  ).bind(country, key).first<{ name: string; source: string; manual: number }>()
}

export async function sendingTimeDecision(
  env: Env,
  contact: Pick<Contact, "timezone" | "country_code">,
  account: Pick<Account, "country_code">,
  nowMs = Date.now(),
) {
  const base = workingTimeDecision(contact, account, nowMs)
  if (!base.allowed) return { ...base, blackout: null }

  const country = (contact.country_code || account.country_code || "").toUpperCase()
  const blackout = await isBlackout(env, country, base.timezone, new Date(nowMs))
  if (!blackout) return { ...base, blackout: null }

  for (let step = 1; step <= 8 * 48; step += 1) {
    const candidateMs = nowMs + step * 30 * 60_000
    const timing = workingTimeDecision(contact, account, candidateMs)
    if (!timing.allowed) continue
    const blocked = await isBlackout(env, country, timing.timezone, new Date(candidateMs))
    if (!blocked) {
      return {
        allowed: false,
        timezone: timing.timezone,
        next_action_at: new Date(candidateMs).toISOString(),
        blackout,
      }
    }
  }

  return {
    allowed: false,
    timezone: base.timezone,
    next_action_at: new Date(nowMs + 24 * HOUR_MS).toISOString(),
    blackout,
  }
}

export async function syncPublicHolidays(env: Env) {
  const countries = await env.GROWTH_DB.prepare(
    `SELECT DISTINCT upper(COALESCE(ct.country_code,a.country_code,'')) AS country_code
     FROM contacts ct JOIN accounts a ON a.id=ct.account_id
     WHERE ct.status='active'
       AND length(COALESCE(ct.country_code,a.country_code,''))=2
     ORDER BY country_code LIMIT 20`,
  ).all<{ country_code: string }>()

  const years = [new Date().getUTCFullYear(), new Date().getUTCFullYear() + 1]
  let stored = 0
  const failures: Array<{ country: string; year: number; error: string }> = []

  for (const row of countries.results || []) {
    for (const year of years) {
      const existing = await env.GROWTH_DB.prepare(
        `SELECT COUNT(*) AS total FROM sending_blackouts
         WHERE country_code=? AND source='nager_date' AND substr(date,1,4)=?`,
      ).bind(row.country_code, String(year)).first<{ total: number }>()
      if (Number(existing?.total || 0) > 0) continue

      try {
        const response = await fetch(
          `https://date.nager.at/api/v3/PublicHolidays/${year}/${encodeURIComponent(row.country_code)}`,
          { signal: AbortSignal.timeout(12_000) },
        )
        if (!response.ok) throw new Error(`holiday_provider_${response.status}`)
        const payload = await response.json() as Array<{ date: string; localName?: string; name?: string }>
        for (const holiday of payload || []) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(holiday.date || ""))) continue
          await env.GROWTH_DB.prepare(
            `INSERT INTO sending_blackouts
              (country_code,date,name,source,manual,created_at,updated_at)
             VALUES (?,?,?,'nager_date',0,?,?)
             ON CONFLICT(country_code,date) DO UPDATE SET
               name=CASE WHEN sending_blackouts.manual=1 THEN sending_blackouts.name ELSE excluded.name END,
               source=CASE WHEN sending_blackouts.manual=1 THEN sending_blackouts.source ELSE excluded.source END,
               updated_at=excluded.updated_at`,
          ).bind(
            row.country_code,
            holiday.date,
            String(holiday.localName || holiday.name || "Public holiday").slice(0, 300),
            nowIso(),
            nowIso(),
          ).run()
          stored += 1
        }
      } catch (error) {
        failures.push({
          country: row.country_code,
          year,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  await setSetting(env, "last_holiday_sync_at", nowIso())
  return { stored, failures, countries: countries.results?.length || 0 }
}

export async function upsertSendingBlackout(
  env: Env,
  input: { country_code: string; date: string; name: string },
) {
  const country = input.country_code.toUpperCase().slice(0, 2)
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("invalid_country_code")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("invalid_date")
  await env.GROWTH_DB.prepare(
    `INSERT INTO sending_blackouts
      (country_code,date,name,source,manual,created_at,updated_at)
     VALUES (?,?,?,'admin',1,?,?)
     ON CONFLICT(country_code,date) DO UPDATE SET
       name=excluded.name,source='admin',manual=1,updated_at=excluded.updated_at`,
  ).bind(country, input.date, input.name.slice(0,300), nowIso(), nowIso()).run()
  return { country_code: country, date: input.date, name: input.name }
}

export async function funnelSnapshot(env: Env) {
  const totals = await env.GROWTH_DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM accounts) AS accounts,
      (SELECT COUNT(*) FROM accounts WHERE status='qualified') AS qualified_accounts,
      (SELECT COUNT(*) FROM contacts WHERE status='active') AS active_contacts,
      (SELECT COUNT(*) FROM contact_email_verifications WHERE safe_to_send=1 AND verified_at>=datetime('now','-30 day')) AS verified_contacts,
      (SELECT COUNT(DISTINCT conversation_id) FROM messages WHERE direction='outbound' AND classification='initial') AS contacted,
      (SELECT COUNT(DISTINCT conversation_id) FROM messages WHERE direction='inbound') AS replied,
      (SELECT COUNT(DISTINCT conversation_id) FROM messages WHERE direction='inbound'
        AND classification IN ('positive','information_request','meeting_request','referral','commercial_terms','security_or_legal')) AS positive,
      (SELECT COUNT(DISTINCT conversation_id) FROM handoffs) AS handoffs,
      (SELECT COUNT(*) FROM meeting_requests WHERE status='scheduled') AS meetings,
      (SELECT COUNT(DISTINCT account_id) FROM commercial_outcomes WHERE outcome IN ('qualified_opportunity','proposal_requested','proposal_sent')) AS opportunities,
      (SELECT COUNT(DISTINCT account_id) FROM commercial_outcomes WHERE outcome IN ('won','partner_agreed')) AS won,
      (SELECT COALESCE(SUM(value),0) FROM commercial_outcomes WHERE outcome IN ('won','partner_agreed')) AS won_value`,
  ).first<any>()

  const bySource = await env.GROWTH_DB.prepare(
    `SELECT COALESCE(a.source,'unknown') AS dimension,
            COUNT(DISTINCT c.id) AS conversations,
            SUM(CASE WHEN c.inbound_count>0 THEN 1 ELSE 0 END) AS replies,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM commercial_outcomes co
              WHERE co.account_id=a.id AND co.outcome IN ('won','partner_agreed')
            ) THEN 1 ELSE 0 END) AS won
     FROM conversations c JOIN accounts a ON a.id=c.account_id
     GROUP BY COALESCE(a.source,'unknown')
     ORDER BY conversations DESC LIMIT 20`,
  ).all<any>()

  const byCountry = await env.GROWTH_DB.prepare(
    `SELECT COALESCE(NULLIF(a.country_code,''),'UNKNOWN') AS dimension,
            COUNT(DISTINCT c.id) AS conversations,
            SUM(CASE WHEN c.inbound_count>0 THEN 1 ELSE 0 END) AS replies,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM commercial_outcomes co
              WHERE co.account_id=a.id AND co.outcome IN ('won','partner_agreed')
            ) THEN 1 ELSE 0 END) AS won
     FROM conversations c JOIN accounts a ON a.id=c.account_id
     GROUP BY COALESCE(NULLIF(a.country_code,''),'UNKNOWN')
     ORDER BY conversations DESC LIMIT 20`,
  ).all<any>()

  const bySegment = await env.GROWTH_DB.prepare(
    `SELECT COALESCE(NULLIF(a.account_type,''),'unknown') AS dimension,
            COUNT(DISTINCT c.id) AS conversations,
            SUM(CASE WHEN c.inbound_count>0 THEN 1 ELSE 0 END) AS replies,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM commercial_outcomes co
              WHERE co.account_id=a.id AND co.outcome IN ('won','partner_agreed')
            ) THEN 1 ELSE 0 END) AS won
     FROM conversations c JOIN accounts a ON a.id=c.account_id
     GROUP BY COALESCE(NULLIF(a.account_type,''),'unknown')
     ORDER BY conversations DESC LIMIT 20`,
  ).all<any>()

  return {
    totals: totals || {},
    by_source: bySource.results || [],
    by_country: byCountry.results || [],
    by_segment: bySegment.results || [],
  }
}

export async function storeDailyFunnelSnapshot(env: Env) {
  const payload = await funnelSnapshot(env)
  const date = new Date().toISOString().slice(0,10)
  await env.GROWTH_DB.prepare(
    `INSERT INTO funnel_snapshots (snapshot_date,payload_json,created_at,updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(snapshot_date) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`,
  ).bind(date, JSON.stringify(payload), nowIso(), nowIso()).run()
  return payload
}
