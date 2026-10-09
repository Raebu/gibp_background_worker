import type { Env } from "./types"

export const nowIso = () => new Date().toISOString()
export const id = () => crypto.randomUUID()

export function daysFromNow(days: number) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString()
}

export async function audit(
  env: Env,
  category: string,
  action: string,
  entityType?: string,
  entityId?: string,
  detail: unknown = {},
) {
  await env.GROWTH_DB.prepare(
    `INSERT INTO audit_events
      (id, category, action, entity_type, entity_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id(), category, action, entityType || null, entityId || null, JSON.stringify(detail), nowIso())
    .run()
}

export async function getSetting(env: Env, key: string) {
  const row = await env.GROWTH_DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}

export async function setSetting(env: Env, key: string, value: string) {
  await env.GROWTH_DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  )
    .bind(key, value, nowIso())
    .run()
}

export async function countToday(env: Env, sql: string, ...params: unknown[]) {
  const row = await env.GROWTH_DB.prepare(sql).bind(...params).first<{ total: number }>()
  return Number(row?.total || 0)
}
