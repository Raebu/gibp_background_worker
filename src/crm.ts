import type { Env } from "./types"
import { id, nowIso } from "./db"

function provider(env: Env) {
  return String(env.CRM_PROVIDER || "").trim().toLowerCase()
}

export function crmConfigured(env: Env) {
  const p = provider(env)
  if (p === "webhook") return Boolean(env.CRM_WEBHOOK_URL)
  if (p === "hubspot") return Boolean(env.HUBSPOT_PRIVATE_APP_TOKEN)
  if (p === "salesforce") return Boolean(env.SALESFORCE_INSTANCE_URL && env.SALESFORCE_ACCESS_TOKEN)
  return false
}

async function sha256(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function requestJson(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
  const payload = await response.json().catch(() => ({})) as any
  if (!response.ok) throw new Error(`crm_http_${response.status}:${JSON.stringify(payload).slice(0,1000)}`)
  return payload
}

async function webhookUpsert(env: Env, entityType: string, entityId: string, payload: any) {
  if (!env.CRM_WEBHOOK_URL) throw new Error("crm_webhook_not_configured")
  const response = await requestJson(env.CRM_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.CRM_WEBHOOK_SECRET ? { Authorization: `Bearer ${env.CRM_WEBHOOK_SECRET}` } : {}),
    },
    body: JSON.stringify({
      action: "upsert",
      entity_type: entityType,
      entity_id: entityId,
      payload,
    }),
  })
  return String(response.external_id || response.id || entityId)
}

async function hubspotFind(env: Env, object: "companies" | "contacts", property: string, value: string) {
  const base = `https://api.hubapi.com/crm/v3/objects/${object}/search`
  const payload = await requestJson(base, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.HUBSPOT_PRIVATE_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }],
      properties: [property],
      limit: 1,
    }),
  })
  return payload.results?.[0]?.id ? String(payload.results[0].id) : null
}

