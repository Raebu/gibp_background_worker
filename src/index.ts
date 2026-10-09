import type { Env } from "./types"
import { handleResendEvent, importData, metrics, recordWebsiteIntent, runTick } from "./engine"
import { isAuthorized, isSiteAuthorized, readUnsubscribeToken, verifyResendWebhook } from "./security"
import { nowIso } from "./db"

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

function unauthorized() {
  return json({ error: "unauthorized" }, 401)
}

async function bodyJson(request: Request) {
  try {
    return await request.json()
  } catch {
    return null
  }
}

async function handleAdmin(request: Request, env: Env, path: string) {
  if (!isAuthorized(request, env)) return unauthorized()

  if (path === "/admin/status" && request.method === "GET") {
    return json({
      ok: true,
      send_mode: env.SEND_MODE || "dry_run",
      metrics: await metrics(env),
      config: {
        d1: true,
        ai: Boolean(env.AI),
        resend: Boolean(env.RESEND_API_KEY),
        webhook_verification: Boolean(env.RESEND_WEBHOOK_SECRET),
        unsubscribe: Boolean(env.UNSUBSCRIBE_SECRET),
        postal_address: Boolean(env.BUSINESS_POSTAL_ADDRESS),
        handoff: Boolean(env.HANDOFF_TO || env.HANDOFF_WEBHOOK_URL),
      },
    })
  }

  if (path === "/admin/handoffs" && request.method === "GET") {
    const rows = await env.GROWTH_DB.prepare(
      `SELECT h.*,a.name AS account_name,ct.name AS contact_name,ct.role,ct.email
       FROM handoffs h
       JOIN accounts a ON a.id=h.account_id
       JOIN contacts ct ON ct.id=h.contact_id
       WHERE h.status='ready'
       ORDER BY CASE h.priority WHEN 'high' THEN 0 ELSE 1 END, h.created_at DESC
       LIMIT 100`,
    ).all()
    return json(rows.results || [])
  }

  if (path === "/admin/run" && request.method === "POST") {
    return json(await runTick(env))
  }

  if (path === "/admin/import" && request.method === "POST") {
    const body = await bodyJson(request)
    if (!body) return json({ error: "invalid_json" }, 400)
    return json(await importData(env, body))
  }

  if (path === "/admin/policy" && request.method === "POST") {
    const body = (await bodyJson(request)) as any
    if (!body?.country_code) return json({ error: "country_code_required" }, 400)
    await env.GROWTH_DB.prepare(
      `INSERT INTO jurisdiction_policies
        (country_code,mode,allowed,requires_consent,allow_corporate_b2b,max_initial_per_day,notes,updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(country_code) DO UPDATE SET
        mode=excluded.mode,allowed=excluded.allowed,requires_consent=excluded.requires_consent,
        allow_corporate_b2b=excluded.allow_corporate_b2b,max_initial_per_day=excluded.max_initial_per_day,
        notes=excluded.notes,updated_at=excluded.updated_at`,
    )
      .bind(
        String(body.country_code).toUpperCase(),
        body.mode || "monitor_only",
        body.allowed ? 1 : 0,
        body.requires_consent ? 1 : 0,
        body.allow_corporate_b2b ? 1 : 0,
        Number(body.max_initial_per_day || 0),
        body.notes || null,
        nowIso(),
      )
      .run()
    return json({ ok: true })
  }

  return json({ error: "not_found" }, 404)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/health") {
      return json({ ok: true, service: "gibp-background-worker", mode: env.SEND_MODE || "dry_run" })
    }

    if (url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, url.pathname)
    }

    if (url.pathname === "/webhooks/resend" && request.method === "POST") {
      const raw = await request.text()
      if (!(await verifyResendWebhook(request, env, raw))) {
        return json({ error: "invalid_signature" }, 401)
      }
      let event: unknown
      try {
        event = JSON.parse(raw)
      } catch {
        return json({ error: "invalid_json" }, 400)
      }
      return json(await handleResendEvent(env, event))
    }

    if (url.pathname === "/events/website" && request.method === "POST") {
      if (!isSiteAuthorized(request, env)) return unauthorized()
      const body = await bodyJson(request)
      if (!body) return json({ error: "invalid_json" }, 400)
      return json(await recordWebsiteIntent(env, body))
    }

    if (url.pathname === "/unsubscribe" && request.method === "GET") {
      const token = url.searchParams.get("token") || ""
      const email = await readUnsubscribeToken(token, env)
      if (!email) return new Response("Invalid or expired unsubscribe link.", { status: 400 })
      await env.GROWTH_DB.prepare(
        "INSERT OR REPLACE INTO suppressions (email,reason,source,created_at) VALUES (?,'recipient_unsubscribe','link',?)",
      )
        .bind(email, nowIso())
        .run()
      await env.GROWTH_DB.prepare(
        "UPDATE contacts SET status='suppressed', updated_at=? WHERE lower(email)=lower(?)",
      )
        .bind(nowIso(), email)
        .run()
      return new Response("You have been unsubscribed from GIBP commercial outreach.", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    }

    return json({ error: "not_found" }, 404)
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runTick(env).catch((error) =>
        console.error("GIBP growth tick failed", error instanceof Error ? error.stack : error),
      ),
    )
  },
} satisfies ExportedHandler<Env>
