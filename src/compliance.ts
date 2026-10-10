import type { Account, Contact, Env } from "./types"
import { countToday } from "./db"
import { currentNewOutreachCap } from "./ramp"

const genericMailboxPattern =
  /^(info|contact|hello|enquiries?|inquiries?|support|sales|commercial|office|admin|marketing|press|media|privacy|security|abuse|help|customerservice|customer\.service|partnerships?|alliances?|procurement|supplier|vendors?)\d*$/i

export function isGenericRoleAddress(email: string) {
  const local = email.split("@")[0]?.toLowerCase().replace(/[._+-]/g, "") || ""
  return !local || genericMailboxPattern.test(local)
}

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
  if (!contact.name?.trim()) return { allowed: false, reason: "named_decision_maker_required" }
  if (isGenericRoleAddress(contact.email)) return { allowed: false, reason: "generic_role_address_blocked" }
  const policyBasedCorporateB2b =
    contact.lawful_basis === "jurisdiction_policy_corporate_b2b"
  if (
    !contact.is_public &&
    !["express", "implied"].includes(contact.consent_status) &&
    !policyBasedCorporateB2b
  ) {
    return { allowed: false, reason: "email_not_public_or_consented" }
  }

  const domain = contact.email.split("@")[1]?.toLowerCase()
  if (!domain || freeMailDomains.has(domain) || !contact.verified) {
    return { allowed: false, reason: "not_verified_corporate_email" }
  }

  if ((env.SEND_MODE || "dry_run") === "live" && !env.QUICKEMAILVERIFICATION_API_KEY) {
    return { allowed: false, reason: "qev_not_configured" }
  }

  if (env.QUICKEMAILVERIFICATION_API_KEY) {
    const qev = await env.GROWTH_DB.prepare(
      `SELECT result,safe_to_send,disposable,accept_all,role,verified_at
       FROM contact_email_verifications
       WHERE contact_id=?
         AND provider='quickemailverification'
         AND verified_at >= datetime('now','-30 day')
       ORDER BY verified_at DESC
       LIMIT 1`,
    )
      .bind(contact.id)
      .first<{
        result: string
        safe_to_send: number
        disposable: number
        accept_all: number
        role: number
        verified_at: string
      }>()

    if (
      !qev ||
      qev.result !== "valid" ||
      !qev.safe_to_send ||
      qev.disposable ||
      qev.accept_all ||
      qev.role
    ) {
      return { allowed: false, reason: "qev_not_safe_to_send" }
    }
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
        `SELECT jp.*,pe.review_due_at,pe.source_url
         FROM jurisdiction_policies jp
         LEFT JOIN jurisdiction_policy_evidence pe ON pe.country_code=jp.country_code
         WHERE jp.country_code=?`,
      )
        .bind(country)
        .first<{
          allowed: number
          requires_consent: number
          allow_corporate_b2b: number
          max_initial_per_day: number
          review_due_at: string | null
          source_url: string | null
        }>()
    : null

  if (!policy) {
    return {
      allowed: false,
      reason: `jurisdiction_${env.DEFAULT_JURISDICTION_MODE || "monitor_only"}`,
    }
  }
  if (!policy.allowed) return { allowed: false, reason: "jurisdiction_blocked" }
  if (
    (env.SEND_MODE || "dry_run") === "live" &&
    (!policy.review_due_at || new Date(policy.review_due_at).getTime() <= Date.now())
  ) {
    return { allowed: false, reason: "jurisdiction_policy_review_required" }
  }
  if (policy.requires_consent && contact.consent_status !== "express" && contact.consent_status !== "implied") {
    return { allowed: false, reason: "consent_required" }
  }
  if (!policy.allow_corporate_b2b && contact.consent_status === "unknown") {
    return { allowed: false, reason: "corporate_b2b_not_permitted" }
  }

  if (
    (env.SEND_MODE || "dry_run") === "live" &&
    (!env.BUSINESS_POSTAL_ADDRESS || !env.UNSUBSCRIBE_SECRET)
  ) {
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