async function hubspotUpsert(env: Env, entityType: string, payload: any, externalId?: string | null) {
  if (!env.HUBSPOT_PRIVATE_APP_TOKEN) throw new Error("hubspot_not_configured")
  if (entityType === "account") {
    const found = externalId || (payload.domain ? await hubspotFind(env, "companies", "domain", payload.domain) : null)
    const properties = {
      name: payload.name,
      domain: payload.domain || undefined,
      country: payload.country_code || undefined,
      type: payload.account_type || undefined,
    }
    if (found) {
      await requestJson(`https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(found)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${env.HUBSPOT_PRIVATE_APP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties }),
      })
      return found
    }
    const created = await requestJson("https://api.hubapi.com/crm/v3/objects/companies", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.HUBSPOT_PRIVATE_APP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties }),
    })
    return String(created.id)
  }

  if (entityType === "contact") {
    const found = externalId || await hubspotFind(env, "contacts", "email", payload.email)
    const [firstName, ...rest] = String(payload.name || "").trim().split(/\s+/)
    const properties = {
      email: payload.email,
      firstname: firstName || undefined,
      lastname: rest.join(" ") || undefined,
      jobtitle: payload.role || undefined,
    }
    if (found) {
      await requestJson(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(found)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${env.HUBSPOT_PRIVATE_APP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties }),
      })
      return found
    }
    const created = await requestJson("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.HUBSPOT_PRIVATE_APP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ properties }),
    })
    return String(created.id)
  }

  throw new Error("hubspot_entity_requires_webhook_bridge")
}

async function salesforceUpsert(env: Env, entityType: string, payload: any, externalId?: string | null) {
  if (!env.SALESFORCE_INSTANCE_URL || !env.SALESFORCE_ACCESS_TOKEN) throw new Error("salesforce_not_configured")
  const root = env.SALESFORCE_INSTANCE_URL.replace(/\/$/, "")
  const headers = {
    Authorization: `Bearer ${env.SALESFORCE_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  }

  if (entityType === "account") {
    if (externalId) {
      await requestJson(`${root}/services/data/v61.0/sobjects/Account/${encodeURIComponent(externalId)}`, {
        method: "PATCH", headers, body: JSON.stringify({ Name: payload.name, Website: payload.domain ? `https://${payload.domain}` : undefined }),
      })
      return externalId
    }
    const created = await requestJson(`${root}/services/data/v61.0/sobjects/Account`, {
      method: "POST", headers, body: JSON.stringify({ Name: payload.name, Website: payload.domain ? `https://${payload.domain}` : undefined }),
    })
    return String(created.id)
  }

  if (entityType === "contact") {
    if (externalId) {
      await requestJson(`${root}/services/data/v61.0/sobjects/Contact/${encodeURIComponent(externalId)}`, {
        method: "PATCH", headers, body: JSON.stringify({ Email: payload.email, Title: payload.role || undefined }),
      })
      return externalId
    }
    const created = await requestJson(`${root}/services/data/v61.0/sobjects/Contact`, {
      method: "POST", headers, body: JSON.stringify({ LastName: payload.name || payload.email, Email: payload.email, Title: payload.role || undefined }),
    })
    return String(created.id)
  }

  throw new Error("salesforce_entity_requires_webhook_bridge")
}

async function syncOne(env: Env, entityType: string, entityId: string, payload: any) {
  const p = provider(env)
  const serialized = JSON.stringify(payload)
  const hash = await sha256(serialized)
  const existing = await env.GROWTH_DB.prepare(
    `SELECT * FROM crm_sync_records WHERE provider=? AND entity_type=? AND entity_id=?`,
  ).bind(p, entityType, entityId).first<any>()
  if (existing?.payload_hash === hash && existing?.status === "synced") return { skipped: true }

  try {
    let externalId: string
    if (p === "webhook") externalId = await webhookUpsert(env, entityType, entityId, payload)
    else if (p === "hubspot") externalId = await hubspotUpsert(env, entityType, payload, existing?.external_id)
    else if (p === "salesforce") externalId = await salesforceUpsert(env, entityType, payload, existing?.external_id)
    else throw new Error("crm_provider_not_supported")

    await env.GROWTH_DB.prepare(
      `INSERT INTO crm_sync_records
       (id,provider,entity_type,entity_id,external_id,direction,payload_hash,status,last_synced_at,last_error,updated_at)
       VALUES (?,?,?,?,?,'outbound',?,'synced',?,NULL,?)
       ON CONFLICT(provider,entity_type,entity_id) DO UPDATE SET
         external_id=excluded.external_id,payload_hash=excluded.payload_hash,status='synced',
         last_synced_at=excluded.last_synced_at,last_error=NULL,updated_at=excluded.updated_at`,
    ).bind(id(), p, entityType, entityId, externalId, hash, nowIso(), nowIso()).run()
    return { synced: true, external_id: externalId }
  } catch (error) {
    await env.GROWTH_DB.prepare(
      `INSERT INTO crm_sync_records
       (id,provider,entity_type,entity_id,direction,payload_hash,status,last_error,updated_at)
       VALUES (?,?,?,?,'outbound',?,'failed',?,?)
       ON CONFLICT(provider,entity_type,entity_id) DO UPDATE SET
         payload_hash=excluded.payload_hash,status='failed',last_error=excluded.last_error,updated_at=excluded.updated_at`,
    ).bind(
      id(), p, entityType, entityId, hash,
      String(error instanceof Error ? error.message : error).slice(0,3000),
      nowIso(),
    ).run()
    throw error
  }
}

export async function syncCrm(env: Env) {
  if (!crmConfigured(env)) return { skipped: true, reason: "crm_not_configured" }
  const p = provider(env)
  const accounts = await env.GROWTH_DB.prepare(
    `SELECT id,name,domain,country_code,account_type,pipeline,status,score,updated_at
     FROM accounts ORDER BY updated_at DESC LIMIT 40`,
  ).all<any>()
  const contacts = await env.GROWTH_DB.prepare(
    `SELECT id,account_id,name,role,email,country_code,status,updated_at
     FROM contacts WHERE status IN ('active','suppressed') ORDER BY updated_at DESC LIMIT 60`,
  ).all<any>()

  let synced = 0
  let skipped = 0
  let failed = 0
  for (const row of accounts.results || []) {
    try {
      const result = await syncOne(env, "account", row.id, row)
      result.skipped ? skipped++ : synced++
    } catch { failed++ }
  }
  for (const row of contacts.results || []) {
    try {
      const result = await syncOne(env, "contact", row.id, row)
      result.skipped ? skipped++ : synced++
    } catch { failed++ }
  }

  if (p === "webhook") {
    const outcomes = await env.GROWTH_DB.prepare(
      `SELECT * FROM commercial_outcomes ORDER BY created_at DESC LIMIT 40`,
    ).all<any>()
    for (const row of outcomes.results || []) {
      try {
        const result = await syncOne(env, "commercial_outcome", row.id, row)
        result.skipped ? skipped++ : synced++
      } catch { failed++ }
    }
  }

  return { provider: p, synced, skipped, failed }
}

export async function ingestCrmEvent(env: Env, body: any) {
  const p = String(body?.provider || provider(env) || "webhook").toLowerCase()
  const eventKey = String(body?.event_key || body?.id || "").trim()
  if (!eventKey) throw new Error("crm_event_key_required")

  const claim = await env.GROWTH_DB.prepare(
    `INSERT OR IGNORE INTO crm_inbound_events
      (event_key,provider,payload_json,status,received_at)
     VALUES (?,?,?,'processing',?)`,
  ).bind(eventKey, p, JSON.stringify(body).slice(0,30000), nowIso()).run()
  if (!Number(claim.meta?.changes || 0)) return { duplicate: true }

  try {
    const type = String(body.entity_type || "")
    const entityId = String(body.entity_id || "")
    const values = body.values && typeof body.values === "object" ? body.values : {}

    if (type === "account_governance" && entityId) {
      await env.GROWTH_DB.prepare(
        `INSERT INTO account_governance
          (account_id,never_contact,manual_review_required,manual_review_approved_at,vip,strategic_account,owner,notes,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET
           never_contact=excluded.never_contact,
           manual_review_required=excluded.manual_review_required,
           manual_review_approved_at=excluded.manual_review_approved_at,
           vip=excluded.vip,strategic_account=excluded.strategic_account,
           owner=excluded.owner,notes=excluded.notes,updated_at=excluded.updated_at`,
      ).bind(
        entityId,
        values.never_contact ? 1 : 0,
        values.manual_review_required ? 1 : 0,
        values.manual_review_approved_at || null,
        values.vip ? 1 : 0,
        values.strategic_account ? 1 : 0,
        values.owner || null,
        values.notes || null,
        nowIso(),
      ).run()
    } else if (type === "contact" && entityId) {
      await env.GROWTH_DB.prepare(
        `UPDATE contacts SET
          name=COALESCE(?,name),role=COALESCE(?,role),
          identity_verified_at=CASE WHEN ? IS NOT NULL THEN ? ELSE identity_verified_at END,
          role_verified_at=CASE WHEN ? IS NOT NULL THEN ? ELSE role_verified_at END,
          updated_at=?
         WHERE id=?`,
      ).bind(
        values.name || null,
        values.role || null,
        values.name || null,
        nowIso(),
        values.role || null,
        nowIso(),
        nowIso(),
        entityId,
      ).run()
    } else {
      throw new Error("unsupported_crm_inbound_entity")
    }

    await env.GROWTH_DB.prepare(
      "UPDATE crm_inbound_events SET status='processed',processed_at=? WHERE event_key=?",
    ).bind(nowIso(), eventKey).run()
    return { processed: true, event_key: eventKey }
  } catch (error) {
    await env.GROWTH_DB.prepare(
      "UPDATE crm_inbound_events SET status='failed',error=? WHERE event_key=?",
    ).bind(String(error instanceof Error ? error.message : error).slice(0,3000), eventKey).run()
    throw error
  }
}

export async function crmSnapshot(env: Env) {
  const rows = await env.GROWTH_DB.prepare(
    `SELECT provider,status,entity_type,COUNT(*) AS total,MAX(last_synced_at) AS last_synced_at
     FROM crm_sync_records GROUP BY provider,status,entity_type
     ORDER BY provider,entity_type,status`,
  ).all<any>()
  return { configured: crmConfigured(env), provider: provider(env) || null, rows: rows.results || [] }
}
