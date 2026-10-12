import type { Env, GrowthJob } from "./types"
import { audit, getSetting, id, nowIso, setSetting } from "./db"
import { sendInternalResend } from "./email"

const DAY_MS = 24 * 3600_000

export async function outboundPauseState(env: Env) {
  const [paused, reason, source, pausedAt] = await Promise.all([
    getSetting(env, "outbound_paused"),
    getSetting(env, "outbound_pause_reason"),
    getSetting(env, "outbound_pause_source"),
    getSetting(env, "outbound_paused_at"),
  ])
  return {
    paused: paused === "true",
    reason: reason || null,
    source: source || null,
    paused_at: pausedAt || null,
  }
}

export async function setOutboundPaused(
  env: Env,
  paused: boolean,
  reason: string,
  source: "admin" | "automatic" = "admin",
) {
  await setSetting(env, "outbound_paused", paused ? "true" : "false")
  await setSetting(env, "outbound_pause_reason", paused ? reason.slice(0, 500) : "")
  await setSetting(env, "outbound_pause_source", paused ? source : "")
  await setSetting(env, "outbound_paused_at", paused ? nowIso() : "")
  await audit(env, "operations", paused ? "outbound_paused" : "outbound_resumed", "sender", "gibp", {
    reason,
    source,
  })
  return outboundPauseState(env)
}

export async function claimOutboundDispatch(
  env: Env,
  conversationId: string,
  classification: string,
  idempotencyKey: string,
) {
  const claimToken = id()
  const now = nowIso()
  const result = await env.GROWTH_DB.prepare(
    `INSERT INTO outbound_dispatches
      (id,conversation_id,idempotency_key,classification,status,claim_token,claimed_at)
     VALUES (?,?,?,?, 'claimed', ?,?)
     ON CONFLICT(idempotency_key) DO UPDATE SET
       status='claimed',
       claim_token=excluded.claim_token,
       claimed_at=excluded.claimed_at,
       failed_at=NULL,
       error=NULL
     WHERE outbound_dispatches.status='failed'`,
  ).bind(id(), conversationId, idempotencyKey, classification, claimToken, now).run()

  return {
    claimed: Number(result.meta?.changes || 0) > 0,
    claim_token: claimToken,
    idempotency_key: idempotencyKey,
  }
}

export async function markOutboundDispatchSent(
  env: Env,
  idempotencyKey: string,
  claimToken: string,
  providerId: string,
  messageId: string | null,
) {
  await env.GROWTH_DB.prepare(
    `UPDATE outbound_dispatches
     SET status='sent',provider_id=?,message_id=?,sent_at=?,error=NULL
     WHERE idempotency_key=? AND claim_token=? AND status='claimed'`,
  ).bind(providerId, messageId, nowIso(), idempotencyKey, claimToken).run()
}

export async function markOutboundDispatchFailed(
  env: Env,
  idempotencyKey: string,
  claimToken: string,
  error: unknown,
) {
  await env.GROWTH_DB.prepare(
    `UPDATE outbound_dispatches
     SET status='failed',failed_at=?,error=?
     WHERE idempotency_key=? AND claim_token=? AND status='claimed'`,
  ).bind(
    nowIso(),
    String(error instanceof Error ? error.message : error).slice(0, 2000),
    idempotencyKey,
    claimToken,
  ).run()
}

function webhookEventKey(event: any) {
  if (event?.id) return `event:${String(event.id)}`
  const type = String(event?.type || "")
  const data = event?.data || {}
  if (type === "email.received" && data.email_id) return `received:${String(data.email_id)}`
  if (type === "suppression.added" && (data.email || data.recipient)) {
    return `suppression:${String(data.email || data.recipient).toLowerCase()}:${String(data.reason || "")}`
  }
  return null
}

