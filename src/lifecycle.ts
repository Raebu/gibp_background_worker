import type { Account, Contact, Conversation, Env } from "./types"
import { audit, daysFromNow, id, nowIso } from "./db"

const countryTimezones: Record<string, string> = {
  GB: "Europe/London",
  IE: "Europe/Dublin",
  FR: "Europe/Paris",
  DE: "Europe/Berlin",
  NL: "Europe/Amsterdam",
  BE: "Europe/Brussels",
  ES: "Europe/Madrid",
  IT: "Europe/Rome",
  CH: "Europe/Zurich",
  AT: "Europe/Vienna",
  SE: "Europe/Stockholm",
  NO: "Europe/Oslo",
  DK: "Europe/Copenhagen",
  FI: "Europe/Helsinki",
  PL: "Europe/Warsaw",
  PT: "Europe/Lisbon",
  US: "America/Chicago",
  CA: "America/Toronto",
  MX: "America/Mexico_City",
  BR: "America/Sao_Paulo",
  SG: "Asia/Singapore",
  HK: "Asia/Hong_Kong",
  JP: "Asia/Tokyo",
  IN: "Asia/Kolkata",
  AE: "Asia/Dubai",
  SA: "Asia/Riyadh",
  ZA: "Africa/Johannesburg",
  AU: "Australia/Sydney",
  NZ: "Pacific/Auckland",
}

function localParts(timezone: string, date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value || ""
  return {
    weekday: get("weekday"),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  }
}

function isWorkingLocal(parts: { weekday: string; hour: number; minute: number }) {
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false
  const minuteOfDay = parts.hour * 60 + parts.minute
  return minuteOfDay >= 9 * 60 + 15 && minuteOfDay <= 16 * 60 + 30
}

export function workingTimeDecision(
  contact: Pick<Contact, "timezone" | "country_code">,
  account: Pick<Account, "country_code">,
  nowMs = Date.now(),
) {
  const country = (contact.country_code || account.country_code || "").toUpperCase()
  const requestedTimezone = contact.timezone || countryTimezones[country] || "UTC"
  let timezone = requestedTimezone

  try {
    localParts(timezone, new Date(nowMs))
  } catch {
    timezone = "UTC"
  }

  const now = new Date(nowMs)
  if (isWorkingLocal(localParts(timezone, now))) {
    return { allowed: true, timezone, next_action_at: now.toISOString() }
  }

  for (let step = 1; step <= 8 * 48; step += 1) {
    const candidate = new Date(nowMs + step * 30 * 60_000)
    if (isWorkingLocal(localParts(timezone, candidate))) {
      return { allowed: false, timezone, next_action_at: candidate.toISOString() }
    }
  }

  return {
    allowed: false,
    timezone,
    next_action_at: new Date(nowMs + 24 * 3600_000).toISOString(),
  }
}

export async function refreshNurtureSchedules(env: Env) {
  const rows = await env.GROWTH_DB.prepare(
    `SELECT c.id
     FROM conversations c
     JOIN contacts ct ON ct.id=c.contact_id
     WHERE c.state='nurture'
       AND c.human_handoff_at IS NULL
       AND EXISTS (
         SELECT 1 FROM signals s
         WHERE s.account_id=c.account_id
           AND s.strength>=20
           AND s.observed_at > COALESCE(ct.last_contact_at,c.updated_at)
       )
       AND (c.next_action_at IS NULL OR c.next_action_at > datetime('now','+1 hour'))
     ORDER BY c.score DESC LIMIT 20`,
  ).all<{ id: string }>()

  for (const row of rows.results || []) {
    await env.GROWTH_DB.prepare(
      "UPDATE conversations SET next_action_at=?,updated_at=? WHERE id=?",
    ).bind(nowIso(), nowIso(), row.id).run()
  }
  return { nudged: rows.results?.length || 0 }
}

