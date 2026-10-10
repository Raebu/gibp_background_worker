import type { Contact, Env } from "./types"
import { audit, countToday, id, nowIso } from "./db"
import { isGenericRoleAddress } from "./compliance"

const QEV_VERIFY_URL = "https://api.quickemailverification.com/v1/verify"

export type QevResponse = {
  result?: string
  reason?: string
  disposable?: boolean | string
  accept_all?: boolean | string
  role?: boolean | string
  free?: boolean | string
  email?: string
  user?: string
  domain?: string
  mx_record?: string
  mx_domain?: string
  safe_to_send?: boolean | string
  did_you_mean?: string
  success?: boolean | string
  message?: string
}

function asBoolean(value: boolean | string | undefined) {
  return value === true || String(value || "").toLowerCase() === "true"
}

export function qevDailyCap(env: Env) {
  return Math.max(0, Math.min(100, Number(env.QEV_DAILY_CAP || 100)))
}

export function qevPerRun(env: Env) {
  return Math.max(1, Math.min(10, Number(env.QEV_VERIFICATIONS_PER_RUN || 5)))
}

export function qevSafeToSend(payload: QevResponse) {
  return (
    String(payload.result || "").toLowerCase() === "valid" &&
    asBoolean(payload.success) &&
    asBoolean(payload.safe_to_send) &&
    !asBoolean(payload.disposable) &&
    !asBoolean(payload.accept_all) &&
    !asBoolean(payload.role)
  )
}

type VerificationCandidate = Contact & {
  account_score: number
  account_status: string
}

async function storeVerification(
  env: Env,
  contact: VerificationCandidate,
  payload: QevResponse,
) {
  const safe = qevSafeToSend(payload)
  const result = String(payload.result || "unknown").toLowerCase()
  const now = nowIso()

  await env.GROWTH_DB.prepare(
    `INSERT INTO contact_email_verifications
      (id,contact_id,provider,result,reason,safe_to_send,disposable,accept_all,role,free,
       did_you_mean,mx_domain,success,attempt_count,verified_at,raw_json)
     VALUES (?,?, 'quickemailverification', ?,?,?,?,?,?,?,?,?,?,?,1,?,?)
     ON CONFLICT(contact_id,provider) DO UPDATE SET
       result=excluded.result,
       reason=excluded.reason,
       safe_to_send=excluded.safe_to_send,
       disposable=excluded.disposable,
       accept_all=excluded.accept_all,
       role=excluded.role,
       free=excluded.free,
       did_you_mean=excluded.did_you_mean,
       mx_domain=excluded.mx_domain,
       success=excluded.success,
       attempt_count=contact_email_verifications.attempt_count+1,
       verified_at=excluded.verified_at,
       raw_json=excluded.raw_json`,
  )
    .bind(
      id(),
      contact.id,
      result,
      String(payload.reason || ""),
      safe ? 1 : 0,
      asBoolean(payload.disposable) ? 1 : 0,
      asBoolean(payload.accept_all) ? 1 : 0,
      asBoolean(payload.role) ? 1 : 0,
      asBoolean(payload.free) ? 1 : 0,
      String(payload.did_you_mean || ""),
      String(payload.mx_domain || ""),
      asBoolean(payload.success) ? 1 : 0,
      now,
      JSON.stringify(payload),
    )
    .run()

  const definitiveUnsafe =
    result === "invalid" ||
    asBoolean(payload.disposable) ||
    asBoolean(payload.accept_all) ||
    asBoolean(payload.role)

  if (definitiveUnsafe && contact.status === "active") {
    await env.GROWTH_DB.prepare(
      "UPDATE contacts SET status='verification_blocked', updated_at=? WHERE id=? AND status='active'",
    )
      .bind(now, contact.id)
      .run()
  }

  await audit(env, "contacts", "qev_verification_result", "contact", contact.id, {
    result,
    reason: payload.reason || null,
    safe_to_send: safe,
    disposable: asBoolean(payload.disposable),
    accept_all: asBoolean(payload.accept_all),
    role: asBoolean(payload.role),
    free: asBoolean(payload.free),
    did_you_mean: payload.did_you_mean || null,
  })

  return { safe, result, definitive_unsafe: definitiveUnsafe }
}