export async function claimWebhookEvent(env: Env, event: any) {
  const key = webhookEventKey(event)
  if (!key) return { claimed: true, event_key: null }

  const data = event?.data || {}
  const result = await env.GROWTH_DB.prepare(
    `INSERT OR IGNORE INTO webhook_events
      (event_key,event_type,provider_id,received_at,payload_json)
     VALUES (?,?,?,?,?)`,
  ).bind(
    key,
    String(event?.type || "unknown"),
    data.email_id ? String(data.email_id) : null,
    nowIso(),
    JSON.stringify(event).slice(0, 20000),
  ).run()

  return { claimed: Number(result.meta?.changes || 0) > 0, event_key: key }
}

export async function recordOperationsAlert(
  env: Env,
  input: {
    fingerprint: string
    severity: "info" | "warning" | "critical"
    kind: string
    detail: unknown
    notify?: boolean
  },
) {
  const existing = await env.GROWTH_DB.prepare(
    "SELECT last_seen_at,status FROM operations_alerts WHERE fingerprint=?",
  ).bind(input.fingerprint).first<{ last_seen_at: string; status: string }>()

  const now = nowIso()
  await env.GROWTH_DB.prepare(
    `INSERT INTO operations_alerts
      (id,fingerprint,severity,kind,status,detail_json,occurrences,first_seen_at,last_seen_at)
     VALUES (?,?,?,?, 'open', ?,1,?,?)
     ON CONFLICT(fingerprint) DO UPDATE SET
       severity=excluded.severity,
       kind=excluded.kind,
       status='open',
       detail_json=excluded.detail_json,
       occurrences=operations_alerts.occurrences+1,
       last_seen_at=excluded.last_seen_at,
       resolved_at=NULL`,
  ).bind(
    id(),
    input.fingerprint,
    input.severity,
    input.kind,
    JSON.stringify(input.detail),
    now,
    now,
  ).run()

  const notifyDue =
    input.notify !== false &&
    env.HANDOFF_TO &&
    (!existing || Date.now() - new Date(existing.last_seen_at).getTime() >= DAY_MS)

  if (notifyDue) {
    try {
      await sendInternalResend(env, {
        to: env.HANDOFF_TO!,
        subject: `GIBP operations alert: ${input.kind}`,
        text: `Severity: ${input.severity}\n\n${JSON.stringify(input.detail, null, 2)}\n\nOutbound state can be reviewed from the GIBP commercial dashboard.`,
        idempotencyKey: `ops-alert:${input.fingerprint}:${now.slice(0, 10)}`,
      })
    } catch (error) {
      await audit(env, "operations", "alert_notification_failed", "alert", input.fingerprint, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

export async function resolveOperationsAlert(env: Env, fingerprint: string) {
  await env.GROWTH_DB.prepare(
    "UPDATE operations_alerts SET status='resolved',resolved_at=? WHERE fingerprint=?",
  ).bind(nowIso(), fingerprint).run()
}

export async function recordDeadLetter(
  env: Env,
  job: GrowthJob,
  error: unknown,
  attempts: number,
) {
  const terminal = attempts >= 3
  await env.GROWTH_DB.prepare(
    `INSERT INTO dead_letters
      (id,job_kind,payload_json,error,attempts,status,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(
    id(),
    job.kind,
    JSON.stringify(job),
    String(error instanceof Error ? error.stack || error.message : error).slice(0, 5000),
    attempts,
    terminal ? "dead" : "retrying",
    nowIso(),
  ).run()

  if (terminal) {
    await recordOperationsAlert(env, {
      fingerprint: `dead-letter:${job.kind}`,
      severity: ["outreach", "nurture", "conversations", "email_verify"].includes(job.kind)
        ? "critical"
        : "warning",
      kind: "queue_dead_letter",
      detail: { job, attempts, error: error instanceof Error ? error.message : String(error) },
    })
  }
  return { terminal }
}

async function dnsJson(name: string, type: string) {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
    { headers: { Accept: "application/dns-json" } },
  )
  if (!response.ok) throw new Error(`dns_query_failed:${response.status}`)
  return await response.json() as { Answer?: Array<{ data?: string }> }
}

export async function runDeliverabilityChecks(env: Env) {
  const from = env.OUTBOUND_FROM_EMAIL || env.FROM_EMAIL || ""
  const address = from.match(/<([^>]+)>/)?.[1] || from
  const domain = address.split("@")[1]?.trim().toLowerCase() || "gibp.global"

  const checks: Array<{ kind: string; ok: boolean; detail: unknown }> = []
  try {
    const rootTxt = await dnsJson(domain, "TXT")
    const values = (rootTxt.Answer || []).map((x) => String(x.data || "").replaceAll('"', ""))
    checks.push({ kind: "spf", ok: values.some((x) => /v=spf1/i.test(x)), detail: values })
  } catch (error) {
    checks.push({ kind: "spf", ok: false, detail: { error: String(error) } })
  }

  try {
    const dmarc = await dnsJson(`_dmarc.${domain}`, "TXT")
    const values = (dmarc.Answer || []).map((x) => String(x.data || "").replaceAll('"', ""))
    checks.push({ kind: "dmarc", ok: values.some((x) => /v=DMARC1/i.test(x)), detail: values })
  } catch (error) {
    checks.push({ kind: "dmarc", ok: false, detail: { error: String(error) } })
  }

  try {
    const mx = await dnsJson(domain, "MX")
    const values = (mx.Answer || []).map((x) => String(x.data || ""))
    checks.push({ kind: "mx", ok: values.length > 0, detail: values })
  } catch (error) {
    checks.push({ kind: "mx", ok: false, detail: { error: String(error) } })
  }

  for (const check of checks) {
    await env.GROWTH_DB.prepare(
      `INSERT INTO deliverability_checks
        (id,domain,check_kind,status,detail_json,checked_at)
       VALUES (?,?,?,?,?,?)`,
    ).bind(
      id(),
      domain,
      check.kind,
      check.ok ? "healthy" : "degraded",
      JSON.stringify(check.detail),
      nowIso(),
    ).run()
  }

  const failed = checks.filter((x) => !x.ok)
  if (failed.length) {
    await recordOperationsAlert(env, {
      fingerprint: `deliverability:${domain}`,
      severity: "warning",
      kind: "deliverability_degraded",
      detail: { domain, failed: failed.map((x) => x.kind) },
    })
  } else {
    await resolveOperationsAlert(env, `deliverability:${domain}`)
  }

  return { domain, checks }
}

export async function evaluateReputationAndSafety(env: Env) {
  const stats = await env.GROWTH_DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM messages
       WHERE direction='outbound' AND created_at>=datetime('now','-1 day')) AS sent_24h,
      (SELECT COUNT(*) FROM suppressions
       WHERE source='resend_webhook' AND reason='email.bounced'
         AND created_at>=datetime('now','-1 day')) AS bounces_24h,
      (SELECT COUNT(*) FROM suppressions
       WHERE source='resend_webhook' AND reason='email.complained'
         AND created_at>=datetime('now','-1 day')) AS complaints_24h,
      (SELECT COUNT(*) FROM audit_events
       WHERE category='contacts' AND action='qev_verification_exception'
         AND created_at>=datetime('now','-1 day')) AS qev_exceptions_24h,
      (SELECT COUNT(*) FROM dead_letters
       WHERE status='dead' AND job_kind IN ('outreach','nurture','conversations','email_verify')
         AND created_at>=datetime('now','-1 day')) AS critical_dead_letters_24h`,
  ).first<any>()

  const sent = Number(stats?.sent_24h || 0)
  const bounces = Number(stats?.bounces_24h || 0)
  const complaints = Number(stats?.complaints_24h || 0)
  const qevExceptions = Number(stats?.qev_exceptions_24h || 0)
  const deadLetters = Number(stats?.critical_dead_letters_24h || 0)
  const bounceRate = sent ? bounces / sent : 0
  const dailyCap = Number(env.DAILY_SEND_CAP || 50)

  const reasons: string[] = []
  if (complaints >= 1) reasons.push("complaint_detected")
  if (sent >= 10 && bounces >= 2 && bounceRate >= 0.05) reasons.push("bounce_rate_high")
  if (qevExceptions >= 5) reasons.push("qev_degraded")
  if (deadLetters >= 2) reasons.push("critical_queue_failures")
  if (sent > dailyCap) reasons.push("daily_cap_exceeded")

  const state = await outboundPauseState(env)
  if (reasons.length && !state.paused) {
    await setOutboundPaused(env, true, reasons.join(","), "automatic")
    await recordOperationsAlert(env, {
      fingerprint: "reputation-circuit-breaker",
      severity: "critical",
      kind: "outbound_circuit_breaker",
      detail: { reasons, sent, bounces, complaints, bounce_rate: bounceRate, qev_exceptions: qevExceptions, dead_letters: deadLetters },
    })
  } else if (
    !reasons.length &&
    state.paused &&
    state.source === "automatic" &&
    state.paused_at &&
    Date.now() - new Date(state.paused_at).getTime() >= DAY_MS
  ) {
    await setOutboundPaused(env, false, "24h healthy recovery window completed", "automatic")
    await resolveOperationsAlert(env, "reputation-circuit-breaker")
  }

  return {
    ...(await outboundPauseState(env)),
    sent_24h: sent,
    bounces_24h: bounces,
    complaints_24h: complaints,
    bounce_rate: bounceRate,
    qev_exceptions_24h: qevExceptions,
    critical_dead_letters_24h: deadLetters,
    reasons,
  }
}

export async function maybeSendDailyCommercialReport(env: Env) {
  const now = new Date()
  const hour = Number(env.DAILY_REPORT_HOUR_UTC || 17)
  if (now.getUTCHours() < hour) return { sent: false, reason: "not_due" }
  const reportDate = now.toISOString().slice(0, 10)

  const existing = await env.GROWTH_DB.prepare(
    "SELECT status FROM daily_commercial_reports WHERE report_date=?",
  ).bind(reportDate).first<{ status: string }>()
  if (existing?.status === "sent") return { sent: false, reason: "already_sent" }

  const metrics = await env.GROWTH_DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM messages WHERE direction='outbound' AND created_at>=datetime('now','start of day')) AS outbound,
      (SELECT COUNT(*) FROM messages WHERE direction='outbound' AND classification='initial' AND created_at>=datetime('now','start of day')) AS initial_outbound,
      (SELECT COUNT(*) FROM messages WHERE direction='inbound' AND created_at>=datetime('now','start of day')) AS replies,
      (SELECT COUNT(*) FROM messages WHERE direction='inbound' AND classification IN ('positive','information_request','meeting_request','referral','commercial_terms','security_or_legal') AND created_at>=datetime('now','start of day')) AS positive_replies,
      (SELECT COUNT(*) FROM suppressions WHERE reason='email.bounced' AND created_at>=datetime('now','start of day')) AS bounces,
      (SELECT COUNT(*) FROM suppressions WHERE reason='email.complained' AND created_at>=datetime('now','start of day')) AS complaints,
      (SELECT COUNT(*) FROM meeting_requests WHERE status='scheduled' AND updated_at>=datetime('now','start of day')) AS meetings,
      (SELECT COUNT(*) FROM handoffs WHERE status='ready' AND created_at>=datetime('now','start of day')) AS handoffs,
      (SELECT COUNT(*) FROM commercial_outcomes WHERE outcome IN ('won','partner_agreed') AND created_at>=datetime('now','start of day')) AS wins,
      (SELECT COUNT(*) FROM audit_events WHERE category='compliance' AND action='send_blocked' AND created_at>=datetime('now','start of day')) AS blocked,
      (SELECT COUNT(*) FROM dead_letters WHERE status='dead' AND created_at>=datetime('now','start of day')) AS dead_letters`,
  ).first<any>()

  const pause = await outboundPauseState(env)
  const payload = { report_date: reportDate, ...metrics, outbound_pause: pause }

  if (!env.HANDOFF_TO) return { sent: false, reason: "handoff_not_configured", payload }

  await env.GROWTH_DB.prepare(
    `INSERT INTO daily_commercial_reports (report_date,payload_json,status,created_at,sent_at)
     VALUES (?,?,'pending',?,NULL)
     ON CONFLICT(report_date) DO UPDATE SET payload_json=excluded.payload_json,status='pending'`,
  ).bind(reportDate, JSON.stringify(payload), nowIso()).run()

  await sendInternalResend(env, {
    to: env.HANDOFF_TO,
    subject: `GIBP daily commercial report — ${reportDate}`,
    text: [
      `GIBP daily commercial report — ${reportDate}`,
      `Outbound: ${Number(metrics?.outbound || 0)} (${Number(metrics?.initial_outbound || 0)} new)`,
      `Replies: ${Number(metrics?.replies || 0)} (${Number(metrics?.positive_replies || 0)} positive)`,
      `Meetings: ${Number(metrics?.meetings || 0)} | Handoffs: ${Number(metrics?.handoffs || 0)} | Wins: ${Number(metrics?.wins || 0)}`,
      `Bounces: ${Number(metrics?.bounces || 0)} | Complaints: ${Number(metrics?.complaints || 0)} | Blocked by policy: ${Number(metrics?.blocked || 0)}`,
      `Dead letters: ${Number(metrics?.dead_letters || 0)}`,
      `Outbound paused: ${pause.paused ? "YES" : "no"}${pause.reason ? ` — ${pause.reason}` : ""}`,
    ].join("\n"),
    idempotencyKey: `daily-commercial-report:${reportDate}`,
  })

  await env.GROWTH_DB.prepare(
    "UPDATE daily_commercial_reports SET status='sent',sent_at=? WHERE report_date=?",
  ).bind(nowIso(), reportDate).run()

  return { sent: true, payload }
}

export async function recordConversionAttribution(
  env: Env,
  input: {
    sourceKey: string
    conversationId?: string | null
    accountId?: string | null
    stage: string
    source: string
    value?: number | null
    currency?: string | null
    metadata?: unknown
    occurredAt?: string
  },
) {
  await env.GROWTH_DB.prepare(
    `INSERT OR IGNORE INTO conversion_attribution
      (id,source_key,conversation_id,account_id,stage,source,value,currency,metadata_json,occurred_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id(),
    input.sourceKey,
    input.conversationId || null,
    input.accountId || null,
    input.stage.slice(0, 80),
    input.source.slice(0, 80),
    input.value ?? null,
    input.currency || null,
    JSON.stringify(input.metadata || {}),
    input.occurredAt || nowIso(),
  ).run()
}

export async function operationsSnapshot(env: Env) {
  const counts = await env.GROWTH_DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM operations_alerts WHERE status='open') AS open_alerts,
      (SELECT COUNT(*) FROM operations_alerts WHERE status='open' AND severity='critical') AS critical_alerts,
      (SELECT COUNT(*) FROM dead_letters WHERE status='dead') AS dead_letters,
      (SELECT COUNT(*) FROM outbound_dispatches WHERE status='claimed') AS ambiguous_dispatches,
      (SELECT COUNT(*) FROM webhook_events WHERE received_at>=datetime('now','-1 day')) AS webhook_events_24h`,
  ).first<any>()
  const latestDeliverability = await env.GROWTH_DB.prepare(
    `SELECT check_kind,status,checked_at
     FROM deliverability_checks
     WHERE checked_at >= datetime('now','-2 day')
     ORDER BY checked_at DESC LIMIT 6`,
  ).all<any>()
  return {
    pause: await outboundPauseState(env),
    ...counts,
    deliverability: latestDeliverability.results || [],
  }
}
