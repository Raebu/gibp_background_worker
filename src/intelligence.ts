import type { Account, Conversation, Env, ReplyClassification } from "./types"
import { aiJson } from "./ai"
import { audit, id, nowIso } from "./db"

function clamp(value: unknown) {
  return Math.max(0, Math.min(100, Number(value || 0)))
}

function array(value: unknown) {
  return Array.isArray(value) ? value : []
}

function parse<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function clean(value: unknown, max = 2000) {
  const text = String(value || "").trim()
  return text ? text.slice(0, max) : null
}

async function syncStakeholders(env: Env, accountId: string) {
  const now = nowIso()
  const contacts = await env.GROWTH_DB.prepare(
    "SELECT id,name,role,email,seniority_score,status FROM contacts WHERE account_id=?",
  ).bind(accountId).all<any>()

  for (const contact of contacts.results || []) {
    await env.GROWTH_DB.prepare(
      `INSERT INTO account_stakeholders
       (id,account_id,contact_id,source,source_key,name,role,email,influence_score,status,metadata_json,created_at,updated_at)
       VALUES (?,?,?,'contact',?,?,?,?,?,?,'{}',?,?)
       ON CONFLICT(account_id,source,source_key) DO UPDATE SET
         contact_id=excluded.contact_id,name=excluded.name,role=excluded.role,email=excluded.email,
         influence_score=excluded.influence_score,status=excluded.status,updated_at=excluded.updated_at`,
    ).bind(
      id(), accountId, contact.id, contact.id, contact.name, contact.role, contact.email,
      clamp(contact.seniority_score), contact.status, now, now,
    ).run()
  }

  const candidates = await env.GROWTH_DB.prepare(
    `SELECT id,provider_person_id,first_name,last_name_display,title,score,status
     FROM contact_candidates WHERE account_id=? AND provider='apollo'`,
  ).bind(accountId).all<any>()

  for (const candidate of candidates.results || []) {
    const name = [candidate.first_name, candidate.last_name_display].filter(Boolean).join(" ").trim() || null
    await env.GROWTH_DB.prepare(
      `INSERT INTO account_stakeholders
       (id,account_id,contact_id,source,source_key,name,role,email,influence_score,status,metadata_json,created_at,updated_at)
       VALUES (?,?,NULL,'apollo_candidate',?,?,?,NULL,?,?,?, ?,?)
       ON CONFLICT(account_id,source,source_key) DO UPDATE SET
         name=excluded.name,role=excluded.role,influence_score=excluded.influence_score,
         status=excluded.status,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
    ).bind(
      id(), accountId, candidate.provider_person_id || candidate.id, name, candidate.title,
      clamp(candidate.score), candidate.status,
      JSON.stringify({ provider_person_id: candidate.provider_person_id }), now, now,
    ).run()
  }
}

export async function recordReferralStakeholder(
  env: Env,
  input: { account_id: string; contact_id?: string | null; email: string; name?: string | null; role?: string | null; source_key: string },
) {
  const now = nowIso()
  await env.GROWTH_DB.prepare(
    `INSERT INTO account_stakeholders
     (id,account_id,contact_id,source,source_key,name,role,email,influence_score,status,metadata_json,created_at,updated_at)
     VALUES (?,?,?,'referral',?,?,?,?,75,'introduced','{}',?,?)
     ON CONFLICT(account_id,source,source_key) DO UPDATE SET
       contact_id=COALESCE(excluded.contact_id,account_stakeholders.contact_id),
       name=COALESCE(excluded.name,account_stakeholders.name),
       role=COALESCE(excluded.role,account_stakeholders.role),
       email=excluded.email,status='introduced',updated_at=excluded.updated_at`,
  ).bind(
    id(), input.account_id, input.contact_id || null, input.source_key,
    input.name || null, input.role || null, input.email.toLowerCase(), now, now,
  ).run()
}

export async function promotePolicyEligibleContacts(env: Env) {
  const rows = await env.GROWTH_DB.prepare(
    `SELECT ct.id,ct.account_id
     FROM contacts ct
     JOIN accounts a ON a.id=ct.account_id
     JOIN jurisdiction_policies jp ON jp.country_code=upper(COALESCE(ct.country_code,a.country_code,''))
     WHERE ct.status='research_only'
       AND ct.email_source='apollo_verified'
       AND ct.verified=1
       AND ct.name IS NOT NULL
       AND length(trim(ct.name))>0
       AND jp.allowed=1
       AND jp.requires_consent=0
       AND jp.allow_corporate_b2b=1
       AND EXISTS (
         SELECT 1 FROM jurisdiction_policy_evidence pe
         WHERE pe.country_code=jp.country_code AND pe.review_due_at > datetime('now')
       )
       AND EXISTS (
         SELECT 1 FROM contact_email_verifications q
         WHERE q.contact_id=ct.id AND q.provider='quickemailverification'
           AND q.result='valid' AND q.safe_to_send=1 AND q.disposable=0
           AND q.accept_all=0 AND q.role=0
           AND q.verified_at >= datetime('now','-30 day')
       )
     ORDER BY ct.seniority_score DESC LIMIT 20`,
  ).all<{ id: string; account_id: string }>()

  for (const row of rows.results || []) {
    await env.GROWTH_DB.prepare(
      "UPDATE contacts SET status='active',lawful_basis='jurisdiction_policy_corporate_b2b',updated_at=? WHERE id=? AND status='research_only'",
    ).bind(nowIso(), row.id).run()
    await audit(env, "compliance", "research_contact_activated", "contact", row.id, {
      account_id: row.account_id,
      qev_required: true,
      basis: "jurisdiction_policy_corporate_b2b",
    })
  }
  return { activated: rows.results?.length || 0 }
}

export async function buildAccountDossiers(env: Env) {
  const limit = Math.max(1, Math.min(6, Number(env.DOSSIERS_PER_RUN || 2)))
  const rows = await env.GROWTH_DB.prepare(
    `SELECT a.* FROM accounts a
     LEFT JOIN account_dossiers d ON d.account_id=a.id
     WHERE a.status='qualified'
       AND (d.account_id IS NULL OR d.updated_at < datetime('now','-3 day')
            OR EXISTS (SELECT 1 FROM signals s WHERE s.account_id=a.id AND s.observed_at>d.updated_at))
     ORDER BY a.signal_score DESC,a.score DESC,a.updated_at ASC LIMIT ?`,
  ).bind(limit).all<Account>()

  let generated = 0
  for (const account of rows.results || []) {
    await syncStakeholders(env, account.id)
    const signals = await env.GROWTH_DB.prepare(
      "SELECT kind,title,url,source,observed_at,strength FROM signals WHERE account_id=? ORDER BY observed_at DESC,strength DESC LIMIT 12",
    ).bind(account.id).all<any>()
    const stakeholders = await env.GROWTH_DB.prepare(
      "SELECT name,role,email,source,influence_score,status FROM account_stakeholders WHERE account_id=? ORDER BY influence_score DESC,updated_at DESC LIMIT 15",
    ).bind(account.id).all<any>()
    const research = parse<Record<string, any>>(account.research_json, {})

    const fallback = {
      summary: `${account.name} is a qualified GIBP target with account score ${account.score}.`,
      current_initiatives: (signals.results || []).slice(0, 5).map((s: any) => String(s.title || "")),
      likely_problem: "Institutional payment, treasury, liquidity or execution complexity may merit further discovery.",
      likely_use_cases: array(research.analysis?.likely_use_cases).map(String),
      evidence: (signals.results || []).slice(0, 8).map((s: any) => ({ claim: s.title, source_url: s.url, source_title: s.source })),
      stakeholders: (stakeholders.results || []).slice(0, 8).map((s: any) => ({ name: s.name, role: s.role, rationale: `Identified via ${s.source}` })),
      recommended_offer: account.pipeline === "partner"
        ? "Partner-fit discussion covering referral, implementation, integration or joint-market options."
        : "A focused institutional payments architecture review tied to the strongest verified signal.",
      objections: [] as string[],
      next_best_action: "Validate the strongest current initiative with the most relevant senior stakeholder.",
      confidence: Math.round(Math.min(85, Math.max(35, account.score))),
    }

    const ai = await aiJson<any>(
      env,
      `You are GIBP's institutional account-research analyst. Return JSON only with summary, current_initiatives[], likely_problem, likely_use_cases[], evidence[], stakeholders[], recommended_offer, objections[], next_best_action and confidence 0-100. Use only supplied material. Never invent customers, projects, technologies, suppliers, budgets, regulatory status or relationships. Uncertain points must be hypotheses.`,
      JSON.stringify({
        account: { name: account.name, legal_name: account.legal_name, domain: account.domain, country: account.country_code, type: account.account_type, pipeline: account.pipeline, score: account.score },
        research,
        signals: signals.results || [],
        stakeholders: stakeholders.results || [],
      }).slice(0, 18000),
    )
    const dossier = { ...fallback, ...(ai || {}) }
    const now = nowIso()

    await env.GROWTH_DB.prepare(
      `INSERT INTO account_dossiers
       (account_id,summary,current_initiatives_json,likely_problem,likely_use_cases_json,evidence_json,
        stakeholder_map_json,recommended_offer,objections_json,next_best_action,confidence,generated_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(account_id) DO UPDATE SET
        summary=excluded.summary,current_initiatives_json=excluded.current_initiatives_json,
        likely_problem=excluded.likely_problem,likely_use_cases_json=excluded.likely_use_cases_json,
        evidence_json=excluded.evidence_json,stakeholder_map_json=excluded.stakeholder_map_json,
        recommended_offer=excluded.recommended_offer,objections_json=excluded.objections_json,
        next_best_action=excluded.next_best_action,confidence=excluded.confidence,
        generated_at=excluded.generated_at,updated_at=excluded.updated_at`,
    ).bind(
      account.id, clean(dossier.summary, 4000) || fallback.summary,
      JSON.stringify(array(dossier.current_initiatives).slice(0, 12)),
      clean(dossier.likely_problem, 2500),
      JSON.stringify(array(dossier.likely_use_cases).slice(0, 12)),
      JSON.stringify(array(dossier.evidence).slice(0, 15)),
      JSON.stringify(array(dossier.stakeholders).slice(0, 15)),
      clean(dossier.recommended_offer, 2500),
      JSON.stringify(array(dossier.objections).slice(0, 12)),
      clean(dossier.next_best_action, 2500), clamp(dossier.confidence), now, now,
    ).run()

    await audit(env, "research", "dossier_generated", "account", account.id, {
      confidence: clamp(dossier.confidence),
      signals: (signals.results || []).length,
      stakeholders: (stakeholders.results || []).length,
    })
    generated += 1
  }
  return { generated }
}

