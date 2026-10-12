import type { Env } from "./types"
import { nowIso } from "./db"

export type GibpSite = "gibp.global" | "gibp.app"

const productEvents = new Set([
  "signup","login","onboarding_started","onboarding_completed","activated","quote_requested",
  "beneficiary_added","payment_intent_created","payment_intent_completed","upgrade_intent",
  "high_value_action","subscription_started","customer_created","payment_succeeded",
  "subscription_cancelled","churned","partner_created",
])

function cleanDomain(value: unknown) {
  const raw = String(value || "").trim().toLowerCase()
  if (!raw) return ""
  return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split(":")[0]
}

function cleanEmail(value: unknown) {
  const email = String(value || "").trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ""
}

export function canonicalSourceSite(value: unknown, fallback: GibpSite = "gibp.global"): GibpSite {
  const raw = String(value || "").trim().toLowerCase()
  if (raw.includes("gibp.app")) return "gibp.app"
  if (raw.includes("gibp.global")) return "gibp.global"
  return fallback
}

export function sourceSiteFromOrigin(origin: string | null | undefined): GibpSite | null {
  if (!origin) return null
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^www\./, "")
    if (host === "gibp.app") return "gibp.app"
    if (host === "gibp.global") return "gibp.global"
  } catch {}
  return null
}

async function resolveIdentity(env: Env, payload: any, sourceSite: GibpSite) {
  let accountId = payload.account_id ? String(payload.account_id) : null
  let contactId = payload.contact_id ? String(payload.contact_id) : null
  const email = cleanEmail(payload.email)
  const externalUserId = String(payload.user_id || payload.external_user_id || "").trim() || null
  const domain = cleanDomain(payload.account_domain || payload.organization_domain)

  if (!accountId && externalUserId) {
    const linked = await env.GROWTH_DB.prepare(
      "SELECT account_id,contact_id FROM identity_links WHERE identity_key=? LIMIT 1",
    ).bind(`user:${externalUserId}`).first<{ account_id: string | null; contact_id: string | null }>()
    accountId = linked?.account_id || null
    contactId = contactId || linked?.contact_id || null
  }

  if (!contactId && email) {
    const contact = await env.GROWTH_DB.prepare(
      "SELECT id,account_id FROM contacts WHERE lower(email)=lower(?) LIMIT 1",
    ).bind(email).first<{ id: string; account_id: string }>()
    if (contact) {
      contactId = contact.id
      accountId = accountId || contact.account_id
    }
  }

  if (!accountId && domain) {
    const account = await env.GROWTH_DB.prepare(
      "SELECT id FROM accounts WHERE lower(replace(domain,'www.',''))=? LIMIT 1",
    ).bind(domain).first<{ id: string }>()
    accountId = account?.id || null
  }

  const now = nowIso()
  const links: Array<[string,string]> = []
  if (externalUserId) links.push([`user:${externalUserId}`, "external_user"])
  if (email) links.push([`email:${email}`, "email"])
  if (domain) links.push([`domain:${domain}`, "domain"])

  if (accountId || contactId) {
    for (const [identityKey, identityType] of links) {
      await env.GROWTH_DB.prepare(
        `INSERT INTO identity_links
          (identity_key,identity_type,account_id,contact_id,source_site,confidence,first_seen_at,last_seen_at)
         VALUES (?,?,?,?,?,100,?,?)
         ON CONFLICT(identity_key) DO UPDATE SET
          account_id=COALESCE(excluded.account_id,identity_links.account_id),
          contact_id=COALESCE(excluded.contact_id,identity_links.contact_id),
          source_site=excluded.source_site,last_seen_at=excluded.last_seen_at`,
      ).bind(identityKey,identityType,accountId,contactId,sourceSite,now,now).run()
    }
  }

  return { accountId, contactId, externalUserId, email, domain }
}

function stageForEvent(eventType: string) {
  if (eventType === "partner_created") return "partner"
  if (eventType === "subscription_cancelled" || eventType === "churned") return "former_customer"
  if (["subscription_started","customer_created","payment_succeeded","payment_intent_completed"].includes(eventType)) return "customer"
  if (["signup","onboarding_started","onboarding_completed","activated","beneficiary_added","payment_intent_created","login"].includes(eventType)) return "trial"
  if (["upgrade_intent","high_value_action","quote_requested"].includes(eventType)) return "lead"
  return null
}

