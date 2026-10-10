import type { Account, Contact, Conversation, Env, ReplyClassification } from "./types"
import { apolloEnrichmentAttemptsToday, discoverApolloContactCandidates, enrichApolloCandidateEmail, type ApolloCandidateRow } from "./apollo"
import { aiJson, classifyReply } from "./ai"
import { canSendTo } from "./compliance"
import { audit, daysFromNow, getSetting, id, nowIso, setSetting } from "./db"
import { crawlPublicContacts, discoverNewsCandidates, discoverOfficialBankDirectories, enrichAccount } from "./discovery"
import { fetchReceivedEmail, recordOutbound, recordSimulation, sendInternalResend, sendResend } from "./email"
import { makeIntentToken, readIntentToken } from "./security"
import { discoverPartnerCandidates, discoverUkProcurement, processProcurementHandoffs } from "./opportunities"
import { currentNewOutreachCap, maybeAdjustRamp } from "./ramp"

function addHours(hours: number) {
  return new Date(Date.now() + hours * 3600_000).toISOString()
}

function approvedFacts(env: Env) {
  return (
    env.GIBP_APPROVED_FACTS ||
    "GIBP is a provider-neutral financial intent, policy, liquidity and execution layer designed for institutional value movement across banks, payment rails and digital money. Public information is available at https://www.gibp.global."
  )
}

async function accountFor(env: Env, idValue: string) {
  return env.GROWTH_DB.prepare("SELECT * FROM accounts WHERE id=?").bind(idValue).first<Account>()
}

async function contactFor(env: Env, idValue: string) {
  return env.GROWTH_DB.prepare("SELECT * FROM contacts WHERE id=?").bind(idValue).first<Contact>()
}

async function conversationFor(env: Env, idValue: string) {
  return env.GROWTH_DB.prepare("SELECT * FROM conversations WHERE id=?").bind(idValue).first<Conversation>()
}

async function shouldRunDiscovery(env: Env) {
  const last = await getSetting(env, "last_discovery_at")
  return !last || Date.now() - new Date(last).getTime() > 6 * 3600_000
}

async function shouldRunProcurement(env: Env) {
  const last = await getSetting(env, "last_procurement_at")
  return !last || Date.now() - new Date(last).getTime() > 3 * 3600_000
}

async function processResearch(env: Env) {
  const result = await env.GROWTH_DB.prepare(
    `SELECT a.*
     FROM accounts a
     LEFT JOIN jurisdiction_policies jp
       ON jp.country_code=upper(COALESCE(a.country_code,''))
     WHERE a.status IN ('candidate','research')
       AND (a.last_researched_at IS NULL OR a.last_researched_at < datetime('now','-3 day'))
     ORDER BY
       CASE
         WHEN jp.allowed=1 AND jp.requires_consent=0 AND jp.allow_corporate_b2b=1 THEN 0
         ELSE 1
       END,
       CASE WHEN a.domain IS NOT NULL AND a.domain!='' THEN 0 ELSE 1 END,
       a.score DESC,
       a.created_at ASC
     LIMIT 2`,
  ).all<Account>()

  for (const account of result.results || []) {
    await enrichAccount(env, account)
  }
  return result.results?.length || 0
}

async function processContactDiscovery(env: Env) {
  const now = nowIso()
  const lockUntil = addHours(0.25)

  const account = await env.GROWTH_DB.prepare(
    `UPDATE accounts
     SET next_action_at=?, updated_at=?
     WHERE id=(
       SELECT a.id
       FROM accounts a
       JOIN jurisdiction_policies jp
         ON jp.country_code=upper(COALESCE(a.country_code,''))
       WHERE a.domain IS NOT NULL
         AND a.domain != ''
         AND a.status IN ('qualified','candidate','monitor','research')
         AND jp.allowed=1
         AND jp.requires_consent=0
         AND jp.allow_corporate_b2b=1
         AND (a.next_action_at IS NULL OR a.next_action_at <= ?)
         AND NOT EXISTS (
           SELECT 1
           FROM contacts ct
           WHERE ct.account_id=a.id
             AND ct.status='active'
             AND ct.name IS NOT NULL
             AND length(trim(ct.name)) > 0
         )
         AND NOT EXISTS (
           SELECT 1
           FROM audit_events ae
           WHERE ae.category='contacts'
             AND ae.action='public_scan_v3'
             AND ae.entity_id=a.id
             AND ae.created_at >= datetime('now','-7 day')
         )
       ORDER BY
         CASE
           WHEN a.source='fdic_bankfind' AND a.fit_score BETWEEN 82 AND 90 THEN 0
           WHEN a.status='qualified' THEN 1
           WHEN a.source='fdic_bankfind' THEN 2
           ELSE 3
         END,
         a.score DESC,
         a.updated_at ASC
       LIMIT 1
     )
     RETURNING *`,
  )
    .bind(lockUntil, now, now)
    .first<Account>()

  if (!account?.domain) return { scanned: 0, contacts: 0 }

  try {
    const contacts = await crawlPublicContacts(
      env,
      account.id,
      account.domain,
      account.country_code,
    )
    return {
      scanned: 1,
      contacts,
      account_id: account.id,
      domain: account.domain,
    }
  } finally {
    await env.GROWTH_DB.prepare(
      "UPDATE accounts SET next_action_at=NULL, updated_at=? WHERE id=?",
    )
      .bind(nowIso(), account.id)
      .run()
  }
}