export async function getQualificationProfile(env: Env, conversationId: string) {
  return env.GROWTH_DB.prepare(
    "SELECT * FROM qualification_profiles WHERE conversation_id=?",
  ).bind(conversationId).first<any>()
}

export async function updateQualification(
  env: Env,
  conversation: Conversation,
  inboundText: string,
  classification: ReplyClassification,
) {
  const existing = await getQualificationProfile(env, conversation.id)
  const extracted = await aiJson<any>(
    env,
    `Extract B2B opportunity qualification facts from the recipient's message. Return JSON only with problem, architecture, objective, geography, scale_context, budget_context, timeline, decision_process, influence, stakeholders[]. Only populate a field when the message actually supports it. Do not infer budget, authority, technology, timeline or geography without evidence.`,
    JSON.stringify({ classification, message: inboundText.slice(0, 8000), previous: existing || null }),
  ) || {}

  const merged: Record<string, string | null> = {
    problem: clean(extracted.problem) || existing?.problem || null,
    architecture: clean(extracted.architecture) || existing?.architecture || null,
    objective: clean(extracted.objective) || existing?.objective || null,
    geography: clean(extracted.geography) || existing?.geography || null,
    scale_context: clean(extracted.scale_context) || existing?.scale_context || null,
    budget_context: clean(extracted.budget_context) || existing?.budget_context || null,
    timeline: clean(extracted.timeline) || existing?.timeline || null,
    decision_process: clean(extracted.decision_process) || existing?.decision_process || null,
    influence: clean(extracted.influence) || existing?.influence || null,
  }
  const entries = Object.entries(merged)
  const completeness = Math.round(entries.filter(([,v]) => Boolean(v)).length / entries.length * 100)
  const missing = entries.filter(([,v]) => !v).map(([k]) => k)
  const stakeholderMap = [...parse<any[]>(existing?.stakeholders_json, []), ...array(extracted.stakeholders)].slice(-20)

  await env.GROWTH_DB.prepare(
    `INSERT INTO qualification_profiles
     (conversation_id,problem,architecture,objective,geography,scale_context,budget_context,timeline,
      decision_process,influence,stakeholders_json,missing_json,completeness,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(conversation_id) DO UPDATE SET
      problem=excluded.problem,architecture=excluded.architecture,objective=excluded.objective,
      geography=excluded.geography,scale_context=excluded.scale_context,budget_context=excluded.budget_context,
      timeline=excluded.timeline,decision_process=excluded.decision_process,influence=excluded.influence,
      stakeholders_json=excluded.stakeholders_json,missing_json=excluded.missing_json,
      completeness=excluded.completeness,updated_at=excluded.updated_at`,
  ).bind(
    conversation.id, merged.problem, merged.architecture, merged.objective, merged.geography,
    merged.scale_context, merged.budget_context, merged.timeline, merged.decision_process,
    merged.influence, JSON.stringify(stakeholderMap), JSON.stringify(missing), completeness, nowIso(),
  ).run()

  await env.GROWTH_DB.prepare(
    "UPDATE conversations SET qualification_score=?,updated_at=? WHERE id=?",
  ).bind(completeness, nowIso(), conversation.id).run()

  return { ...merged, stakeholders: stakeholderMap, missing, completeness }
}
