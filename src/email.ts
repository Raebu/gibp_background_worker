import type { Env } from "./types"
import { id, nowIso } from "./db"
import { makeUnsubscribeToken } from "./security"

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export async function sendResend(
  env: Env,
  input: {
    to: string
    subject: string
    text: string
    conversationId?: string
    classification?: string
    replyTo?: string
    headers?: Record<string, string>
    includeComplianceFooter?: boolean
  },
) {
  const dryRun = (env.SEND_MODE || "dry_run") !== "live"
  let text = input.text.trim()

  if (input.includeComplianceFooter !== false) {
    const token = env.UNSUBSCRIBE_SECRET
      ? await makeUnsubscribeToken(input.to, env)
      : dryRun
        ? "DRY_RUN"
        : null

    if (!token) throw new Error("UNSUBSCRIBE_SECRET is required for live sending")

    const unsubscribe = `${env.PUBLIC_BASE_URL || "https://growth.gibp.global"}/unsubscribe?token=${encodeURIComponent(token)}`
    const postalAddress =
      env.BUSINESS_POSTAL_ADDRESS ||
      (dryRun ? "[postal address required before live sending]" : "")

    text += `\n\n—\nGIBP | ${postalAddress}\nYou are receiving this because we identified a potential institutional relevance to your organisation. Opt out: ${unsubscribe}`
  }

  if (dryRun) {
    return {
      id: `dry_run:${id()}`,
      message_id: null,
      text,
      dry_run: true,
    }
  }

  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is required for live sending")
  const outboundFrom = env.OUTBOUND_FROM_EMAIL || env.FROM_EMAIL
  if (!outboundFrom) throw new Error("OUTBOUND_FROM_EMAIL or FROM_EMAIL is required for live sending")

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: outboundFrom,
      to: [input.to],
      subject: input.subject,
      text,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.55;white-space:pre-wrap">${escapeHtml(text)}</div>`,
      reply_to: input.replyTo,
      headers: input.headers,
      tags: [
        { name: "system", value: "gibp-growth" },
        ...(input.conversationId
          ? [{ name: "conversation", value: input.conversationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) }]
          : []),
      ],
    }),
  })

  const data = (await response.json().catch(() => ({}))) as {
    id?: string
    message_id?: string
    message?: string
  }
  if (!response.ok || !data.id) {
    throw new Error(`Resend send failed (${response.status}): ${data.message || "unknown error"}`)
  }
  return { id: data.id, message_id: data.message_id || null, text, dry_run: false }
}

export async function fetchReceivedEmail(env: Env, emailId: string) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is required to retrieve inbound email")
  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
  })
  if (!response.ok) throw new Error(`Unable to retrieve inbound email: ${response.status}`)
  return (await response.json()) as {
    id: string
    from: string
    to: string[]
    subject: string
    text: string | null
    html: string | null
    headers?: Record<string, string>
    message_id?: string
  }
}

export async function recordOutbound(
  env: Env,
  conversationId: string,
  providerId: string,
  messageId: string | null,
  subject: string,
  text: string,
  classification: string,
  metadata: unknown = {},
) {
  await env.GROWTH_DB.prepare(
    `INSERT INTO messages
      (id, conversation_id, direction, provider_id, message_id, subject, text, classification, metadata_json, created_at)
     VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id(),
      conversationId,
      providerId,
      messageId,
      subject,
      text,
      classification,
      JSON.stringify(metadata),
      nowIso(),
    )
    .run()
}


export async function sendInternalResend(
  env: Env,
  input: { to: string; subject: string; text: string },
) {
  if (!env.HANDOFF_TO || input.to.toLowerCase() !== env.HANDOFF_TO.toLowerCase()) {
    throw new Error("Internal email recipient must match HANDOFF_TO")
  }
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is required for internal mail")
  const transactionalFrom = env.TRANSACTIONAL_FROM_EMAIL || env.FROM_EMAIL
  if (!transactionalFrom) throw new Error("TRANSACTIONAL_FROM_EMAIL or FROM_EMAIL is required for internal mail")

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: transactionalFrom,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.55;white-space:pre-wrap">${escapeHtml(input.text)}</div>`,
      tags: [{ name: "system", value: "gibp-internal-handoff" }],
    }),
  })

  const data = (await response.json().catch(() => ({}))) as {
    id?: string
    message?: string
  }
  if (!response.ok || !data.id) {
    throw new Error(`Resend internal send failed (${response.status}): ${data.message || "unknown error"}`)
  }
  return { id: data.id }
}


export async function recordSimulation(
  env: Env,
  conversationId: string,
  subject: string,
  text: string,
  classification: string,
  metadata: unknown = {},
) {
  await env.GROWTH_DB.prepare(
    `INSERT INTO messages
      (id, conversation_id, direction, provider_id, message_id, subject, text, classification, metadata_json, created_at)
     VALUES (?, ?, 'simulation', NULL, NULL, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id(),
      conversationId,
      subject,
      text,
      classification,
      JSON.stringify(metadata),
      nowIso(),
    )
    .run()
}