async function processApolloCandidateDiscovery(env: Env) {
  if (!env.APOLLO_API_KEY) {
    return { searched: 0, stored: 0, skipped: true, reason: "apollo_not_configured" }
  }

  const limit = Math.max(
    1,
    Math.min(10, Number(env.APOLLO_CANDIDATE_SEARCHES_PER_HOUR || 3)),
  )

  const result = await env.GROWTH_DB.prepare(
    `SELECT a.*
     FROM accounts a
     JOIN jurisdiction_policies jp
       ON jp.country_code=upper(COALESCE(a.country_code,''))
     WHERE a.domain IS NOT NULL
       AND a.domain != ''
       AND a.status IN ('qualified','candidate','monitor','research')
       AND jp.allowed=1
       AND jp.requires_consent=0
       AND jp.allow_corporate_b2b=1
       AND NOT EXISTS (
         SELECT 1
         FROM contacts ct
         WHERE ct.account_id=a.id
           AND ct.status='active'
           AND ct.name IS NOT NULL
           AND length(trim(ct.name)) > 0
       )
       AND NOT EXISTS (
         SELECT 1
         FROM audit_events ae
         WHERE ae.category='contacts'
           AND ae.action='apollo_candidate_search'
           AND ae.entity_id=a.id
           AND ae.created_at >= datetime('now','-7 day')
       )
     ORDER BY
       CASE
         WHEN a.status='qualified' THEN 0
         WHEN a.source='fdic_bankfind' AND a.fit_score BETWEEN 82 AND 90 THEN 1
         WHEN a.source='fdic_bankfind' THEN 2
         ELSE 3
       END,
       a.score DESC,
       a.updated_at ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<Account>()

  let searched = 0
  let stored = 0
  const accounts: Array<{ id: string; domain: string; stored: number }> = []

  for (const account of result.results || []) {
    if (!account.domain) continue
    const outcome = await discoverApolloContactCandidates(env, account)
    searched += Number(outcome.searched || 0)
    stored += Number(outcome.stored || 0)
    accounts.push({
      id: account.id,
      domain: account.domain,
      stored: Number(outcome.stored || 0),
    })
  }

  return { searched, stored, accounts }
}

async function processApolloEnrichment(env: Env) {
  const dailyCap = Math.max(
    0,
    Math.min(3, Number(env.APOLLO_ENRICHMENT_DAILY_CAP || 0)),
  )
  if (dailyCap <= 0) {
    return { attempted: 0, enriched: 0, skipped: true, reason: "enrichment_disabled" }
  }
  if (!env.APOLLO_API_KEY) {
    return { attempted: 0, enriched: 0, skipped: true, reason: "apollo_not_configured" }
  }

  const attemptsToday = await apolloEnrichmentAttemptsToday(env)
  if (attemptsToday >= dailyCap) {
    return {
      attempted: 0,
      enriched: 0,
      skipped: true,
      reason: "daily_enrichment_cap",
      attempts_today: attemptsToday,
      daily_cap: dailyCap,
    }
  }

  const row = await env.GROWTH_DB.prepare(
    `SELECT
       cc.id,
       cc.account_id,
       cc.provider_person_id,
       cc.first_name,
       cc.last_name_display,
       cc.title,
       cc.organization_name,
       cc.score,
       cc.metadata_json,
       a.name AS account_name,
       a.legal_name,
       a.domain,
       a.country_code,
       a.account_type,
       a.pipeline,
       a.status,
       a.score AS account_score,
       a.fit_score,
       a.signal_score,
       a.engagement_score,
       a.risk_score,
       a.source,
       a.source_url,
       a.research_json,
       a.last_researched_at,
       a.next_action_at,
       a.created_at,
       a.updated_at
     FROM contact_candidates cc
     JOIN accounts a ON a.id=cc.account_id
     JOIN jurisdiction_policies jp
       ON jp.country_code=upper(COALESCE(a.country_code,''))
     WHERE cc.provider='apollo'
       AND cc.status='candidate'
       AND cc.score >= 90
       AND a.status='qualified'
       AND a.domain IS NOT NULL
       AND a.domain != ''
       AND jp.allowed=1
       AND jp.requires_consent=0
       AND jp.allow_corporate_b2b=1
       AND NOT EXISTS (
         SELECT 1
         FROM contacts ct
         WHERE ct.account_id=a.id
           AND ct.status='active'
           AND ct.name IS NOT NULL
           AND length(trim(ct.name)) > 0
       )
       AND NOT EXISTS (
         SELECT 1
         FROM audit_events ae
         WHERE ae.category='contacts'
           AND ae.action='apollo_enrichment_attempt'
           AND ae.entity_id=a.id
           AND ae.created_at >= datetime('now','-30 day')
       )
     ORDER BY
       cc.score DESC,
       a.score DESC,
       cc.created_at ASC
     LIMIT 1`,
  ).first<(ApolloCandidateRow & {
    account_name: string
    legal_name: string | null
    domain: string
    country_code: string | null
    account_type: string
    pipeline: string
    status: string
    account_score: number
    fit_score: number
    signal_score: number
    engagement_score: number
    risk_score: number
    source: string | null
    source_url: string | null
    research_json: string
    last_researched_at: string | null
    next_action_at: string | null
    created_at: string
    updated_at: string
  })>()

  if (!row) {
    return { attempted: 0, enriched: 0, skipped: true, reason: "no_eligible_candidate" }
  }

  const account: Account = {
    id: row.account_id,
    name: row.account_name,
    legal_name: row.legal_name,
    domain: row.domain,
    country_code: row.country_code,
    account_type: row.account_type,
    pipeline: row.pipeline,
    status: row.status,
    score: row.account_score,
    fit_score: row.fit_score,
    signal_score: row.signal_score,
    engagement_score: row.engagement_score,
    risk_score: row.risk_score,
    source: row.source,
    source_url: row.source_url,
    research_json: row.research_json,
    last_researched_at: row.last_researched_at,
    next_action_at: row.next_action_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }

  const candidate: ApolloCandidateRow = {
    id: row.id,
    account_id: row.account_id,
    provider_person_id: row.provider_person_id,
    first_name: row.first_name,
    last_name_display: row.last_name_display,
    title: row.title,
    organization_name: row.organization_name,
    score: row.score,
    metadata_json: row.metadata_json,
  }

  const outcome = await enrichApolloCandidateEmail(env, account, candidate)
  return {
    attempted: 1,
    enriched_contacts: outcome.enriched ? 1 : 0,
    account_id: account.id,
    candidate_id: candidate.id,
    ...outcome,
  }
}

async function ensureConversations(env: Env) {
  const result = await env.GROWTH_DB.prepare(
    `SELECT ct.id AS contact_id, a.id AS account_id, a.pipeline AS pipeline
     FROM contacts ct
     JOIN accounts a ON a.id=ct.account_id
     LEFT JOIN conversations c ON c.contact_id=ct.id AND c.state NOT IN ('closed','lost')
     WHERE c.id IS NULL
       AND ct.status='active'
       AND ct.name IS NOT NULL
       AND length(trim(ct.name)) > 0
       AND ct.verified=1
       AND ct.seniority_score >= 60
       AND a.status='qualified'
       AND a.score >= 55
     ORDER BY a.score DESC, ct.seniority_score DESC
     LIMIT 20`,
  ).all<{ contact_id: string; account_id: string; pipeline: string }>()

  for (const row of result.results || []) {
    const now = nowIso()
    await env.GROWTH_DB.prepare(
      `INSERT INTO conversations
        (id,account_id,contact_id,pipeline,state,score,next_action_at,created_at,updated_at)
       VALUES (?,?,?,?,'discovery',0,?,?,?)`,
    )
      .bind(id(), row.account_id, row.contact_id, row.pipeline || "direct", now, now, now)
      .run()
  }
  return result.results?.length || 0
}

async function makeOutreach(
  env: Env,
  account: Account,
  contact: Contact,
  conversation: Conversation,
  step: number,
) {
  const signals = await env.GROWTH_DB.prepare(
    "SELECT title,url,strength FROM signals WHERE account_id=? ORDER BY observed_at DESC LIMIT 3",
  )
    .bind(account.id)
    .all<{ title: string; url: string | null; strength: number }>()

  const facts = approvedFacts(env)
  const pipeline = account.pipeline || "direct"
  const objective =
    pipeline === "partner"
      ? "Explore a concrete referral, implementation, integration, distribution or joint-market partnership."
      : "Explore a relevant institutional GIBP use case without assuming a current project."

  const prompt = `Write a concise institutional B2B email for GIBP.
Return JSON only: {"subject":"...","text":"..."}.
Do not claim an existing relationship, customer, regulatory permission, guaranteed saving, specific integration or capability not in the approved facts.
Avoid hype. Use one evidence-based reason for reaching out. Maximum 140 words. End with a low-friction question.
Commercial objective: ${objective}
Pipeline: ${pipeline}
This is sequence step ${step} of maximum 3.

Approved GIBP facts:
${facts}

Organisation:
${account.name}
Type: ${account.account_type}
Country: ${account.country_code || "unknown"}
Research: ${account.research_json}
Signals: ${JSON.stringify(signals.results || [])}
Contact role/address: ${contact.role || ""} / ${contact.email}`

  const generated = await aiJson<{ subject: string; text: string }>(
    env,
    "You are GIBP's careful institutional commercial-development writer. Return JSON only.",
    prompt,
  )

  let copy: { subject: string; text: string }

  if (generated?.subject && generated.text) {
    copy = generated
  } else if (step === 1 && pipeline === "partner") {
    copy = {
      subject: `Potential GIBP partnership with ${account.name}`,
      text: `Hello,\n\nI’m reaching out from GIBP because ${account.name} appears relevant to the payments and financial-infrastructure ecosystem we are building around. GIBP is a provider-neutral financial intent, policy, liquidity and execution layer for institutional value movement across banks, payment rails and digital money.\n\nWould it be useful to compare where a referral, implementation, integration or joint-market relationship could make sense for your clients or platform?\n\nRegards,\nGIBP Commercial Desk`,
    }
  } else if (step === 1) {
    copy = {
      subject: `A possible fit for ${account.name}'s payments infrastructure`,
      text: `Hello,\n\nI’m reaching out from GIBP because ${account.name} appears relevant to the institutional payments work we focus on. GIBP is a provider-neutral financial intent, policy, liquidity and execution layer for institutional value movement across banks, payment rails and digital money.\n\nWould it be useful if I sent a short architecture overview showing where GIBP can sit alongside existing providers rather than replacing them?\n\nRegards,\nGIBP Commercial Desk`,
    }
  } else {
    copy = {
      subject: `Re: GIBP and ${account.name}`,
      text:
        step === 2
          ? "Hello,\n\nFollowing up in case the architecture overview would be useful. I can keep it focused on the areas most relevant to your current payments or treasury priorities.\n\nRegards,\nGIBP Commercial Desk"
          : "Hello,\n\nI’ll close the loop after this note. If institutional payment execution, policy or liquidity orchestration becomes relevant later, I’m happy to send the concise technical overview.\n\nRegards,\nGIBP Commercial Desk",
    }
  }

  const type = account.account_type.toLowerCase()
  const landingPath =
    pipeline === "partner"
      ? "/partners"
      : type.includes("bank")
        ? "/solutions/banks"
        : type.includes("payment")
          ? "/solutions/payment-companies"
          : type.includes("fintech")
            ? "/solutions/fintech-platforms"
            : type.includes("liquidity")
              ? "/solutions/liquidity-providers"
              : type.includes("settlement")
                ? "/solutions/settlement-networks"
                : type.includes("infrastructure")
                  ? "/solutions/market-infrastructure"
                  : "/solutions"

  const intentToken = await makeIntentToken(conversation.id, account.id, env)
  const overviewUrl = new URL(landingPath, env.GIBP_SITE_URL || "https://www.gibp.global")
  overviewUrl.searchParams.set("gi", intentToken)

  return {
    subject: copy.subject,
    text: `${copy.text.trim()}\n\nRelevant GIBP overview: ${overviewUrl.toString()}`,
  }
}