function nextLifecycleStage(current: string | null, proposed: string | null, eventType: string) {
  if (!proposed) return current || "prospect"
  if (proposed === "former_customer" || proposed === "partner") return proposed
  if (current === "partner") return current
  if (current === "customer" && proposed !== "former_customer") return current
  if (current === "former_customer" && ["signup","activated","subscription_started","customer_created","payment_succeeded"].includes(eventType)) {
    return proposed === "lead" ? "trial" : proposed
  }
  const rank: Record<string, number> = { prospect:0, lead:1, trial:2, customer:3, partner:4, former_customer:1 }
  return (rank[proposed] || 0) >= (rank[current || "prospect"] || 0) ? proposed : (current || "prospect")
}

async function updateLifecycle(
  env: Env,
  accountId: string,
  sourceSite: GibpSite,
  externalUserId: string | null,
  eventType: string,
  payload: any,
  occurredAt: string,
) {
  const current = await env.GROWTH_DB.prepare(
    "SELECT * FROM account_lifecycle WHERE account_id=?",
  ).bind(accountId).first<any>()
  const stage = nextLifecycleStage(current?.stage || null, stageForEvent(eventType), eventType)
  const health = ["upgrade_intent","high_value_action","payment_intent_completed","payment_succeeded"].includes(eventType)
    ? "expansion"
    : current?.health_status || "unknown"
  const expansionDelta =
    eventType === "upgrade_intent" ? 35 :
    eventType === "high_value_action" ? 20 :
    eventType === "payment_intent_completed" || eventType === "payment_succeeded" ? 12 :
    eventType === "beneficiary_added" ? 5 : 0
  const mrr = payload.mrr == null ? current?.mrr ?? null : Math.max(0, Number(payload.mrr) || 0)
  const currency = payload.currency ? String(payload.currency).toUpperCase().slice(0,3) : current?.currency || null
  const now = nowIso()

  await env.GROWTH_DB.prepare(
    `INSERT INTO account_lifecycle
      (account_id,stage,source_site,external_user_id,first_product_seen_at,onboarding_started_at,
       onboarding_completed_at,activated_at,customer_since,churned_at,last_product_activity_at,
       health_status,expansion_score,mrr,currency,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id) DO UPDATE SET
       stage=excluded.stage,source_site=excluded.source_site,
       external_user_id=COALESCE(excluded.external_user_id,account_lifecycle.external_user_id),
       first_product_seen_at=COALESCE(account_lifecycle.first_product_seen_at,excluded.first_product_seen_at),
       onboarding_started_at=COALESCE(account_lifecycle.onboarding_started_at,excluded.onboarding_started_at),
       onboarding_completed_at=COALESCE(account_lifecycle.onboarding_completed_at,excluded.onboarding_completed_at),
       activated_at=COALESCE(account_lifecycle.activated_at,excluded.activated_at),
       customer_since=CASE WHEN excluded.stage='customer' THEN COALESCE(account_lifecycle.customer_since,excluded.customer_since) ELSE account_lifecycle.customer_since END,
       churned_at=CASE WHEN excluded.stage='former_customer' THEN excluded.churned_at WHEN excluded.stage IN ('trial','customer') THEN NULL ELSE account_lifecycle.churned_at END,
       last_product_activity_at=excluded.last_product_activity_at,health_status=excluded.health_status,
       expansion_score=MIN(100,account_lifecycle.expansion_score+?),
       mrr=COALESCE(excluded.mrr,account_lifecycle.mrr),currency=COALESCE(excluded.currency,account_lifecycle.currency),
       updated_at=excluded.updated_at`,
  ).bind(
    accountId,stage,sourceSite,externalUserId,occurredAt,
    eventType === "onboarding_started" ? occurredAt : null,
    eventType === "onboarding_completed" ? occurredAt : null,
    eventType === "activated" ? occurredAt : null,
    stage === "customer" ? occurredAt : null,
    stage === "former_customer" ? occurredAt : null,
    occurredAt,health,expansionDelta,mrr,currency,now,expansionDelta,
  ).run()

  if (expansionDelta >= 20) {
    await env.GROWTH_DB.prepare(
      `INSERT INTO lifecycle_signals
       (id,account_id,source_site,signal_type,score,status,detail_json,created_at,updated_at)
       VALUES (?,?,?,?,?,'open',?,?,?)
       ON CONFLICT(account_id,signal_type,status) DO UPDATE SET
        score=MAX(lifecycle_signals.score,excluded.score),detail_json=excluded.detail_json,updated_at=excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),accountId,sourceSite,
      eventType === "upgrade_intent" ? "expansion_intent" : "high_product_usage",
      Math.min(100,Math.max(20,expansionDelta*2)),
      JSON.stringify({ event_type:eventType,path:payload.path || null }),now,now,
    ).run()
  }

  return { stage, health_status:health }
}

export async function recordProductEvent(
  env: Env,
  payload: any,
  options: { trusted?: boolean; sourceSite?: GibpSite | null } = {},
) {
  const sourceSite = options.sourceSite || canonicalSourceSite(payload.source_site || payload.site, "gibp.app")
  const eventType = String(payload.event_type || payload.event || "").trim()
  if (!productEvents.has(eventType)) throw new Error("unsupported_product_event")
  if (!options.trusted) throw new Error("trusted_product_event_required")

  const identity = await resolveIdentity(env,payload,sourceSite)
  const occurredAt = payload.occurred_at && !Number.isNaN(new Date(payload.occurred_at).getTime())
    ? new Date(payload.occurred_at).toISOString()
    : nowIso()
  const eventKey = String(payload.event_key || "").trim().slice(0,200) ||
    `${sourceSite}:${eventType}:${identity.externalUserId || identity.email || identity.accountId || crypto.randomUUID()}:${occurredAt}`

  const result = await env.GROWTH_DB.prepare(
    `INSERT OR IGNORE INTO product_events
      (event_key,source_site,account_id,contact_id,external_user_id,event_type,path,metadata_json,occurred_at,received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    eventKey,sourceSite,identity.accountId,identity.contactId,identity.externalUserId,eventType,
    String(payload.path || "").slice(0,500) || null,
    JSON.stringify(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
    occurredAt,nowIso(),
  ).run()

  if (!result.meta?.changes) return { recorded:true,duplicate:true,event_key:eventKey,source_site:sourceSite }

  let lifecycle: any = null
  if (identity.accountId) {
    lifecycle = await updateLifecycle(env,identity.accountId,sourceSite,identity.externalUserId,eventType,payload,occurredAt)
    const engagement = ["upgrade_intent","high_value_action","payment_intent_completed","payment_succeeded"].includes(eventType) ? 12 : 4
    await env.GROWTH_DB.prepare(
      "UPDATE accounts SET engagement_score=MIN(100,engagement_score+?),score=MIN(100,score+?),updated_at=? WHERE id=?",
    ).bind(engagement,Math.ceil(engagement/2),nowIso(),identity.accountId).run()
  }

  return { recorded:true,duplicate:false,event_key:eventKey,source_site:sourceSite,account_id:identity.accountId,contact_id:identity.contactId,lifecycle }
}

export async function lifecycleSendDecision(env: Env, accountId: string, isInitial: boolean) {
  if (!isInitial) return { allowed:true,reason:"ok" }
  const row = await env.GROWTH_DB.prepare(
    "SELECT stage FROM account_lifecycle WHERE account_id=?",
  ).bind(accountId).first<{ stage:string }>()
  if (!row) return { allowed:true,reason:"ok" }
  if (["trial","customer","partner"].includes(row.stage)) {
    return { allowed:false,reason:`lifecycle_cold_outreach_blocked:${row.stage}` }
  }
  if (row.stage === "former_customer") return { allowed:false,reason:"former_customer_manual_reactivation_required" }
  return { allowed:true,reason:"ok" }
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((x)=>x.toString(16).padStart(2,"0")).join("")
}

export async function assignSurfaceExperiment(
  env: Env,
  input: { source_site?: unknown; experiment_key?: unknown; subject_key?: unknown },
) {
  const sourceSite = canonicalSourceSite(input.source_site)
  const experimentKey = String(input.experiment_key || "").trim().slice(0,100)
  const subjectKey = String(input.subject_key || "").trim().slice(0,200)
  if (!experimentKey || !subjectKey) throw new Error("experiment_key_and_subject_key_required")
  const existing = await env.GROWTH_DB.prepare(
    "SELECT id,variant_key FROM surface_experiment_assignments WHERE source_site=? AND experiment_key=? AND subject_key=?",
  ).bind(sourceSite,experimentKey,subjectKey).first<{ id:string;variant_key:string }>()
  if (existing) return { assignment_id:existing.id,variant:existing.variant_key,source_site:sourceSite }

  const hash = await digest(`${sourceSite}:${experimentKey}:${subjectKey}`)
  const variant = parseInt(hash.slice(0,8),16)%2===0 ? "control" : "variant_b"
  const assignmentId = crypto.randomUUID()
  await env.GROWTH_DB.prepare(
    `INSERT OR IGNORE INTO surface_experiment_assignments
     (id,source_site,experiment_key,subject_key,variant_key,assigned_at) VALUES (?,?,?,?,?,?)`,
  ).bind(assignmentId,sourceSite,experimentKey,subjectKey,variant,nowIso()).run()
  const final = await env.GROWTH_DB.prepare(
    "SELECT id,variant_key FROM surface_experiment_assignments WHERE source_site=? AND experiment_key=? AND subject_key=?",
  ).bind(sourceSite,experimentKey,subjectKey).first<{ id:string;variant_key:string }>()
  return { assignment_id:final?.id || assignmentId,variant:final?.variant_key || variant,source_site:sourceSite }
}

export async function recordSurfaceExperimentEvent(env: Env,payload: any,sourceSite?: GibpSite | null) {
  const assignmentId = String(payload.assignment_id || "").trim()
  const eventType = String(payload.event_type || "").trim().slice(0,80)
  if (!assignmentId || !eventType) throw new Error("assignment_id_and_event_type_required")
  const assignment = await env.GROWTH_DB.prepare(
    "SELECT id,source_site FROM surface_experiment_assignments WHERE id=?",
  ).bind(assignmentId).first<{ id:string;source_site:string }>()
  if (!assignment) throw new Error("assignment_not_found")
  if (sourceSite && assignment.source_site!==sourceSite) throw new Error("surface_mismatch")
  const eventKey = String(payload.event_key || "").trim().slice(0,200) ||
    `${assignmentId}:${eventType}:${String(payload.subject_event_id || crypto.randomUUID())}`
  await env.GROWTH_DB.prepare(
    "INSERT OR IGNORE INTO surface_experiment_events(event_key,assignment_id,event_type,value,occurred_at) VALUES (?,?,?,?,?)",
  ).bind(eventKey,assignmentId,eventType,payload.value==null?null:Number(payload.value),payload.occurred_at?new Date(payload.occurred_at).toISOString():nowIso()).run()
  return { recorded:true,event_key:eventKey }
}

export async function runLifecycleMaintenance(env: Env) {
  const now=nowIso()
  await env.GROWTH_DB.prepare(
    `UPDATE account_lifecycle SET health_status='dormant',updated_at=?
     WHERE stage IN ('trial','customer') AND last_product_activity_at<datetime('now','-30 day') AND health_status!='dormant'`,
  ).bind(now).run()
  await env.GROWTH_DB.prepare(
    `UPDATE account_lifecycle SET health_status='watch',updated_at=?
     WHERE stage='trial' AND onboarding_started_at IS NOT NULL AND onboarding_completed_at IS NULL
       AND onboarding_started_at<datetime('now','-2 day') AND last_product_activity_at>=datetime('now','-30 day')`,
  ).bind(now).run()
  const rows=await env.GROWTH_DB.prepare(
    `SELECT account_id,source_site,stage,health_status,expansion_score,last_product_activity_at
     FROM account_lifecycle WHERE health_status IN ('dormant','watch','expansion')
     ORDER BY expansion_score DESC,last_product_activity_at DESC LIMIT 500`,
  ).all<any>()
  for(const row of rows.results || []){
    const signalType=row.health_status==="expansion"?"expansion_opportunity":row.health_status==="dormant"?"retention_risk":"onboarding_stalled"
    const score=row.health_status==="expansion"?Math.max(60,Number(row.expansion_score || 0)):row.health_status==="dormant"?65:55
    await env.GROWTH_DB.prepare(
      `INSERT INTO lifecycle_signals
       (id,account_id,source_site,signal_type,score,status,detail_json,created_at,updated_at)
       VALUES (?,?,?,?,?,'open',?,?,?)
       ON CONFLICT(account_id,signal_type,status) DO UPDATE SET score=excluded.score,detail_json=excluded.detail_json,updated_at=excluded.updated_at`,
    ).bind(crypto.randomUUID(),row.account_id,row.source_site || "gibp.app",signalType,score,
      JSON.stringify({stage:row.stage,health_status:row.health_status,last_activity:row.last_product_activity_at}),now,now).run()
  }
  return { reviewed:(rows.results || []).length }
}

async function storeJourneyCheck(env: Env,sourceSite:GibpSite,kind:string,ok:boolean,statusCode:number|null,durationMs:number,detail:unknown){
  await env.GROWTH_DB.prepare(
    "INSERT INTO synthetic_journey_checks(id,source_site,check_kind,ok,status_code,duration_ms,detail_json,checked_at) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(crypto.randomUUID(),sourceSite,kind,ok?1:0,statusCode,durationMs,JSON.stringify(detail || {}),nowIso()).run()
}

export async function runSyntheticJourneyChecks(env: Env) {
  const results:any[]=[]
  for(const sourceSite of ["gibp.global","gibp.app"] as GibpSite[]){
    const home=`https://www.${sourceSite}`
    let started=Date.now()
    try{
      const response=await fetch(home,{method:"GET",redirect:"follow",signal:AbortSignal.timeout(12_000)})
      const duration=Date.now()-started
      await storeJourneyCheck(env,sourceSite,"homepage",response.ok,response.status,duration,{url:response.url})
      results.push({source_site:sourceSite,check:"homepage",ok:response.ok,status:response.status,duration_ms:duration})
    }catch(error){
      const duration=Date.now()-started
      await storeJourneyCheck(env,sourceSite,"homepage",false,null,duration,{error:error instanceof Error?error.message:String(error)})
      results.push({source_site:sourceSite,check:"homepage",ok:false,status:null,duration_ms:duration})
    }
    started=Date.now()
    try{
      const response=await fetch("https://growth.gibp.global/events/website",{
        method:"OPTIONS",headers:{Origin:`https://www.${sourceSite}`},signal:AbortSignal.timeout(8_000),
      })
      const duration=Date.now()-started
      const allowOrigin=response.headers.get("access-control-allow-origin")
      const ok=response.ok && allowOrigin===`https://www.${sourceSite}`
      await storeJourneyCheck(env,sourceSite,"intent_collector",ok,response.status,duration,{allow_origin:allowOrigin})
      results.push({source_site:sourceSite,check:"intent_collector",ok,status:response.status,duration_ms:duration})
    }catch(error){
      const duration=Date.now()-started
      await storeJourneyCheck(env,sourceSite,"intent_collector",false,null,duration,{error:error instanceof Error?error.message:String(error)})
      results.push({source_site:sourceSite,check:"intent_collector",ok:false,status:null,duration_ms:duration})
    }
  }
  return { ok:results.every((x)=>x.ok),results }
}

export async function surfaceSnapshot(env: Env) {
  const intent=await env.GROWTH_DB.prepare(
    `SELECT source_site,COUNT(*) events,SUM(CASE WHEN event_type IN ('contact','meeting') THEN 1 ELSE 0 END) high_intent
     FROM website_intent WHERE created_at>=datetime('now','-30 day') GROUP BY source_site ORDER BY source_site`,
  ).all<any>()
  const product=await env.GROWTH_DB.prepare(
    `SELECT source_site,COUNT(*) events,SUM(CASE WHEN event_type='signup' THEN 1 ELSE 0 END) signups,
       SUM(CASE WHEN event_type='onboarding_completed' THEN 1 ELSE 0 END) onboarding_completed,
       SUM(CASE WHEN event_type='activated' THEN 1 ELSE 0 END) activated,
       SUM(CASE WHEN event_type IN ('subscription_started','customer_created','payment_succeeded','payment_intent_completed') THEN 1 ELSE 0 END) customer_events
     FROM product_events WHERE occurred_at>=datetime('now','-30 day') GROUP BY source_site ORDER BY source_site`,
  ).all<any>()
  const lifecycle=await env.GROWTH_DB.prepare(
    "SELECT stage,health_status,COUNT(*) total FROM account_lifecycle GROUP BY stage,health_status ORDER BY stage,health_status",
  ).all<any>()
  const search=await env.GROWTH_DB.prepare(
    `SELECT source_site,SUM(clicks) clicks,SUM(impressions) impressions,ROUND(AVG(average_position),2) average_position,COUNT(*) queries
     FROM search_demand_sites GROUP BY source_site ORDER BY source_site`,
  ).all<any>()
  const experiments=await env.GROWTH_DB.prepare(
    `SELECT a.source_site,a.experiment_key,a.variant_key,COUNT(DISTINCT a.id) assignments,
       SUM(CASE WHEN e.event_type IN ('conversion','signup','activated','meeting','customer') THEN 1 ELSE 0 END) conversions
     FROM surface_experiment_assignments a LEFT JOIN surface_experiment_events e ON e.assignment_id=a.id
     GROUP BY a.source_site,a.experiment_key,a.variant_key ORDER BY a.source_site,a.experiment_key,a.variant_key`,
  ).all<any>()
  const journeys=await env.GROWTH_DB.prepare(
    `SELECT s.source_site,s.check_kind,s.ok,s.status_code,s.duration_ms,s.checked_at
     FROM synthetic_journey_checks s
     WHERE s.checked_at=(SELECT MAX(s2.checked_at) FROM synthetic_journey_checks s2 WHERE s2.source_site=s.source_site AND s2.check_kind=s.check_kind)
     ORDER BY s.source_site,s.check_kind`,
  ).all<any>()
  const attribution=await env.GROWTH_DB.prepare(
    `SELECT COALESCE(source_site,'unknown') source_site,stage,COUNT(*) total,COALESCE(SUM(value),0) value
     FROM conversion_attribution GROUP BY COALESCE(source_site,'unknown'),stage ORDER BY source_site,stage`,
  ).all<any>()
  return {website_intent:intent.results || [],product:product.results || [],lifecycle:lifecycle.results || [],search:search.results || [],experiments:experiments.results || [],journey_health:journeys.results || [],attribution:attribution.results || []}
}

export async function storeSurfaceDailyMetrics(env: Env) {
  const snapshot=await surfaceSnapshot(env)
  const date=new Date().toISOString().slice(0,10)
  for(const sourceSite of ["gibp.global","gibp.app"] as GibpSite[]){
    const payload={
      website_intent:snapshot.website_intent.filter((x:any)=>x.source_site===sourceSite),
      product:snapshot.product.filter((x:any)=>x.source_site===sourceSite),
      search:snapshot.search.filter((x:any)=>x.source_site===sourceSite),
      experiments:snapshot.experiments.filter((x:any)=>x.source_site===sourceSite),
      attribution:snapshot.attribution.filter((x:any)=>x.source_site===sourceSite),
      journey_health:snapshot.journey_health.filter((x:any)=>x.source_site===sourceSite),
    }
    await env.GROWTH_DB.prepare(
      `INSERT INTO site_daily_metrics(metric_date,source_site,payload_json,created_at,updated_at)
       VALUES (?,?,?,?,?) ON CONFLICT(metric_date,source_site) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`,
    ).bind(date,sourceSite,JSON.stringify(payload),nowIso(),nowIso()).run()
  }
  return snapshot
}
