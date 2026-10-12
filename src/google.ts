import type { Env } from "./types"
import { audit, nowIso } from "./db"
import { recordConversionAttribution } from "./operations"
import { recordExperimentEvent } from "./experiments"

type BusyWindow = { start: string; end: string }
type MeetingSlot = { start: string; end: string; timezone: string; label: string }

function b64url(input: ArrayBuffer | Uint8Array | string) {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function fromB64url(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)))
}

export async function makeMeetingToken(env: Env, meetingId: string, expiresInHours = 168) {
  const secret = env.MEETING_BOOKING_SECRET || env.INTENT_SIGNING_SECRET
  if (!secret) throw new Error("meeting_signing_secret_missing")
  const payload = b64url(JSON.stringify({ m: meetingId, exp: Date.now() + expiresInHours * 3600_000 }))
  return `${payload}.${await hmac(secret, payload)}`
}

export async function readMeetingToken(env: Env, token: string, meetingId: string) {
  const secret = env.MEETING_BOOKING_SECRET || env.INTENT_SIGNING_SECRET
  if (!secret || !token.includes(".")) return false
  const [payload, signature] = token.split(".", 2)
  if ((await hmac(secret, payload)) !== signature) return false
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromB64url(payload)))
    return parsed?.m === meetingId && Number(parsed?.exp || 0) > Date.now()
  } catch {
    return false
  }
}

async function refreshGoogleToken(clientId?: string, clientSecret?: string, refreshToken?: string) {
  if (!clientId || !clientSecret || !refreshToken) throw new Error("google_oauth_not_configured")
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json().catch(() => ({})) as any
  if (!response.ok || !payload.access_token) {
    throw new Error(`google_token_refresh_failed:${response.status}`)
  }
  return String(payload.access_token)
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10)
}

function subtractDays(isoDate: string, days: number) {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return dateKey(d)
}

function threeDaysAgo() {
  return subtractDays(dateKey(new Date()), 3)
}

export function googleSearchConsoleConfigured(env: Env) {
  return Boolean(
    env.GSC_GOOGLE_CLIENT_ID &&
      env.GSC_GOOGLE_CLIENT_SECRET &&
      env.GSC_GOOGLE_REFRESH_TOKEN &&
      env.GSC_SITE_URL,
  )
}

export async function syncGoogleSearchDemand(env: Env) {
  if (!googleSearchConsoleConfigured(env)) return { skipped: true, reason: "not_configured" }

  const accessToken = await refreshGoogleToken(
    env.GSC_GOOGLE_CLIENT_ID,
    env.GSC_GOOGLE_CLIENT_SECRET,
    env.GSC_GOOGLE_REFRESH_TOKEN,
  )
  const endDate = threeDaysAgo()
  const days = Math.max(7, Math.min(90, Number(env.GSC_SYNC_DAYS || 28)))
  const startDate = subtractDays(endDate, days - 1)
  const siteUrl = String(env.GSC_SITE_URL)

  const response = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ["query", "page", "country"],
        rowLimit: 25000,
        dataState: "final",
      }),
      signal: AbortSignal.timeout(20_000),
    },
  )
  const payload = await response.json().catch(() => ({})) as any
  if (!response.ok) throw new Error(`gsc_query_failed:${response.status}`)

  const aggregated = new Map<string, {
    clicks: number
    impressions: number
    positionNumerator: number
    pageWeights: Map<string, number>
    countryWeights: Map<string, number>
  }>()

  for (const row of payload.rows || []) {
    const query = String(row.keys?.[0] || "").trim()
    if (!query) continue
    const page = String(row.keys?.[1] || "")
    const country = String(row.keys?.[2] || "").toUpperCase()
    const clicks = Number(row.clicks || 0)
    const impressions = Number(row.impressions || 0)
    const position = Number(row.position || 0)
    const current = aggregated.get(query) || {
      clicks: 0,
      impressions: 0,
      positionNumerator: 0,
      pageWeights: new Map(),
      countryWeights: new Map(),
    }
    current.clicks += clicks
    current.impressions += impressions
    current.positionNumerator += position * Math.max(1, impressions)
    if (page) current.pageWeights.set(page, (current.pageWeights.get(page) || 0) + Math.max(1, impressions))
    if (country) current.countryWeights.set(country, (current.countryWeights.get(country) || 0) + Math.max(1, impressions))
    aggregated.set(query, current)
  }

  const top = [...aggregated.entries()]
    .sort((a, b) => b[1].clicks - a[1].clicks || b[1].impressions - a[1].impressions)
    .slice(0, 2000)

  const now = nowIso()
  for (const [query, value] of top) {
    const topPage = [...value.pageWeights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
    const topCountry = [...value.countryWeights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
    let landingPath: string | null = null
    if (topPage) {
      try {
        landingPath = new URL(topPage).pathname
      } catch {
        landingPath = topPage.slice(0, 500)
      }
    }
    const averagePosition = value.positionNumerator / Math.max(1, value.impressions)

    await env.GROWTH_DB.prepare(
      `INSERT INTO search_demand
       (query,landing_path,clicks,impressions,average_position,country_code,source,last_seen_at,updated_at)
       VALUES (?,?,?,?,?,?,'google_search_console',?,?)
       ON CONFLICT(query) DO UPDATE SET
         landing_path=excluded.landing_path,
         clicks=excluded.clicks,
         impressions=excluded.impressions,
         average_position=excluded.average_position,
         country_code=excluded.country_code,
         source=excluded.source,
         last_seen_at=excluded.last_seen_at,
         updated_at=excluded.updated_at`,
    ).bind(
      query.slice(0, 500),
      landingPath,
      Math.round(value.clicks),
      Math.round(value.impressions),
      Number(averagePosition.toFixed(2)),
      topCountry,
      endDate,
      now,
    ).run()
  }

  await audit(env, "search", "gsc_sync", "site", siteUrl, {
    start_date: startDate,
    end_date: endDate,
    source_rows: (payload.rows || []).length,
    queries_stored: top.length,
  })

  return { synced: top.length, source_rows: (payload.rows || []).length, start_date: startDate, end_date: endDate }
}

export function googleCalendarConfigured(env: Env) {
  return Boolean(
    env.CALENDAR_GOOGLE_CLIENT_ID &&
      env.CALENDAR_GOOGLE_CLIENT_SECRET &&
      env.CALENDAR_GOOGLE_REFRESH_TOKEN &&
      env.GOOGLE_CALENDAR_ID,
  )
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value || ""
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: get("weekday"),
  }
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
) {
  const desired = Date.UTC(year, month - 1, day, hour, minute)
  let guess = desired
  for (let pass = 0; pass < 2; pass += 1) {
    const p = zonedParts(new Date(guess), timezone)
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    guess = desired - (represented - guess)
  }
  return new Date(guess)
}

