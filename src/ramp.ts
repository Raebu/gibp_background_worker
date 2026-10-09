import type { Env } from "./types"
import { audit, getSetting, setSetting } from "./db"

export interface RampStats {
  initialSent: number
  inboundReplies: number
  positiveReplies: number
  bounces: number
  complaints: number
}

export function computeNextRampCap(
  stats: RampStats,
  current: number,
  start: number,
  maximum: number,
) {
  const floor = Math.max(1, start)
  const ceiling = Math.max(floor, maximum)
  const cap = Math.max(floor, Math.min(ceiling, current))

  if (stats.initialSent < 20) return cap

  const bounceRate = stats.initialSent ? stats.bounces / stats.initialSent : 0
  const complaintRate = stats.initialSent ? stats.complaints / stats.initialSent : 0
  const positiveReplyRate = stats.initialSent ? stats.positiveReplies / stats.initialSent : 0

  if (stats.complaints > 0 || complaintRate >= 0.001 || bounceRate >= 0.03) {
    return Math.max(floor, cap - 5)
  }

  if (bounceRate < 0.02 && positiveReplyRate >= 0.02) {
    return Math.min(ceiling, cap + 5)
  }

  return cap
}

export async function currentNewOutreachCap(env: Env) {
  const start = Number(env.RAMP_START_CAP || 5)
  const maximum = Number(env.DAILY_NEW_OUTREACH_CAP || 20)
  const stored = Number((await getSetting(env, "outreach_ramp_cap")) || start)
  return Math.max(start, Math.min(maximum, stored))
}

async function sevenDayStats(env: Env): Promise<RampStats> {
  const sent = await env.GROWTH_DB.prepare(
    `SELECT COUNT(*) AS total
     FROM messages
     WHERE direction='outbound'
       AND classification='initial'
       AND created_at >= datetime('now','-7 day')`,
  ).first<{ total: number }>()

  const replies = await env.GROWTH_DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN classification IN
         ('positive','information_request','meeting_request','referral','commercial_terms','security_or_legal')
         THEN 1 ELSE 0 END) AS positive
     FROM messages
     WHERE direction='inbound'
       AND created_at >= datetime('now','-7 day')`,
  ).first<{ total: number; positive: number }>()

  const failures = await env.GROWTH_DB.prepare(
    `SELECT
       SUM(CASE WHEN reason='email.bounced' THEN 1 ELSE 0 END) AS bounces,
       SUM(CASE WHEN reason='email.complained' THEN 1 ELSE 0 END) AS complaints
     FROM suppressions
     WHERE source='resend_webhook'
       AND created_at >= datetime('now','-7 day')`,
  ).first<{ bounces: number; complaints: number }>()

  return {
    initialSent: Number(sent?.total || 0),
    inboundReplies: Number(replies?.total || 0),
    positiveReplies: Number(replies?.positive || 0),
    bounces: Number(failures?.bounces || 0),
    complaints: Number(failures?.complaints || 0),
  }
}

export async function maybeAdjustRamp(env: Env) {
  const last = await getSetting(env, "last_ramp_review_at")
  if (last && Date.now() - new Date(last).getTime() < 24 * 3600_000) {
    return {
      changed: false,
      cap: await currentNewOutreachCap(env),
      reason: "review_not_due",
    }
  }

  const start = Number(env.RAMP_START_CAP || 5)
  const maximum = Number(env.DAILY_NEW_OUTREACH_CAP || 20)
  const current = await currentNewOutreachCap(env)
  const stats = await sevenDayStats(env)
  const next = computeNextRampCap(stats, current, start, maximum)

  await setSetting(env, "outreach_ramp_cap", String(next))
  await setSetting(env, "last_ramp_review_at", new Date().toISOString())
  await audit(env, "reputation", "ramp_review", "sender", "gibp", {
    current,
    next,
    stats,
  })

  return {
    changed: next !== current,
    cap: next,
    previous_cap: current,
    stats,
  }
}
