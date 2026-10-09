import type { Env, ReplyClassification } from "./types"
import { audit, countToday } from "./db"

function parseJson(text: string) {
  const trimmed = text.trim().replace(/^\`\`\`(?:json)?/i, "").replace(/\`\`\`$/i, "").trim()
  return JSON.parse(trimmed)
}

export async function aiJson<T>(
  env: Env,
  system: string,
  prompt: string,
): Promise<T | null> {
  if (!env.AI) return null

  const cap = Number(env.AI_DAILY_CALL_CAP || 30)
  const used = await countToday(
    env,
    `SELECT COUNT(*) AS total FROM audit_events
     WHERE category='ai' AND action='call'
     AND created_at >= datetime('now','start of day')`,
  )
  if (used >= cap) return null

  const model = env.AI_MODEL || "@cf/zai-org/glm-4.7-flash"
  await audit(env, "ai", "call", "model", model, { prompt_chars: prompt.length })

  const result = (await env.AI.run(model, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 1000,
  })) as { response?: string; result?: { response?: string } } | string

  const text =
    typeof result === "string"
      ? result
      : result.response || result.result?.response || ""

  if (!text) return null
  try {
    return parseJson(text) as T
  } catch {
    return null
  }
}

export async function classifyReply(env: Env, subject: string, body: string) {
  const lower = `${subject}\n${body}`.toLowerCase()
  const fallback: ReplyClassification = {
    intent: "other",
    sentiment: "neutral",
    serious: false,
    score_delta: 8,
    should_reply: true,
    requires_human: false,
    summary: body.slice(0, 300),
  }

  if (/unsubscribe|remove me|stop emailing|do not contact/.test(lower)) {
    return { ...fallback, intent: "unsubscribe", sentiment: "negative", score_delta: -50, should_reply: false }
  }
  if (/book|meeting|call|calendar|speak|demo|discussion/.test(lower)) {
    fallback.intent = "meeting_request"
    fallback.serious = true
    fallback.score_delta = 45
    fallback.requires_human = true
  } else if (/price|pricing|contract|terms|sla|liability|indemn|exclusive|discount/.test(lower)) {
    fallback.intent = "commercial_terms"
    fallback.serious = true
    fallback.score_delta = 35
    fallback.requires_human = true
  } else if (/security|legal|regulat|dpa|data processing|penetration|audit/.test(lower)) {
    fallback.intent = "security_or_legal"
    fallback.serious = true
    fallback.score_delta = 30
    fallback.requires_human = true
  } else if (/not interested|no thanks|do not need/.test(lower)) {
    fallback.intent = "negative"
    fallback.sentiment = "negative"
    fallback.score_delta = -25
    fallback.should_reply = false
  } else if (/next quarter|next year|later|not now|come back/.test(lower)) {
    fallback.intent = "not_now"
    fallback.score_delta = 3
  } else if (/contact|speak to|colleague|forwarded|introduced|introduce/.test(lower)) {
    fallback.intent = "referral"
    fallback.score_delta = 25
  } else if (/send|information|details|whitepaper|architecture|more info/.test(lower)) {
    fallback.intent = "information_request"
    fallback.score_delta = 18
  } else if (/interested|relevant|sounds useful|tell me more/.test(lower)) {
    fallback.intent = "positive"
    fallback.sentiment = "positive"
    fallback.score_delta = 24
  }

  const system = `You classify B2B institutional sales replies for GIBP.
Return JSON only with keys intent, sentiment, serious, score_delta, should_reply, requires_human, summary, suggested_reply, referral_name, referral_email.
Allowed intent values: positive, information_request, meeting_request, referral, not_now, negative, unsubscribe, commercial_terms, security_or_legal, other.
A conversation is serious if the recipient requests a meeting/evaluation/proposal, identifies an active project, introduces a decision maker, or asks binding commercial/legal/security questions.
Never make binding pricing, legal, regulatory, security, SLA, exclusivity or implementation commitments.`

  return (
    (await aiJson<ReplyClassification>(
      env,
      system,
      `Subject: ${subject}\n\nReply:\n${body.slice(0, 8000)}\n\nFallback classification:\n${JSON.stringify(fallback)}`,
    )) || fallback
  )
}