function overlaps(start: number, end: number, busy: BusyWindow[]) {
  return busy.some((window) => {
    const busyStart = new Date(window.start).getTime()
    const busyEnd = new Date(window.end).getTime()
    return start < busyEnd && end > busyStart
  })
}

export function candidateMeetingSlots(
  busy: BusyWindow[],
  options: { nowMs?: number; timezone?: string; durationMinutes?: number; count?: number } = {},
) {
  const nowMs = options.nowMs ?? Date.now()
  const timezone = options.timezone || "Europe/London"
  const duration = Math.max(30, Math.min(90, options.durationMinutes || 45))
  const count = Math.max(1, Math.min(6, options.count || 3))
  const slots: MeetingSlot[] = []
  const searchStart = new Date(nowMs + 3 * 3600_000)

  for (let dayOffset = 0; dayOffset < 21 && slots.length < count; dayOffset += 1) {
    const probe = new Date(searchStart.getTime() + dayOffset * 86400_000)
    const local = zonedParts(probe, timezone)
    if (["Sat", "Sun"].includes(local.weekday)) continue

    for (const hour of [10, 11, 14, 15, 16]) {
      const start = zonedDateTimeToUtc(local.year, local.month, local.day, hour, 0, timezone)
      const end = new Date(start.getTime() + duration * 60_000)
      if (start.getTime() <= nowMs + 2 * 3600_000) continue
      if (overlaps(start.getTime(), end.getTime(), busy)) continue
      const label = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(start)
      slots.push({ start: start.toISOString(), end: end.toISOString(), timezone, label })
      if (slots.length >= count) break
    }
  }
  return slots
}

async function calendarBusy(env: Env, timeMin: string, timeMax: string) {
  const accessToken = await refreshGoogleToken(
    env.CALENDAR_GOOGLE_CLIENT_ID,
    env.CALENDAR_GOOGLE_CLIENT_SECRET,
    env.CALENDAR_GOOGLE_REFRESH_TOKEN,
  )
  const calendarId = String(env.GOOGLE_CALENDAR_ID)
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      timeZone: env.GOOGLE_CALENDAR_TIMEZONE || "Europe/London",
      items: [{ id: calendarId }],
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json().catch(() => ({})) as any
  if (!response.ok) throw new Error(`google_calendar_freebusy_failed:${response.status}`)
  return { accessToken, busy: (payload.calendars?.[calendarId]?.busy || []) as BusyWindow[] }
}