async function processDueConversations(env: Env) {
  const due = await env.GROWTH_DB.prepare(
    `SELECT * FROM conversations
     WHERE state IN ('discovery','engaged','nurture')
       AND next_action_at IS NOT NULL
       AND next_action_at <= ?
       AND human_handoff_at IS NULL
     ORDER BY score DESC, next_action_at ASC
     LIMIT 12`,
  )
    .bind(nowIso())
    .all<Conversation>()

  let sent = 0
  for (const conversation of due.results || []) {
    const account = await accountFor(env, conversation.account_id)
    const contact = await contactFor(env, conversation.contact_id)
    if (!account || !contact) continue

    const isInitial = conversation.outbound_count === 0
    const decision = await canSendTo(env, account, contact, isInitial)
    if (!decision.allowed) {
      await audit(env, "compliance", "send_blocked", "conversation", conversation.id, {
        reason: decision.reason,
      })
      const retry =
        /cap/.test(decision.reason) ? addHours(24) : daysFromNow(30)
      await env.GROWTH_DB.prepare(
        "UPDATE conversations SET next_action_at=?, updated_at=? WHERE id=?",
      )
        .bind(retry, nowIso(), conversation.id)
        .run()
      continue
    }

    if (conversation.outbound_count >= 3) {
      await env.GROWTH_DB.prepare(
        "UPDATE conversations SET state='nurture', next_action_at=?, updated_at=? WHERE id=?",
      )
        .bind(daysFromNow(30), nowIso(), conversation.id)
        .run()
      continue
    }

    const step = conversation.outbound_count + 1
    const copy = await makeOutreach(env, account, contact, conversation, step)
    const result = await sendResend(env, {
      to: contact.email,
      subject: copy.subject,
      text: copy.text,
      conversationId: conversation.id,
      classification: isInitial ? "initial" : `followup_${step}`,
    })
    const classification = isInitial ? "initial" : `followup_${step}`

    if (result.dry_run) {
      await recordSimulation(
        env,
        conversation.id,
        copy.subject,
        result.text,
        classification,
        { dry_run: true, step },
      )
      await env.GROWTH_DB.prepare(
        "UPDATE conversations SET next_action_at=?, updated_at=? WHERE id=?",
      )
        .bind(daysFromNow(1), nowIso(), conversation.id)
        .run()
      sent += 1
      continue
    }

    await recordOutbound(
      env,
      conversation.id,
      result.id,
      result.message_id,
      copy.subject,
      result.text,
      classification,
      { dry_run: false },
    )

    const next = step === 1 ? daysFromNow(4) : step === 2 ? daysFromNow(7) : daysFromNow(30)
    await env.GROWTH_DB.prepare(
      `UPDATE conversations
       SET outbound_count=outbound_count+1, message_count=message_count+1,
           state=CASE WHEN ? >= 3 THEN 'nurture' ELSE state END,
           next_action_at=?, updated_at=?
       WHERE id=?`,
    )
      .bind(step, next, nowIso(), conversation.id)
      .run()
    await env.GROWTH_DB.prepare(
      "UPDATE contacts SET last_contact_at=?, updated_at=? WHERE id=?",
    )
      .bind(nowIso(), nowIso(), contact.id)
      .run()
    sent += 1
  }
  return sent
}