export async function prepareNurture(
  env: Env,
  conversation: Conversation,
  contact: Contact,
) {
  const minDays = Math.max(30, Number(env.NURTURE_MIN_DAYS || 45))
  const latestMessage = await env.GROWTH_DB.prepare(
    `SELECT created_at FROM messages
     WHERE conversation_id=? AND direction IN ('outbound','simulation')
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(conversation.id).first<{ created_at: string }>()

  if (latestMessage?.created_at) {
    const nextEligible = new Date(new Date(latestMessage.created_at).getTime() + minDays * 86400_000)
    if (nextEligible.getTime() > Date.now()) {
      return { due: false, next_action_at: nextEligible.toISOString(), reason: "minimum_interval" }
    }
  }

  const signal = await env.GROWTH_DB.prepare(
    `SELECT kind,title,url,strength,observed_at
     FROM signals
     WHERE account_id=?
       AND strength>=20
       AND observed_at > COALESCE(?,datetime('now','-180 day'))
     ORDER BY observed_at DESC,strength DESC LIMIT 1`,
  ).bind(conversation.account_id, contact.last_contact_at).first<any>()

  if (!signal) {
    return { due: false, next_action_at: daysFromNow(30), reason: "no_new_signal" }
  }
  return { due: true, signal }
}

export async function markNurtureSent(
  env: Env,
  conversationId: string,
  signalObservedAt: string | null,
) {
  await env.GROWTH_DB.prepare(
    `UPDATE conversations
     SET nurture_count=nurture_count+1,
         last_signal_at=COALESCE(?,last_signal_at),
         next_action_at=?,
         updated_at=?
     WHERE id=?`,
  ).bind(signalObservedAt, daysFromNow(60), nowIso(), conversationId).run()
}

export async function requestMeetingBooking(
  env: Env,
  conversation: Conversation,
  account: Account,
  contact: Contact,
  context: string,
) {
  const now = nowIso()
  const requestId = id()
  let status = env.BOOKING_URL ? "awaiting_recipient" : "needs_human"
  let bookingUrl = env.BOOKING_URL || null
  let scheduledAt: string | null = null
  let providerResponse: Record<string, unknown> = {}

  if (env.MEETING_BOOKING_WEBHOOK_URL) {
    try {
      const response = await fetch(env.MEETING_BOOKING_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.MEETING_BOOKING_SECRET
            ? { Authorization: `Bearer ${env.MEETING_BOOKING_SECRET}` }
            : {}),
        },
        body: JSON.stringify({
          request_id: requestId,
          conversation_id: conversation.id,
          account: {
            id: account.id,
            name: account.name,
            domain: account.domain,
            country_code: account.country_code,
          },
          contact: {
            id: contact.id,
            name: contact.name,
            email: contact.email,
            role: contact.role,
            timezone: contact.timezone,
          },
          context: context.slice(0, 5000),
          requested_duration_minutes: 45,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
      providerResponse = payload
      if (response.ok) {
        status = String(payload.status || "requested").slice(0, 80)
        bookingUrl = payload.booking_url ? String(payload.booking_url).slice(0, 1000) : bookingUrl
        scheduledAt = payload.scheduled_at ? String(payload.scheduled_at).slice(0, 100) : null
        if (scheduledAt) status = "scheduled"
      } else {
        status = "provider_error"
      }
    } catch (error) {
      status = "provider_error"
      providerResponse = { error: error instanceof Error ? error.message : "unknown" }
    }
  }

  await env.GROWTH_DB.prepare(
    `INSERT INTO meeting_requests
     (id,conversation_id,contact_id,account_id,status,booking_url,scheduled_at,provider_response_json,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    requestId, conversation.id, contact.id, account.id, status, bookingUrl,
    scheduledAt, JSON.stringify(providerResponse), now, now,
  ).run()

  await audit(env, "meeting", "booking_requested", "conversation", conversation.id, {
    request_id: requestId,
    status,
    scheduled_at: scheduledAt,
    booking_url: Boolean(bookingUrl),
    provider_configured: Boolean(env.MEETING_BOOKING_WEBHOOK_URL),
  })

  return { id: requestId, status, booking_url: bookingUrl, scheduled_at: scheduledAt }
}