export async function prepareNativeGoogleMeeting(env: Env, meetingId: string) {
  if (!googleCalendarConfigured(env)) return null
  const timezone = env.GOOGLE_CALENDAR_TIMEZONE || "Europe/London"
  const timeMin = new Date(Date.now() + 2 * 3600_000).toISOString()
  const timeMax = new Date(Date.now() + 21 * 86400_000).toISOString()
  const { busy } = await calendarBusy(env, timeMin, timeMax)
  const slots = candidateMeetingSlots(busy, { timezone, durationMinutes: 45, count: 3 })
  if (!slots.length) return { status: "needs_human", slots: [] as MeetingSlot[] }

  const token = await makeMeetingToken(env, meetingId)
  const base = env.PUBLIC_BASE_URL || "https://growth.gibp.global"
  return {
    status: "awaiting_recipient",
    slots,
    booking_url: `${base}/meeting/${encodeURIComponent(meetingId)}?token=${encodeURIComponent(token)}`,
  }
}

export async function scheduleNativeGoogleMeeting(
  env: Env,
  meetingId: string,
  token: string,
  slotStart: string,
) {
  if (!(await readMeetingToken(env, token, meetingId))) throw new Error("invalid_or_expired_booking_token")
  if ((env.SEND_MODE || "dry_run") !== "live") throw new Error("calendar_booking_disabled_until_live_mode")
  if (!googleCalendarConfigured(env)) throw new Error("google_calendar_not_configured")

  const meeting = await env.GROWTH_DB.prepare(
    `SELECT mr.*,a.name AS account_name,ct.name AS contact_name,ct.email AS contact_email,ct.role AS contact_role
     FROM meeting_requests mr
     JOIN accounts a ON a.id=mr.account_id
     JOIN contacts ct ON ct.id=mr.contact_id
     WHERE mr.id=?`,
  ).bind(meetingId).first<any>()
  if (!meeting) throw new Error("meeting_not_found")
  if (meeting.status === "scheduled") {
    return { already_scheduled: true, scheduled_at: meeting.scheduled_at }
  }

  let provider: any = {}
  try { provider = JSON.parse(meeting.provider_response_json || "{}") } catch {}
  const slots: MeetingSlot[] = Array.isArray(provider.slots) ? provider.slots : []
  const selected = slots.find((slot) => slot.start === slotStart)
  if (!selected) throw new Error("slot_not_offered")

  const { accessToken, busy } = await calendarBusy(env, selected.start, selected.end)
  if (overlaps(new Date(selected.start).getTime(), new Date(selected.end).getTime(), busy)) {
    throw new Error("slot_no_longer_available")
  }

  const calendarId = String(env.GOOGLE_CALENDAR_ID)
  const requestId = crypto.randomUUID()
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: `GIBP × ${meeting.account_name} — institutional payments discussion`,
        description:
          "45-minute GIBP institutional payments discussion. Created automatically after the recipient selected an offered availability slot.",
        start: { dateTime: selected.start, timeZone: selected.timezone },
        end: { dateTime: selected.end, timeZone: selected.timezone },
        attendees: [{ email: meeting.contact_email, displayName: meeting.contact_name || undefined }],
        conferenceData: {
          createRequest: {
            requestId,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
        guestsCanModify: false,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  )
  const payload = await response.json().catch(() => ({})) as any
  if (!response.ok) throw new Error(`google_calendar_event_create_failed:${response.status}`)

  const updatedProvider = {
    ...provider,
    provider: "google_calendar",
    event_id: payload.id || null,
    event_url: payload.htmlLink || null,
    meet_url: payload.hangoutLink || null,
    selected_slot: selected,
  }
  await env.GROWTH_DB.prepare(
    `UPDATE meeting_requests
     SET status='scheduled',scheduled_at=?,provider_response_json=?,updated_at=?
     WHERE id=?`,
  ).bind(selected.start, JSON.stringify(updatedProvider), nowIso(), meetingId).run()

  await recordConversionAttribution(env, {
    sourceKey: `meeting:${meetingId}`,
    conversationId: meeting.conversation_id || null,
    accountId: meeting.account_id || null,
    stage: "meeting_booked",
    source: "google_calendar",
    metadata: {
      event_id: payload.id || null,
      meet_url: Boolean(payload.hangoutLink),
    },
    occurredAt: selected.start,
  })

  if (meeting.conversation_id) {
    await recordExperimentEvent(
      env,
      meeting.conversation_id,
      "meeting_booked",
      `meeting:${meetingId}:booked`,
    )
  }

  await audit(env, "meeting", "google_calendar_scheduled", "meeting_request", meetingId, {
    account_name: meeting.account_name,
    scheduled_at: selected.start,
    event_id: payload.id || null,
    meet_url: Boolean(payload.hangoutLink),
  })

  return {
    scheduled: true,
    scheduled_at: selected.start,
    event_url: payload.htmlLink || null,
    meet_url: payload.hangoutLink || null,
  }
}