async function createHandoff(
  env: Env,
  conversation: Conversation,
  classification: ReplyClassification,
) {
  const existing = await env.GROWTH_DB.prepare(
    "SELECT id FROM handoffs WHERE conversation_id=?",
  )
    .bind(conversation.id)
    .first()
  if (existing) return

  const account = await accountFor(env, conversation.account_id)
  const contact = await contactFor(env, conversation.contact_id)
  if (!account || !contact) return

  const messages = await env.GROWTH_DB.prepare(
    `SELECT direction,subject,text,classification,created_at
     FROM messages WHERE conversation_id=? ORDER BY created_at ASC LIMIT 30`,
  )
    .bind(conversation.id)
    .all()

  const briefing = {
    account: {
      name: account.name,
      legal_name: account.legal_name,
      domain: account.domain,
      country: account.country_code,
      type: account.account_type,
      account_score: account.score,
      research: JSON.parse(account.research_json || "{}"),
    },
    contact: {
      name: contact.name,
      role: contact.role,
      email: contact.email,
    },
    conversation_score: conversation.score + classification.score_delta,
    reason: classification.summary,
    intent: classification.intent,
    transcript: messages.results || [],
  }

  await env.GROWTH_DB.prepare(
    `INSERT INTO handoffs
      (id,conversation_id,account_id,contact_id,priority,reason,briefing_json,status,created_at)
     VALUES (?,?,?,?,?,?,?,'ready',?)`,
  )
    .bind(
      id(),
      conversation.id,
      account.id,
      contact.id,
      classification.intent === "meeting_request" ? "high" : "normal",
      classification.summary,
      JSON.stringify(briefing),
      nowIso(),
    )
    .run()

  await env.GROWTH_DB.prepare(
    `UPDATE conversations SET state='serious', human_handoff_at=?, next_action_at=NULL, updated_at=?
     WHERE id=?`,
  )
    .bind(nowIso(), nowIso(), conversation.id)
    .run()

  if (env.HANDOFF_TO) {
    const result = await sendInternalResend(env, {
      to: env.HANDOFF_TO,
      subject: `SERIOUS GIBP OPPORTUNITY — ${account.name}`,
      text: `A serious GIBP opportunity is ready.\n\nOrganisation: ${account.name}\nContact: ${contact.name || contact.email} ${contact.role ? `(${contact.role})` : ""}\nReason: ${classification.summary}\nIntent: ${classification.intent}\nConversation score: ${briefing.conversation_score}\n\nFull briefing:\n${JSON.stringify(briefing, null, 2)}`,
    })
    await audit(env, "handoff", "email_notification", "conversation", conversation.id, {
      provider_id: result.id,
    })
  }

  if (env.HANDOFF_WEBHOOK_URL) {
    await fetch(env.HANDOFF_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(briefing),
    }).catch(() => undefined)
  }

  await audit(env, "handoff", "created", "conversation", conversation.id, briefing)
}

