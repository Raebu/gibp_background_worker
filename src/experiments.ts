import type { Account, Contact, Conversation, Env } from "./types"
import { id, nowIso } from "./db"

async function bucket(seed: string, modulus: number) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  )
  const value = (digest[0] << 8) + digest[1]
  return value % Math.max(1, modulus)
}

export async function assignInitialExperiment(
  env: Env,
  account: Account,
  contact: Contact,
  conversation: Conversation,
) {
  let experiment = await env.GROWTH_DB.prepare(
    `SELECT * FROM experiments
     WHERE scope='initial_outreach' AND status='active'
     ORDER BY started_at DESC LIMIT 1`,
  ).first<any>()

  let fixedWinner: string | null = null
  if (!experiment) {
    experiment = await env.GROWTH_DB.prepare(
      `SELECT * FROM experiments
       WHERE scope='initial_outreach' AND status='completed' AND winner_variant_id IS NOT NULL
       ORDER BY ended_at DESC LIMIT 1`,
    ).first<any>()
    fixedWinner = experiment?.winner_variant_id || null
  }
  if (!experiment) return null

  const existing = await env.GROWTH_DB.prepare(
    `SELECT ea.id AS assignment_id,ev.variant_key,ev.config_json,ev.id AS variant_id
     FROM experiment_assignments ea
     JOIN experiment_variants ev ON ev.id=ea.variant_id
     WHERE ea.experiment_id=? AND ea.contact_id=?`,
  ).bind(experiment.id, contact.id).first<any>()
  if (existing) {
    return {
      experiment_id: experiment.id,
      assignment_id: existing.assignment_id,
      variant_id: existing.variant_id,
      variant_key: existing.variant_key,
      config: JSON.parse(existing.config_json || "{}"),
    }
  }

  const variants = await env.GROWTH_DB.prepare(
    `SELECT * FROM experiment_variants WHERE experiment_id=? ORDER BY variant_key`,
  ).bind(experiment.id).all<any>()
  if (!(variants.results || []).length) return null

  let chosen: any
  if (fixedWinner) {
    chosen = (variants.results || []).find((x: any) => x.id === fixedWinner)
  } else {
    const total = (variants.results || []).reduce((sum: number, x: any) => sum + Math.max(1, Number(x.weight || 1)), 0)
    let point = await bucket(`${experiment.id}:${contact.id}`, total)
    for (const variant of variants.results || []) {
      point -= Math.max(1, Number(variant.weight || 1))
      if (point < 0) {
        chosen = variant
        break
      }
    }
  }
  chosen ||= variants.results?.[0]
  if (!chosen) return null

  const assignmentId = id()
  await env.GROWTH_DB.prepare(
    `INSERT OR IGNORE INTO experiment_assignments
      (id,experiment_id,variant_id,account_id,contact_id,conversation_id,assigned_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(
    assignmentId,
    experiment.id,
    chosen.id,
    account.id,
    contact.id,
    conversation.id,
    nowIso(),
  ).run()

  const stored = await env.GROWTH_DB.prepare(
    `SELECT ea.id AS assignment_id,ev.variant_key,ev.config_json,ev.id AS variant_id
     FROM experiment_assignments ea
     JOIN experiment_variants ev ON ev.id=ea.variant_id
     WHERE ea.experiment_id=? AND ea.contact_id=?`,
  ).bind(experiment.id, contact.id).first<any>()

  return stored ? {
    experiment_id: experiment.id,
    assignment_id: stored.assignment_id,
    variant_id: stored.variant_id,
    variant_key: stored.variant_key,
    config: JSON.parse(stored.config_json || "{}"),
  } : null
}

export function applyInitialExperimentCopy(
  copy: { subject: string; text: string },
  account: Account,
  assignment: any,
) {
  if (!assignment || assignment.variant_key === "control") {
    return { ...copy, experiment: assignment || null }
  }

  if (assignment.variant_key === "priority") {
    const subject =
      account.pipeline === "partner"
        ? `Partnership priorities at ${account.name}`
        : `Institutional payments priorities at ${account.name}`
    const question =
      account.pipeline === "partner"
        ? "Would a short comparison of the partnership models and where each tends to fit be useful?"
        : "Would a short benchmark of the orchestration options and where GIBP may fit be useful?"

    const cleaned = copy.text
      .replace(/Would it be useful[^?]*\?/i, question)
      .replace(/Would it be useful to compare[^?]*\?/i, question)

    return {
      subject,
      text: cleaned === copy.text ? `${copy.text.trim()}\n\n${question}` : cleaned,
      experiment: assignment,
    }
  }

  return { ...copy, experiment: assignment }
}

export async function recordExperimentEvent(
  env: Env,
  conversationId: string,
  eventType: string,
  eventKey: string,
  value?: number | null,
) {
  const assignment = await env.GROWTH_DB.prepare(
    `SELECT id FROM experiment_assignments
     WHERE conversation_id=? ORDER BY assigned_at DESC LIMIT 1`,
  ).bind(conversationId).first<{ id: string }>()
  if (!assignment) return { recorded: false, reason: "no_assignment" }

  await env.GROWTH_DB.prepare(
    `INSERT OR IGNORE INTO experiment_events
      (id,assignment_id,event_key,event_type,value,occurred_at)
     VALUES (?,?,?,?,?,?)`,
  ).bind(id(), assignment.id, eventKey, eventType, value ?? null, nowIso()).run()
  return { recorded: true }
}

export async function evaluateExperiments(env: Env) {
  const experiments = await env.GROWTH_DB.prepare(
    "SELECT * FROM experiments WHERE status='active' ORDER BY started_at",
  ).all<any>()
  const results: any[] = []

  for (const experiment of experiments.results || []) {
    const rows = await env.GROWTH_DB.prepare(
      `SELECT ev.id AS variant_id,ev.variant_key,
              COUNT(DISTINCT ea.id) AS samples,
              COUNT(DISTINCT CASE WHEN ee.event_type='positive_reply' THEN ea.id END) AS positive,
              COUNT(DISTINCT CASE WHEN ee.event_type='meeting_booked' THEN ea.id END) AS meetings,
              COUNT(DISTINCT CASE WHEN ee.event_type='won' THEN ea.id END) AS won
       FROM experiment_variants ev
       LEFT JOIN experiment_assignments ea ON ea.variant_id=ev.id
       LEFT JOIN experiment_events ee ON ee.assignment_id=ea.id
       WHERE ev.experiment_id=?
       GROUP BY ev.id,ev.variant_key
       ORDER BY ev.variant_key`,
    ).bind(experiment.id).all<any>()

    const stats = (rows.results || []).map((row: any) => ({
      ...row,
      samples: Number(row.samples || 0),
      positive: Number(row.positive || 0),
      meetings: Number(row.meetings || 0),
      won: Number(row.won || 0),
      positive_rate: Number(row.samples || 0) ? Number(row.positive || 0) / Number(row.samples || 0) : 0,
    }))

    const minSamples = Math.max(20, Number(experiment.min_samples_per_variant || 50))
    const ready = stats.length >= 2 && stats.every((x: any) => x.samples >= minSamples)
    if (ready) {
      const ranked = [...stats].sort((a: any,b: any) =>
        b.positive_rate - a.positive_rate || b.meetings - a.meetings || b.won - a.won,
      )
      if (ranked[0].positive_rate - ranked[1].positive_rate >= 0.05) {
        await env.GROWTH_DB.prepare(
          `UPDATE experiments
           SET status='completed',winner_variant_id=?,ended_at=?,updated_at=?
           WHERE id=? AND status='active'`,
        ).bind(ranked[0].variant_id, nowIso(), nowIso(), experiment.id).run()
      }
    }

    results.push({ experiment_id: experiment.id, name: experiment.name, ready, stats })
  }
  return { experiments: results }
}

export async function experimentSnapshot(env: Env) {
  const experiments = await env.GROWTH_DB.prepare(
    `SELECT e.*,ev.variant_key AS winner_variant_key
     FROM experiments e
     LEFT JOIN experiment_variants ev ON ev.id=e.winner_variant_id
     ORDER BY e.created_at DESC`,
  ).all<any>()

  const stats = await env.GROWTH_DB.prepare(
    `SELECT e.id AS experiment_id,e.name,e.status,ev.variant_key,
            COUNT(DISTINCT ea.id) AS samples,
            COUNT(DISTINCT CASE WHEN ee.event_type='positive_reply' THEN ea.id END) AS positive,
            COUNT(DISTINCT CASE WHEN ee.event_type='meeting_booked' THEN ea.id END) AS meetings,
            COUNT(DISTINCT CASE WHEN ee.event_type='won' THEN ea.id END) AS won
     FROM experiments e
     JOIN experiment_variants ev ON ev.experiment_id=e.id
     LEFT JOIN experiment_assignments ea ON ea.variant_id=ev.id
     LEFT JOIN experiment_events ee ON ee.assignment_id=ea.id
     GROUP BY e.id,e.name,e.status,ev.variant_key
     ORDER BY e.created_at DESC,ev.variant_key`,
  ).all<any>()

  return { experiments: experiments.results || [], stats: stats.results || [] }
}