export async function verifyContactEmails(env: Env) {
  if (!env.QUICKEMAILVERIFICATION_API_KEY) {
    return { requested: 0, verified: 0, safe: 0, blocked: 0, skipped: true, reason: "qev_not_configured" }
  }

  const dailyCap = qevDailyCap(env)
  const requestedToday = await countToday(
    env,
    `SELECT COUNT(*) AS total
     FROM audit_events
     WHERE category='contacts'
       AND action='qev_verification_request'
       AND created_at >= datetime('now','start of day')`,
  )

  if (requestedToday >= dailyCap) {
    return {
      requested: 0,
      verified: 0,
      safe: 0,
      blocked: 0,
      skipped: true,
      reason: "qev_daily_cap",
      daily_cap: dailyCap,
      requested_today: requestedToday,
    }
  }

  const limit = Math.min(qevPerRun(env), dailyCap - requestedToday)
  const candidates = await env.GROWTH_DB.prepare(
    `SELECT ct.*, a.score AS account_score, a.status AS account_status
     FROM contacts ct
     JOIN accounts a ON a.id=ct.account_id
     JOIN jurisdiction_policies jp
       ON jp.country_code=upper(COALESCE(ct.country_code,a.country_code,''))
     LEFT JOIN contact_email_verifications cev
       ON cev.contact_id=ct.id AND cev.provider='quickemailverification'
     WHERE ct.status IN ('active','research_only')
       AND ct.name IS NOT NULL
       AND length(trim(ct.name)) > 0
       AND ct.verified=1
       AND jp.allowed=1
       AND jp.requires_consent=0
       AND jp.allow_corporate_b2b=1
       AND (
         cev.id IS NULL
         OR (
           cev.result='unknown'
           AND cev.attempt_count < 2
           AND cev.verified_at < datetime('now','-1 day')
         )
         OR cev.verified_at < datetime('now','-30 day')
       )
     ORDER BY
       CASE WHEN ct.email_source='apollo_verified' THEN 0 ELSE 1 END,
       a.score DESC,
       ct.seniority_score DESC,
       ct.updated_at ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<VerificationCandidate>()

  let requested = 0
  let verified = 0
  let safe = 0
  let blocked = 0
  const results: Array<Record<string, unknown>> = []

  for (const contact of candidates.results || []) {
    if (isGenericRoleAddress(contact.email)) {
      continue
    }

    requested += 1
    await audit(env, "contacts", "qev_verification_request", "contact", contact.id, {
      email_source: contact.email_source,
      account_id: contact.account_id,
    })

    const url = new URL(QEV_VERIFY_URL)
    url.searchParams.set("email", contact.email)
    url.searchParams.set("apikey", env.QUICKEMAILVERIFICATION_API_KEY)

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(12_000),
      })

      if (!response.ok) {
        await audit(env, "contacts", "qev_verification_failed", "contact", contact.id, {
          status: response.status,
          account_id: contact.account_id,
        })
        results.push({ contact_id: contact.id, status: response.status, failed: true })
        continue
      }

      const payload = (await response.json()) as QevResponse
      const outcome = await storeVerification(env, contact, payload)
      verified += 1
      if (outcome.safe) safe += 1
      if (outcome.definitive_unsafe) blocked += 1
      results.push({
        contact_id: contact.id,
        result: outcome.result,
        safe_to_send: outcome.safe,
        blocked: outcome.definitive_unsafe,
      })
    } catch (error) {
      await audit(env, "contacts", "qev_verification_exception", "contact", contact.id, {
        account_id: contact.account_id,
        error: error instanceof Error ? error.message : "unknown",
      })
      results.push({ contact_id: contact.id, failed: true, reason: "exception" })
    }
  }

  return {
    requested,
    verified,
    safe,
    blocked,
    daily_cap: dailyCap,
    requested_today_before: requestedToday,
    results,
  }
}