async function autoReply(
  env: Env,
  conversation: Conversation,
  contact: Contact,
  classification: ReplyClassification,
  inboundSubject: string,
  inboundText: string,
  inboundMessageId?: string,
) {
  const facts = approvedFacts(env)
  const generated =
    (await aiJson<{ subject: string; text: string }>(
      env,
      `Write a safe B2B reply for GIBP. Return JSON only with subject and text.
Use ONLY approved facts. Never invent customers, pricing, contracts, security guarantees, regulatory status, integrations, SLAs, exclusivity or implementation dates.
If the question cannot be answered from approved facts, say the team can cover it in a discussion.
Maximum 170 words.`,
      `Approved facts:\n${facts}\n\nClassification:\n${JSON.stringify(classification)}\n\nInbound subject: ${inboundSubject}\nInbound:\n${inboundText.slice(0, 7000)}`,
    )) || {
      subject: inboundSubject.toLowerCase().startsWith("re:") ? inboundSubject : `Re: ${inboundSubject}`,
      text:
        classification.intent === "not_now"
          ? "Thank you for letting me know. I’ll leave this with you and won’t keep chasing. If the timing changes, I’m happy to pick it up then.\n\nRegards,\nGIBP Commercial Desk"
          : "Thank you for coming back to me. I can provide the relevant GIBP material and keep the discussion focused on your institutional requirements. If a question needs a commercial, legal or technical commitment, I’ll bring the appropriate person into the conversation.\n\nRegards,\nGIBP Commercial Desk",
    }

  const result = await sendResend(env, {
    to: contact.email,
    subject: generated.subject,
    text: generated.text,
    conversationId: conversation.id,
    classification: "auto_reply",
    headers: inboundMessageId
      ? { "In-Reply-To": inboundMessageId, References: inboundMessageId }
      : undefined,
  })
  await recordOutbound(
    env,
    conversation.id,
    result.id,
    result.message_id,
    generated.subject,
    result.text,
    "auto_reply",
    { dry_run: result.dry_run },
  )
  await env.GROWTH_DB.prepare(
    `UPDATE conversations SET outbound_count=outbound_count+1, message_count=message_count+1,
      state='engaged', next_action_at=?, updated_at=? WHERE id=?`,
  )
    .bind(daysFromNow(5), nowIso(), conversation.id)
    .run()
}

