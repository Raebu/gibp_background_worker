import type { Env } from "./types"
import { id, nowIso } from "./db"
import { readIntentToken } from "./security"
import { requestMeetingBooking } from "./lifecycle"

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function page(title: string, body: string, options: { noindex?: boolean } = {}) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(title)}</title>
    ${options.noindex ? '<meta name="robots" content="noindex,nofollow,noarchive">' : ""}
    <style>
      :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#14171a;background:#f5f5f2}
      *{box-sizing:border-box}body{margin:0}.shell{max-width:1040px;margin:0 auto;padding:32px 20px 72px}
      .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}.brand{font-weight:800;letter-spacing:.08em}
      .tag{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#5b625f}.hero,.card{background:#fff;border:1px solid #dedfd9;border-radius:18px;padding:28px;margin:0 0 18px}
      h1{font-size:clamp(34px,7vw,66px);line-height:.98;margin:.15em 0 .45em;letter-spacing:-.04em}h2{font-size:24px;margin:0 0 14px}
      h3{font-size:16px;margin:0 0 8px}p,li{line-height:1.65;color:#343b37}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}
      .signal{padding:15px 0;border-top:1px solid #ecece7}.signal:first-child{border-top:0}.muted{color:#717874;font-size:14px}
      .actions{display:flex;flex-wrap:wrap;gap:10px}.btn,button{border:0;border-radius:999px;background:#111;color:white;padding:12px 18px;font-weight:700;cursor:pointer;text-decoration:none}
      .btn.secondary,button.secondary{background:#eceee9;color:#1b211e}.offer{display:flex;flex-direction:column;gap:12px}.offer form{margin:0}
      input,select,textarea{width:100%;padding:11px 12px;border:1px solid #cfd2cc;border-radius:10px;background:#fff;font:inherit}
      label{display:block;font-weight:700;margin:13px 0 6px}.score{font-size:72px;font-weight:850;letter-spacing:-.06em}.good{font-weight:700}
      table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #ecece7;vertical-align:top}
      a{color:inherit}.sources a{overflow-wrap:anywhere}.footer{margin-top:36px;color:#737a76;font-size:13px}
    </style></head><body><div class="shell">${body}<div class="footer">GIBP · Institutional payment, policy, liquidity and execution intelligence</div></div></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": options.noindex ? "no-store" : "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

function parseArray(value: string | null | undefined) {
  try {
    return value ? JSON.parse(value) as any[] : []
  } catch {
    return []
  }
}

async function briefingContext(env: Env, token: string) {
  const claims = await readIntentToken(token, env)
  if (!claims) return null
  const conversation = await env.GROWTH_DB.prepare(
    "SELECT * FROM conversations WHERE id=? AND account_id=?",
  ).bind(claims.c, claims.a).first<any>()
  if (!conversation) return null
  const account = await env.GROWTH_DB.prepare(
    "SELECT * FROM accounts WHERE id=?",
  ).bind(claims.a).first<any>()
  const contact = await env.GROWTH_DB.prepare(
    "SELECT * FROM contacts WHERE id=?",
  ).bind(conversation.contact_id).first<any>()
  const dossier = await env.GROWTH_DB.prepare(
    "SELECT * FROM account_dossiers WHERE account_id=?",
  ).bind(claims.a).first<any>()
  const signals = await env.GROWTH_DB.prepare(
    "SELECT kind,title,url,source,observed_at,strength FROM signals WHERE account_id=? ORDER BY observed_at DESC,strength DESC LIMIT 8",
  ).bind(claims.a).all<any>()
  return { claims, conversation, account, contact, dossier, signals: signals.results || [] }
}

async function recordBriefingView(env: Env, context: any, path: string) {
  await env.GROWTH_DB.prepare(
    `INSERT INTO website_intent
     (id,account_id,contact_id,conversation_id,event_type,path,weight,metadata_json,created_at)
     VALUES (?,?,?,?, 'architecture', ?,12,'{"source":"private_briefing"}',?)`,
  ).bind(
    id(), context.account.id, context.contact?.id || null, context.conversation.id, path, nowIso(),
  ).run()
  await env.GROWTH_DB.prepare(
    "UPDATE conversations SET score=MIN(100,score+12),updated_at=? WHERE id=?",
  ).bind(nowIso(), context.conversation.id).run()
  await env.GROWTH_DB.prepare(
    "UPDATE accounts SET engagement_score=MIN(100,engagement_score+12),score=MIN(100,score+6),updated_at=? WHERE id=?",
  ).bind(nowIso(), context.account.id).run()
}

export async function renderPrivateBriefing(request: Request, env: Env) {
  const url = new URL(request.url)
  const token = url.searchParams.get("gi") || ""
  const context = await briefingContext(env, token)
  if (!context?.account) return page("Briefing unavailable", '<div class="card"><h2>Briefing unavailable</h2><p>This private briefing link is invalid or has expired.</p></div>', { noindex: true })

  await recordBriefingView(env, context, url.pathname)
  const d = context.dossier
  const useCases = parseArray(d?.likely_use_cases_json)
  const initiatives = parseArray(d?.current_initiatives_json)
  const evidence = parseArray(d?.evidence_json)
  const stakeholders = parseArray(d?.stakeholder_map_json)
  const account = context.account
  const contact = context.contact

  const signalHtml = context.signals.map((s: any) =>
    `<div class="signal"><strong>${esc(s.title)}</strong><div class="muted">${esc(s.kind)} · strength ${esc(s.strength)}${s.url ? ` · <a href="${esc(s.url)}" rel="noopener noreferrer">source</a>` : ""}</div></div>`
  ).join("")

  const offer = (kind: string, label: string, secondary = false) =>
    `<form method="post" action="/briefing/request"><input type="hidden" name="gi" value="${esc(token)}"><input type="hidden" name="kind" value="${esc(kind)}"><button class="${secondary ? "secondary" : ""}" type="submit">${esc(label)}</button></form>`

  return page(
    `Private GIBP briefing — ${account.name}`,
    `<div class="top"><div class="brand">GIBP</div><div class="tag">Private institutional briefing</div></div>
    <section class="hero"><div class="tag">Prepared for ${esc(account.name)}</div><h1>${esc(account.name)} × GIBP</h1>
      <p>This is a private research briefing prepared from public information and GIBP's current account research. It does not imply an existing relationship, endorsement or partnership.</p>
      ${contact?.name ? `<p class="muted">Prepared for the attention of ${esc(contact.name)}${contact.role ? `, ${esc(contact.role)}` : ""}.</p>` : ""}
    </section>
    <div class="grid">
      <section class="card"><h2>What we are seeing</h2><p>${esc(d?.summary || "GIBP has identified this organisation as relevant to institutional payment, treasury or execution infrastructure.")}</p>
        ${initiatives.length ? `<h3>Current public signals</h3><ul>${initiatives.slice(0,6).map((x:any)=>`<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      </section>
      <section class="card"><h2>Possible fit</h2><p>${esc(d?.likely_problem || "The useful next step is to validate whether there is a current payment, treasury, liquidity or execution problem worth solving.")}</p>
        ${useCases.length ? `<ul>${useCases.slice(0,6).map((x:any)=>`<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      </section>
    </div>
    <section class="card"><h2>Suggested next step</h2><p>${esc(d?.recommended_offer || "A focused architecture discussion based on your current priorities.")}</p>
      <p class="muted">${esc(d?.next_best_action || "")}</p>
      <div class="actions">
        ${offer("architecture_review","Request architecture review")}
        ${offer("technical_session","Request technical integration session",true)}
        ${offer("security_pack","Send security / trust material",true)}
        ${offer("due_diligence_pack","Send due-diligence material",true)}
        ${offer("executive_briefing","Request executive briefing",true)}
        ${offer("meeting","Discuss this with GIBP",false)}
      </div>
    </section>
    ${signalHtml ? `<section class="card sources"><h2>Public evidence monitored</h2>${signalHtml}</section>` : ""}
    ${evidence.length ? `<section class="card"><h2>Research evidence</h2><ul>${evidence.slice(0,10).map((x:any)=>`<li>${esc(x.claim || x.title || x)}${x.source_url ? ` — <a href="${esc(x.source_url)}" rel="noopener noreferrer">source</a>` : ""}</li>`).join("")}</ul></section>` : ""}
    ${stakeholders.length ? `<section class="card"><h2>Likely stakeholder areas</h2><p class="muted">These are research hypotheses, not claims about internal ownership.</p><ul>${stakeholders.slice(0,8).map((x:any)=>`<li>${esc(x.role || x.name || x)}</li>`).join("")}</ul></section>` : ""}`,
    { noindex: true },
  )
}

async function requestBody(request: Request) {
  const type = request.headers.get("content-type") || ""
  if (type.includes("application/json")) return await request.json().catch(() => ({})) as any
  const form = await request.formData()
  return Object.fromEntries(form.entries())
}

const conversionScores: Record<string, number> = {
  architecture_review: 30,
  readiness_assessment: 20,
  cross_border_assessment: 22,
  liquidity_review: 25,
  technical_session: 35,
  security_pack: 28,
  due_diligence_pack: 32,
  sandbox_access: 35,
  executive_briefing: 35,
  meeting: 45,
}

export async function handleConversionRequest(request: Request, env: Env) {
  const body = await requestBody(request)
  const token = String(body.gi || body.intent_token || "")
  const kind = String(body.kind || "")
  if (!Object.hasOwn(conversionScores, kind)) return new Response("Unsupported request.", { status: 400 })

  const context = await briefingContext(env, token)
  if (!context?.account) return new Response("Invalid or expired briefing link.", { status: 400 })

  const score = conversionScores[kind]
  const now = nowIso()
  await env.GROWTH_DB.prepare(
    `INSERT INTO conversion_requests
     (id,account_id,contact_id,conversation_id,kind,status,score,payload_json,created_at,updated_at)
     VALUES (?,?,?,?,?,'new',?,'{}',?,?)`,
  ).bind(
    id(), context.account.id, context.contact?.id || null, context.conversation.id,
    kind, score, now, now,
  ).run()

  await env.GROWTH_DB.prepare(
    "UPDATE conversations SET state='engaged',score=MIN(100,score+?),updated_at=? WHERE id=?",
  ).bind(score, now, context.conversation.id).run()
  await env.GROWTH_DB.prepare(
    "UPDATE accounts SET engagement_score=MIN(100,engagement_score+?),score=MIN(100,score+?),updated_at=? WHERE id=?",
  ).bind(score, Math.ceil(score/2), now, context.account.id).run()

  let meeting: any = null
  if (kind === "meeting" && context.contact) {
    meeting = await requestMeetingBooking(
      env, context.conversation, context.account, context.contact,
      "Meeting requested from private GIBP briefing.",
    )
  }

  const wantsJson = (request.headers.get("accept") || "").includes("application/json")
  const result = { recorded: true, kind, score, meeting }
  if (wantsJson) return Response.json(result)

  return page(
    "Request received — GIBP",
    `<div class="top"><div class="brand">GIBP</div><div class="tag">Private briefing</div></div>
     <section class="hero"><div class="tag">Request received</div><h1>Thank you.</h1>
     <p>We have recorded your request for <strong>${esc(kind.replaceAll("_"," "))}</strong> and linked it to this briefing.</p>
     ${meeting?.booking_url ? `<p><a class="btn" href="${esc(meeting.booking_url)}">Choose a meeting time</a></p>` : ""}
     <p class="muted">No contractual, pricing, regulatory or implementation commitment is created by this request.</p></section>`,
    { noindex: true },
  )
}

const assessmentConfig: Record<string, { title: string; intro: string; fields: Array<[string,string]> }> = {
  "payment-readiness": {
    title: "Payment Infrastructure Readiness Score",
    intro: "A quick view of how ready your payment architecture is for multi-rail, policy-aware execution.",
    fields: [
      ["governance","Payment policy and governance are explicit and machine-operable"],
      ["rail_choice","Rail/provider selection is consistent and evidence-driven"],
      ["integration","New payment providers or rails can be integrated without major rework"],
      ["observability","Execution decisions and outcomes are observable end-to-end"],
      ["resilience","Failover and exception handling are designed across providers"],
      ["data","Payment and liquidity data is available in time to influence execution"],
    ],
  },
  "cross-border-friction": {
    title: "Cross-Border Friction Assessment",
    intro: "Estimate how much orchestration friction exists across your international payment paths.",
    fields: [
      ["providers","Providers and correspondent paths are centrally understood"],
      ["routing","Routing decisions use policy, cost, speed and availability"],
      ["evidence","Execution evidence is consistent across providers"],
      ["exceptions","Exceptions can be handled without manual provider-by-provider work"],
      ["liquidity","Liquidity implications can influence path selection"],
      ["change","New countries, currencies and rails can be added efficiently"],
    ],
  },
  "rail-selection": {
    title: "Rail Selection Assessment",
    intro: "Assess whether payment-rail selection is a strategic execution decision or mainly static configuration.",
    fields: [
      ["coverage","Available rails and provider capabilities are modelled"],
      ["policy","Policy constraints are evaluated before execution"],
      ["economics","Cost and liquidity trade-offs are visible"],
      ["performance","Real execution performance feeds future routing"],
      ["resilience","Alternative routes are available during disruption"],
      ["audit","Selection decisions are explainable and auditable"],
    ],
  },
  "liquidity-efficiency": {
    title: "Liquidity Efficiency Assessment",
    intro: "Assess how closely payment execution and liquidity information work together.",
    fields: [
      ["visibility","Liquidity positions are visible across relevant providers"],
      ["timing","Timing and settlement constraints influence execution"],
      ["routing","Liquidity can influence routing or provider choice"],
      ["forecasting","Expected flows are considered before execution"],
      ["exceptions","Liquidity exceptions have defined operating responses"],
      ["evidence","Liquidity-driven decisions can be evidenced afterwards"],
    ],
  },
}

export function scoreAssessmentAnswers(values: Record<string, unknown>, fields: Array<[string,string]>) {
  const scores = fields.map(([key]) => Math.max(0, Math.min(5, Number(values[key] || 0))))
  return Math.round(scores.reduce((a,b)=>a+b,0) / Math.max(1, fields.length*5) * 100)
}

export async function renderAssessment(request: Request, env: Env, type: string) {
  const config = assessmentConfig[type]
  if (!config) return new Response("Assessment not found.", { status: 404 })
  const url = new URL(request.url)
  const gi = url.searchParams.get("gi") || ""

  if (request.method === "GET") {
    const fields = config.fields.map(([key,label]) =>
      `<label for="${esc(key)}">${esc(label)}</label><select id="${esc(key)}" name="${esc(key)}" required>
       <option value="">Choose…</option><option value="0">Not in place</option><option value="1">Very limited</option>
       <option value="2">Partly</option><option value="3">Developing</option><option value="4">Strong</option><option value="5">Fully established</option></select>`
    ).join("")
    return page(
      config.title,
      `<div class="top"><div class="brand">GIBP</div><div class="tag">Institutional assessment</div></div>
       <section class="hero"><div class="tag">Interactive diagnostic</div><h1>${esc(config.title)}</h1><p>${esc(config.intro)}</p></section>
       <section class="card"><form method="post"><input type="hidden" name="gi" value="${esc(gi)}">${fields}
       <label for="organisation">Organisation (optional)</label><input id="organisation" name="organisation" autocomplete="organization">
       <label for="work_email">Work email (optional)</label><input id="work_email" type="email" name="work_email" autocomplete="email">
       <label><input style="width:auto" type="checkbox" name="contact_me" value="yes"> I would like GIBP to contact me about the result.</label>
       <p><button type="submit">Calculate score</button></p></form></section>`,
    )
  }

  const body = await requestBody(request)
  const score = scoreAssessmentAnswers(body, config.fields)
  const token = String(body.gi || "")
  const context = token ? await briefingContext(env, token) : null
  const conversionKind = type === "cross-border-friction" ? "cross_border_assessment"
    : type === "liquidity-efficiency" ? "liquidity_review" : "readiness_assessment"

  await env.GROWTH_DB.prepare(
    `INSERT INTO conversion_requests
     (id,account_id,contact_id,conversation_id,kind,status,score,payload_json,created_at,updated_at)
     VALUES (?,?,?,?,?,'completed',?,?,?,?)`,
  ).bind(
    id(), context?.account?.id || null, context?.contact?.id || null,
    context?.conversation?.id || null, conversionKind, score,
    JSON.stringify({
      assessment_type:type,
      answers:Object.fromEntries(config.fields.map(([key])=>[key,body[key]])),
      organisation:String(body.organisation || "").slice(0,200),
      work_email:String(body.work_email || "").slice(0,320),
      contact_me:body.contact_me === "yes",
    }), nowIso(), nowIso(),
  ).run()

  if (context?.conversation) {
    await env.GROWTH_DB.prepare(
      "UPDATE conversations SET state='engaged',score=MIN(100,score+20),updated_at=? WHERE id=?",
    ).bind(nowIso(), context.conversation.id).run()
  }

  const band = score >= 80 ? "Strong" : score >= 60 ? "Developing" : score >= 40 ? "Material gaps" : "High friction"
  return page(
    `${config.title} — result`,
    `<div class="top"><div class="brand">GIBP</div><div class="tag">Assessment result</div></div>
     <section class="hero"><div class="tag">${esc(band)}</div><div class="score">${score}</div><h1>${esc(config.title)}</h1>
     <p>${score>=80 ? "Your responses indicate a relatively mature operating model. The next question is where orchestration could improve flexibility, evidence or optimisation."
       : score>=60 ? "The foundations appear to exist, with several areas where orchestration and policy automation may reduce friction."
       : "Your responses indicate meaningful operating friction. A focused architecture review could identify where policy, execution and liquidity decisions are currently fragmented."}</p>
     ${token ? `<p><a class="btn" href="/briefing?gi=${encodeURIComponent(token)}">Return to private briefing</a></p>` : ""}
     </section>`,
  )
}

export async function renderInsightsIndex(env: Env) {
  const rows = await env.GROWTH_DB.prepare(
    "SELECT slug,title,executive_summary,updated_at FROM authority_briefings WHERE status='published' ORDER BY updated_at DESC LIMIT 30",
  ).all<any>()
  return page(
    "GIBP Market Briefings",
    `<div class="top"><div class="brand">GIBP</div><div class="tag">Market intelligence</div></div>
     <section class="hero"><div class="tag">Public-signal intelligence</div><h1>GIBP Market Briefings</h1><p>Evidence-led notes generated from public developments affecting institutional payment infrastructure.</p></section>
     ${(rows.results||[]).map((x:any)=>`<section class="card"><h2><a href="/insights/${esc(x.slug)}">${esc(x.title)}</a></h2><p>${esc(x.executive_summary)}</p><div class="muted">Updated ${esc(x.updated_at)}</div></section>`).join("") || '<section class="card"><p>No briefings are published yet.</p></section>'}`,
  )
}

export async function renderInsight(env: Env, slug: string) {
  const row = await env.GROWTH_DB.prepare(
    "SELECT * FROM authority_briefings WHERE slug=? AND status='published'",
  ).bind(slug).first<any>()
  if (!row) return new Response("Briefing not found.", { status: 404 })
  const points = parseArray(row.key_points_json)
  const sources = parseArray(row.source_json)
  return page(
    row.title,
    `<div class="top"><div class="brand">GIBP</div><div class="tag">Market briefing</div></div>
     <section class="hero"><div class="tag">Public-signal intelligence</div><h1>${esc(row.title)}</h1><p>${esc(row.executive_summary)}</p></section>
     ${points.length ? `<section class="card"><h2>Key themes</h2><ul>${points.map((x:any)=>`<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}
     <section class="card sources"><h2>Public sources</h2>${sources.map((x:any)=>`<div class="signal"><strong>${esc(x.title)}</strong>${x.url ? `<div><a href="${esc(x.url)}" rel="noopener noreferrer">View source</a></div>` : ""}</div>`).join("")}</section>
     <section class="card"><p class="muted">This briefing summarises public signals and does not imply GIBP has a relationship with any organisation named in the sources.</p></section>`,
  )
}

export function renderDashboardLogin() {
  return page(
    "GIBP Market Development Desk",
    `<div class="top"><div class="brand">GIBP</div><div class="tag">Market Development Desk</div></div>
     <section class="hero"><h1>Commercial desk</h1><p>Sign in with the growth-engine admin token.</p>
     <form method="post" action="/dashboard/login"><label for="token">Admin token</label><input id="token" name="token" type="password" required>
     <p><button type="submit">Open dashboard</button></p></form></section>`,
    { noindex:true },
  )
}

export async function renderDashboard(env: Env) {
  const metrics = await env.GROWTH_DB.prepare(
    `SELECT
     (SELECT COUNT(*) FROM accounts) accounts,
     (SELECT COUNT(*) FROM accounts WHERE status='qualified') qualified,
     (SELECT COUNT(*) FROM account_dossiers) dossiers,
     (SELECT COUNT(*) FROM contact_candidates WHERE status='candidate') contact_candidates,
     (SELECT COUNT(*) FROM contacts WHERE status='active') active_contacts,
     (SELECT COUNT(*) FROM conversations WHERE state='engaged') engaged,
     (SELECT COUNT(*) FROM conversations WHERE state='nurture') nurture,
     (SELECT COUNT(*) FROM conversations WHERE state='serious') serious,
     (SELECT COUNT(*) FROM handoffs WHERE status='ready') handoffs,
     (SELECT COUNT(*) FROM conversion_requests WHERE created_at>=datetime('now','-1 day')) conversions_24h,
     (SELECT COUNT(*) FROM meeting_requests WHERE status='scheduled') meetings,
     (SELECT COUNT(*) FROM opportunities WHERE kind='rfp' AND status IN ('qualified','handoff')) rfps,
     (SELECT COUNT(*) FROM authority_briefings WHERE status='published') briefings,
     (SELECT COUNT(*) FROM search_demand) search_queries`,
  ).first<any>()
  const handoffs = await env.GROWTH_DB.prepare(
    `SELECT h.created_at,a.name account_name,ct.name contact_name,ct.role,h.priority,h.reason
     FROM handoffs h JOIN accounts a ON a.id=h.account_id JOIN contacts ct ON ct.id=h.contact_id
     WHERE h.status='ready' ORDER BY h.created_at DESC LIMIT 10`,
  ).all<any>()
  const conversions = await env.GROWTH_DB.prepare(
    `SELECT cr.kind,cr.score,cr.created_at,a.name account_name
     FROM conversion_requests cr LEFT JOIN accounts a ON a.id=cr.account_id
     ORDER BY cr.created_at DESC LIMIT 10`,
  ).all<any>()
  const learnings = await env.GROWTH_DB.prepare(
    "SELECT * FROM commercial_learnings WHERE sample_size>=5 ORDER BY weight DESC,sample_size DESC LIMIT 10",
  ).all<any>()
  const searchDemand = await env.GROWTH_DB.prepare(
    "SELECT query,landing_path,clicks,impressions,average_position FROM search_demand ORDER BY clicks DESC,impressions DESC LIMIT 10",
  ).all<any>()

  const cards = Object.entries(metrics || {}).map(([k,v]) =>
    `<div class="card"><div class="tag">${esc(k.replaceAll("_"," "))}</div><div class="score" style="font-size:46px">${esc(v)}</div></div>`
  ).join("")

  return page(
    "GIBP Autonomous Market Development Desk",
    `<div class="top"><div class="brand">GIBP</div><div><span class="tag">Autonomous Market Development Desk</span> · <a href="/dashboard/logout">Sign out</a></div></div>
     <section class="hero"><div class="tag">Production commercial brain</div><h1>Only the work that matters.</h1><p>Discovery, research, qualification, nurture, procurement, website intent and learning feed one operating view.</p></section>
     <div class="grid">${cards}</div>
     <section class="card"><h2>Serious opportunities</h2><table><thead><tr><th>Account</th><th>Contact</th><th>Priority</th><th>Reason</th></tr></thead><tbody>
     ${(handoffs.results||[]).map((x:any)=>`<tr><td>${esc(x.account_name)}</td><td>${esc(x.contact_name)}<br><span class="muted">${esc(x.role)}</span></td><td>${esc(x.priority)}</td><td>${esc(x.reason)}</td></tr>`).join("") || '<tr><td colspan="4">No serious handoffs yet.</td></tr>'}
     </tbody></table></section>
     <div class="grid"><section class="card"><h2>Latest conversion signals</h2>${(conversions.results||[]).map((x:any)=>`<div class="signal"><strong>${esc(x.account_name || "Unattributed visitor")}</strong><div>${esc(x.kind)} · score ${esc(x.score)}</div><div class="muted">${esc(x.created_at)}</div></div>`).join("") || "<p>No conversion requests yet.</p>"}</section>
     <section class="card"><h2>What the system is learning</h2>${(learnings.results||[]).map((x:any)=>`<div class="signal"><strong>${esc(x.dimension)}: ${esc(x.dimension_value)}</strong><div>weight ${esc(x.weight)} · sample ${esc(x.sample_size)} · serious ${esc(x.serious_count)} · won ${esc(x.won_count)}</div></div>`).join("") || "<p>Learning activates after enough real commercial outcomes exist.</p>"}</section></div>
     <section class="card"><h2>Non-email demand</h2>${(searchDemand.results||[]).map((x:any)=>`<div class="signal"><strong>${esc(x.query)}</strong><div>${esc(x.clicks)} clicks · ${esc(x.impressions)} impressions · avg position ${esc(x.average_position ?? "—")}</div><div class="muted">${esc(x.landing_path || "")}</div></div>`).join("") || "<p>No search-demand data has been ingested yet.</p>"}</section>`,
    { noindex:true },
  )
}
