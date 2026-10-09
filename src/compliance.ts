import type { Account, Contact, Env } from "./types"
import { countToday } from "./db"
import { currentNewOutreachCap } from "./ramp"

const freeMailDomains = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
])

export interface ComplianceDecision {
  allowed: boolean
  reason: string
}

export async function canSendTo(
  env: Env,
  account: Account,
  contact: Contact,
  isInitial: boolean,
): Promise<ComplianceDecision> {
  if (contact.status !== "active") return { allowed: false, reason: "contact_inactive" }
  if (!contact.is_public && contact.consent_status !== "express") {
    return { allowed: false, reason: "email_not_public_or_consented" }
  }

  const domain = contact.email.split("@")[1]?.toLowerCase()
  if (!domain || freeMailDomains.has(domain)) {
    return { allowed: false, reason: "not_verified_corporate_email" }
  }

  const suppression = await env.GROWTH_DB.prepare(
    "SELECT email FROM suppressions WHERE lower(email)=lower(?)",
  )
    .bind(contact.email)
    .first()
  if (suppression) return { allowed: false, reason: "suppressed" }

  const country = (contact.country_code || account.country_code || "").toUpperCase()
  const policy = country
    ? await env.GROWTH_DB.prepare(
        "SELECT * FROM jurisdiction_policies WHERE country_code = ?",
      )
        .bind(country)
        .first<{
          allowed: number
          requires_consent: number
          allow_corporate_b2b: number
          max_initial_per_day: number
        }>()
    : null

  if (!policy) {
    return {
      allowed: false,
      reason: `jurisdiction_${env.DEFAULT_JURISDICTION_MODE || "monitor_only"}`,
    }
  }
  if (!policy.allowed) return { allowed: false, reason: "jurisdiction_blocked" }
  if (policy.requires_consent && contact.consent_status !== "express" && contact.consent_status !== "implied") {
    return { allowed: false, reason: "consent_required" }
  }
  if (!policy.allow_corporate_b2b && contact.consent_status === "unknown") {
    return { allowed: false, reason: "corporate_b2b_not_permitted" }
  }

  if (!env.BUSINESS_POSTAL_ADDRESS || !env.UNSUBSCRIBE_SECRET) {
    return { allowed: false, reason: "sender_compliance_configuration_incomplete" }
  }

  const dailyCap = Number(env.DAILY_SEND_CAP || 50)
  const sentToday = await countToday(
    env,
    `SELECT COUNT(*) AS total FROM messages
     WHERE direction='outbound' AND created_at >= datetime('now','start of day')`,
  )
  if (sentToday >= dailyCap) return { allowed: false, reason: "daily_send_cap" }

  if (isInitial) {
    const newCap = await currentNewOutreachCap(env)
    const newToday = await countToday(
      env,
      `SELECT COUNT(*) AS total FROM messages
       WHERE direction='outbound' AND classification='initial'
       AND created_at >= datetime('now','start of day')`,
    )
    if (newToday >= newCap) return { allowed: false, reason: "daily_new_outreach_cap" }

    const jurisdictionToday = await countToday(
      env,
      `SELECT COUNT(*) AS total
       FROM messages m
       JOIN conversations c ON c.id=m.conversation_id
       JOIN contacts ct ON ct.id=c.contact_id
       JOIN accounts a ON a.id=c.account_id
       WHERE m.direction='outbound' AND m.classification='initial'
       AND COALESCE(ct.country_code,a.country_code,'')=?
       AND m.created_at >= datetime('now','start of day')`,
      country,
    )
    if (policy.max_initial_per_day > 0 && jurisdictionToday >= policy.max_initial_per_day) {
      return { allowed: false, reason: "jurisdiction_daily_cap" }
    }
  }

  return { allowed: true, reason: "ok" }
}