export async function handleInboundEmail(env: Env, emailId: string) {
  const received = await fetchReceivedEmail(env, emailId)
  const fromMatch = received.from.match(/<([^>]+)>/)?.[1] || received.from
  const email = fromMatch.trim().toLowerCase()
  const contact = await env.GROWTH_DB.prepare(
    "SELECT * FROM contacts WHERE lower(email)=lower(?)",
  )
    .bind(email)
    .first<Contact>()
  if (!contact) {
    await audit(env, "inbound", "unmatched_email", "email", emailId, { from: email })
    return { matched: false }
  }

  let conversation = await env.GROWTH_DB.prepare(
    `SELECT * FROM conversations WHERE contact_id=? AND state NOT IN ('closed','lost')
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(contact.id)
    .first<Conversation>()

  if (!conversation) {
    const convId = id()
    const now = nowIso()
    await env.GROWTH_DB.prepare(
      `INSERT INTO conversations
        (id,account_id,contact_id,state,score,next_action_at,created_at,updated_at)
       VALUES (?,?,?,'engaged',20,?,?,?)`,
    )
      .bind(convId, contact.account_id, contact.id, daysFromNow(3), now, now)
      .run()
    conversation = await conversationFor(env, convId)
  }
  if (!conversation) return { matched: false }

  const body = received.text || received.html?.replace(/<[^>]+>/g, " ") || ""
  const classification = await classifyReply(env, received.subject || "", body)

  await env.GROWTH_DB.prepare(
    `INSERT INTO messages
      (id,conversation_id,direction,provider_id,message_id,subject,text,classification,metadata_json,created_at)
     VALUES (?,?,'inbound',?,?,?,?,?,?,?)`,
  )
    .bind(
      id(),
      conversation.id,
      emailId,
      received.message_id || null,
      received.subject || "",
      body.slice(0, 20000),
      classification.intent,
      JSON.stringify(classification),
      nowIso(),
    )
    .run()

  const newScore = Math.max(0, Math.min(100, conversation.score + classification.score_delta))
  await env.GROWTH_DB.prepare(
    `UPDATE conversations SET score=?, inbound_count=inbound_count+1, message_count=message_count+1,
      state=?, updated_at=? WHERE id=?`,
  )
    .bind(newScore, newScore >= 35 ? "engaged" : conversation.state, nowIso(), conversation.id)
    .run()
  conversation.score = newScore

  if (classification.intent === "unsubscribe" || classification.intent === "negative") {
    if (classification.intent === "unsubscribe") {
      await env.GROWTH_DB.prepare(
        "INSERT OR REPLACE INTO suppressions (email,reason,source,created_at) VALUES (?,?,'reply',?)",
      )
        .bind(contact.email, "recipient_request", nowIso())
        .run()
    }
    if (classification.intent === "negative") {
      await env.GROWTH_DB.prepare(
        "UPDATE conversations SET state='closed', next_action_at=NULL, updated_at=? WHERE id=?",
      )
        .bind(nowIso(), conversation.id)
        .run()
    }
    return { matched: true, classification }
  }

  const threshold = Number(env.SERIOUS_THRESHOLD || 85)
  if (classification.serious || classification.requires_human || newScore >= threshold) {
    await createHandoff(env, conversation, classification)
    return { matched: true, classification, handoff: true }
  }

  if (classification.referral_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(classification.referral_email)) {
    const referralEmail = classification.referral_email.toLowerCase()
    await env.GROWTH_DB.prepare(
      `INSERT OR IGNORE INTO contacts
        (id,account_id,name,role,email,email_source,source_url,country_code,is_public,verified,seniority_score,consent_status,lawful_basis,status,created_at,updated_at)
       VALUES (?,?,?,?,?,'referral',?, ?,0,1,70,'implied','recipient_referral','active',?,?)`,
    )
      .bind(
        id(),
        contact.account_id,
        classification.referral_name || null,
        null,
        referralEmail,
        `resend:${emailId}`,
        contact.country_code,
        nowIso(),
        nowIso(),
      )
      .run()
  }

  if (classification.should_reply) {
    await autoReply(
      env,
      conversation,
      contact,
      classification,
      received.subject || "",
      body,
      received.message_id,
    )
  }

  return { matched: true, classification }
}

export async function handleResendEvent(env: Env, event: any) {
  const type = String(event?.type || "")
  const data = event?.data || {}

  if (type === "email.received" && data.email_id) {
    return handleInboundEmail(env, data.email_id)
  }

  if (type === "suppression.added") {
    const suppressedEmail = String(data.email || data.recipient || "").trim().toLowerCase()
    if (suppressedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(suppressedEmail)) {
      await env.GROWTH_DB.prepare(
        "INSERT OR REPLACE INTO suppressions (email,reason,source,created_at) VALUES (?,?,?,?)",
      )
        .bind(
          suppressedEmail,
          String(data.reason || "suppression.added"),
          "resend_webhook",
          nowIso(),
        )
        .run()
      await env.GROWTH_DB.prepare(
        "UPDATE contacts SET status='suppressed', updated_at=? WHERE lower(email)=lower(?)",
      )
        .bind(nowIso(), suppressedEmail)
        .run()
      await audit(env, "compliance", "provider_suppression", "contact", suppressedEmail, {
        reason: data.reason || null,
      })
      return { handled: true, suppression: true }
    }
  }

  const providerId = data.email_id
  if (!providerId) return { ignored: true }

  const message = await env.GROWTH_DB.prepare(
    "SELECT conversation_id FROM messages WHERE provider_id=? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(providerId)
    .first<{ conversation_id: string }>()
  if (!message) return { ignored: true }

  const conversation = await conversationFor(env, message.conversation_id)
  if (!conversation) return { ignored: true }

  if (type === "email.opened") {
    await env.GROWTH_DB.prepare(
      "UPDATE conversations SET score=MIN(100,score+3), updated_at=? WHERE id=?",
    )
      .bind(nowIso(), conversation.id)
      .run()
  } else if (type === "email.clicked") {
    await env.GROWTH_DB.prepare(
      "UPDATE conversations SET score=MIN(100,score+8), updated_at=? WHERE id=?",
    )
      .bind(nowIso(), conversation.id)
      .run()
  } else if (
    type === "email.bounced" ||
    type === "email.complained" ||
    type === "email.suppressed"
  ) {
    const contact = await contactFor(env, conversation.contact_id)
    if (contact) {
      await env.GROWTH_DB.prepare(
        "INSERT OR REPLACE INTO suppressions (email,reason,source,created_at) VALUES (?,?,?,?)",
      )
        .bind(contact.email, type, "resend_webhook", nowIso())
        .run()
      await env.GROWTH_DB.prepare(
        "UPDATE contacts SET status='suppressed', updated_at=? WHERE id=?",
      )
        .bind(nowIso(), contact.id)
        .run()
    }
    await env.GROWTH_DB.prepare(
      "UPDATE conversations SET state='closed', next_action_at=NULL, updated_at=? WHERE id=?",
    )
      .bind(nowIso(), conversation.id)
      .run()
  }
  return { handled: true }
}

export async function recordWebsiteIntent(
  env: Env,
  payload: any,
  options: { trusted?: boolean } = {},
) {
  const weightMap: Record<string, number> = {
    page_view: 2,
    solutions_view: 5,
    partner_view: 8,
    trust_view: 7,
    security_view: 7,
    regulatory_view: 8,
    whitepaper: 10,
    architecture: 12,
    contact: 20,
    meeting: 35,
  }

  const requestedType = String(payload.event_type || payload.event || "page_view")
  const eventType = Object.hasOwn(weightMap, requestedType) ? requestedType : "page_view"
  const baseWeight = weightMap[eventType]
  const weight = options.trusted
    ? Math.max(1, Math.min(50, Number(payload.weight || baseWeight)))
    : baseWeight

  let conversationId: string | null = null
  let contactId: string | null = null
  let accountId: string | null = null
  let attributed = false

  const intentToken = typeof payload.intent_token === "string" ? payload.intent_token : ""
  if (intentToken) {
    const claims = await readIntentToken(intentToken, env)
    if (claims) {
      const conversation = await env.GROWTH_DB.prepare(
        "SELECT id,account_id,contact_id FROM conversations WHERE id=? AND account_id=? LIMIT 1",
      )
        .bind(claims.c, claims.a)
        .first<{ id: string; account_id: string; contact_id: string }>()
      if (conversation) {
        conversationId = conversation.id
        accountId = conversation.account_id
        contactId = conversation.contact_id
        attributed = true
      }
    }
  }

  if (options.trusted && !attributed) {
    conversationId = payload.conversation_id || null
    contactId = payload.contact_id || null
    accountId = payload.account_id || null

    if (!accountId && payload.account_domain) {
      const account = await env.GROWTH_DB.prepare(
        "SELECT id FROM accounts WHERE lower(domain)=lower(?)",
      )
        .bind(String(payload.account_domain).replace(/^www\./, ""))
        .first<{ id: string }>()
      accountId = account?.id || null
    }
  }

  const metadata = payload.metadata && typeof payload.metadata === "object"
    ? {
        site: String(payload.metadata.site || "").slice(0, 80),
        source: String(payload.metadata.source || "").slice(0, 80),
      }
    : {}

  await env.GROWTH_DB.prepare(
    `INSERT INTO website_intent
      (id,account_id,contact_id,conversation_id,event_type,path,weight,metadata_json,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id(),
      accountId,
      contactId,
      conversationId,
      eventType,
      String(payload.path || "").slice(0, 500) || null,
      weight,
      JSON.stringify({ ...metadata, attributed }),
      nowIso(),
    )
    .run()

  if (conversationId) {
    await env.GROWTH_DB.prepare(
      "UPDATE conversations SET score=MIN(100,score+?), updated_at=? WHERE id=?",
    )
      .bind(weight, nowIso(), conversationId)
      .run()
  }
  if (accountId) {
    await env.GROWTH_DB.prepare(
      "UPDATE accounts SET engagement_score=MIN(100,engagement_score+?), score=MIN(100,score+?), updated_at=? WHERE id=?",
    )
      .bind(weight, Math.ceil(weight / 2), nowIso(), accountId)
      .run()
  }
  return { recorded: true, event_type: eventType, weight, attributed }
}

export async function importData(env: Env, body: any) {
  let accounts = 0
  let contacts = 0
  for (const item of body.accounts || []) {
    if (!item.name) continue
    const accountId = item.id || id()
    const now = nowIso()
    await env.GROWTH_DB.prepare(
      `INSERT INTO accounts
        (id,name,legal_name,domain,country_code,account_type,pipeline,status,source,source_url,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,'import',?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, legal_name=excluded.legal_name, domain=excluded.domain,
         country_code=excluded.country_code, account_type=excluded.account_type,
         pipeline=excluded.pipeline, updated_at=excluded.updated_at`,
    )
      .bind(
        accountId,
        item.name,
        item.legal_name || null,
        item.domain || null,
        item.country_code || null,
        item.account_type || "unknown",
        item.pipeline || "direct",
        item.status || "candidate",
        item.source_url || null,
        now,
        now,
      )
      .run()
    accounts += 1

    for (const contact of item.contacts || []) {
      if (!contact.email) continue
      await upsertImportedContact(env, accountId, contact, item.country_code)
      contacts += 1
    }
  }
  for (const contact of body.contacts || []) {
    if (!contact.email || !contact.account_id) continue
    await upsertImportedContact(env, contact.account_id, contact, contact.country_code)
    contacts += 1
  }
  return { accounts, contacts }
}

async function upsertImportedContact(env: Env, accountId: string, item: any, fallbackCountry?: string) {
  const now = nowIso()
  await env.GROWTH_DB.prepare(
    `INSERT INTO contacts
      (id,account_id,name,role,email,email_source,source_url,country_code,is_public,verified,seniority_score,
       consent_status,lawful_basis,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)
     ON CONFLICT(email) DO UPDATE SET
       account_id=excluded.account_id, name=COALESCE(excluded.name,contacts.name),
       role=COALESCE(excluded.role,contacts.role), source_url=COALESCE(excluded.source_url,contacts.source_url),
       country_code=COALESCE(excluded.country_code,contacts.country_code),
       is_public=MAX(contacts.is_public,excluded.is_public), verified=MAX(contacts.verified,excluded.verified),
       seniority_score=MAX(contacts.seniority_score,excluded.seniority_score),
       consent_status=CASE WHEN excluded.consent_status!='unknown' THEN excluded.consent_status ELSE contacts.consent_status END,
       lawful_basis=COALESCE(excluded.lawful_basis,contacts.lawful_basis), updated_at=excluded.updated_at`,
  )
    .bind(
      item.id || id(),
      accountId,
      item.name || null,
      item.role || null,
      String(item.email).toLowerCase(),
      item.email_source || "import",
      item.source_url || null,
      item.country_code || fallbackCountry || null,
      item.is_public ? 1 : 0,
      item.verified ? 1 : 0,
      Number(item.seniority_score || 50),
      item.consent_status || "unknown",
      item.lawful_basis || null,
      now,
      now,
    )
    .run()
}

async function cleanup(env: Env) {
  const days = Math.max(30, Number(env.RETENTION_DAYS || 365))
  await env.GROWTH_DB.prepare(
    `DELETE FROM audit_events WHERE created_at < datetime('now', ?)`,
  )
    .bind(`-${days} day`)
    .run()
  await env.GROWTH_DB.prepare(
    `DELETE FROM website_intent WHERE created_at < datetime('now', ?)`,
  )
    .bind(`-${days} day`)
    .run()
}

export async function runQueueJob(
  env: Env,
  kind: "directories" | "discovery" | "procurement" | "research" | "contacts" | "apollo_candidates" | "apollo_enrich" | "conversations" | "outreach" | "maintenance",
) {
  const started = nowIso()
  let result: Record<string, unknown>

  if (kind === "directories") {
    result = { directories: await discoverOfficialBankDirectories(env) }
  } else if (kind === "discovery") {
    if (!(await shouldRunDiscovery(env))) {
      result = { skipped: true, reason: "not_due" }
    } else {
      const direct = await discoverNewsCandidates(env)
      const partners = await discoverPartnerCandidates(env)
      await setSetting(env, "last_discovery_at", nowIso())
      result = { direct, partners }
    }
  } else if (kind === "procurement") {
    if (!(await shouldRunProcurement(env))) {
      result = {
        skipped: true,
        reason: "not_due",
        handoffs: await processProcurementHandoffs(env),
      }
    } else {
      const discovered = await discoverUkProcurement(env)
      await setSetting(env, "last_procurement_at", nowIso())
      const handoffs = await processProcurementHandoffs(env)
      result = { discovered, handoffs }
    }
  } else if (kind === "research") {
    result = { researched: await processResearch(env) }
  } else if (kind === "contacts") {
    result = await processContactDiscovery(env)
  } else if (kind === "apollo_candidates") {
    result = await processApolloCandidateDiscovery(env)
  } else if (kind === "apollo_enrich") {
    result = await processApolloEnrichment(env)
  } else if (kind === "conversations") {
    result = { conversations_created: await ensureConversations(env) }
  } else if (kind === "outreach") {
    result = { sent: await processDueConversations(env) }
  } else {
    result = {
      ramp: await maybeAdjustRamp(env),
    }
    const lastCleanup = await getSetting(env, "last_cleanup_at")
    if (!lastCleanup || Date.now() - new Date(lastCleanup).getTime() > 24 * 3600_000) {
      await cleanup(env)
      await setSetting(env, "last_cleanup_at", nowIso())
      result.cleanup = true
    }
  }

  await audit(env, "engine", "queue_job_complete", "job", kind, {
    started,
    finished: nowIso(),
    result,
  })
  return result
}

export async function runTick(env: Env) {
  const started = nowIso()
  const summary: Record<string, unknown> = { started }

  summary.directories = await runQueueJob(env, "directories")
  summary.discovery = await runQueueJob(env, "discovery")
  summary.procurement = await runQueueJob(env, "procurement")
  summary.research = await runQueueJob(env, "research")
  summary.contacts = await runQueueJob(env, "contacts")
  summary.apollo_candidates = await runQueueJob(env, "apollo_candidates")
  summary.apollo_enrich = await runQueueJob(env, "apollo_enrich")
  summary.conversations = await runQueueJob(env, "conversations")
  summary.outreach = await runQueueJob(env, "outreach")
  summary.maintenance = await runQueueJob(env, "maintenance")

  await setSetting(env, "last_tick_at", nowIso())
  await audit(env, "engine", "tick", "worker", "gibp-background-worker", summary)
  return summary
}

export async function metrics(env: Env) {
  const row = await env.GROWTH_DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM accounts) AS accounts,
      (SELECT COUNT(*) FROM accounts WHERE pipeline='partner') AS partner_accounts,
      (SELECT COUNT(*) FROM accounts WHERE status='qualified') AS qualified_accounts,
      (SELECT COUNT(*) FROM contact_candidates WHERE provider='apollo' AND status='candidate') AS apollo_contact_candidates,
      (SELECT COUNT(*) FROM contact_candidates WHERE provider='apollo' AND status='enriched') AS apollo_enriched_candidates,
      (SELECT COUNT(*) FROM contacts WHERE email_source='apollo_verified_work' AND status='active') AS apollo_enriched_contacts,
      (SELECT COUNT(*) FROM contacts WHERE status='active') AS active_contacts,
      (SELECT COUNT(*) FROM conversations WHERE state='engaged') AS engaged,
      (SELECT COUNT(*) FROM conversations WHERE state='serious') AS serious,
      (SELECT COUNT(*) FROM handoffs WHERE status='ready') AS ready_handoffs,
      (SELECT COUNT(*) FROM opportunities WHERE kind='rfp' AND status IN ('qualified','handoff')) AS qualified_rfps,
      (SELECT COUNT(*) FROM opportunity_handoffs WHERE status='ready') AS ready_procurement_handoffs,
      (SELECT COUNT(*) FROM messages WHERE direction='outbound' AND created_at >= datetime('now','start of day')) AS sent_today,
      (SELECT COUNT(*) FROM messages WHERE direction='inbound' AND created_at >= datetime('now','start of day')) AS replies_today`,
  ).first()

  return {
    ...(row || {}),
    new_outreach_cap: await currentNewOutreachCap(env),
  }
}
