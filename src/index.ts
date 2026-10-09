import type { Env, GrowthJob } from "./types"
import { handleResendEvent, importData, metrics, recordWebsiteIntent, runQueueJob, runTick } from "./engine"
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
        queue: Boolean(env.GROWTH_QUEUE),
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
    const sales = await env.GROWTH_DB.prepare(
      `SELECT h.*,a.name AS account_name,ct.name AS contact_name,ct.role,ct.email
       FROM handoffs h
       JOIN accounts a ON a.id=h.account_id
       JOIN contacts ct ON ct.id=h.contact_id
       WHERE h.status='ready'
       ORDER BY CASE h.priority WHEN 'high' THEN 0 ELSE 1 END, h.created_at DESC
       LIMIT 100`,
    ).all()

    const procurement = await env.GROWTH_DB.prepare(
      `SELECT h.*,o.title,o.buyer_name,o.source,o.source_url,o.deadline,o.score
       FROM opportunity_handoffs h
       JOIN opportunities o ON o.id=h.opportunity_id
       WHERE h.status='ready'
       ORDER BY CASE h.priority WHEN 'high' THEN 0 ELSE 1 END, h.created_at DESC
       LIMIT 100`,
    ).all()

    return json({
      sales: sales.results || [],
      procurement: procurement.results || [],
    })
  }

  if (path === "/admin/opportunities" && request.method === "GET") {
    const rows = await env.GROWTH_DB.prepare(
      `SELECT id,kind,title,source,source_url,buyer_name,country_code,deadline,
              estimated_value,currency,score,status,summary,created_at,updated_at
       FROM opportunities
       WHERE status IN ('new','qualified','handoff','monitor')
       ORDER BY CASE status WHEN 'handoff' THEN 0 WHEN 'qualified' THEN 1 ELSE 2 END,
                score DESC,
                COALESCE(deadline,'9999-12-31') ASC
       LIMIT 200`,
    ).all()
    return json(rows.results || [])
  }

  if (path === "/admin/enqueue" && request.method === "POST") {
    const jobs: GrowthJob[] = [
      { kind: "discovery" },
      { kind: "procurement" },
      { kind: "research" },
      { kind: "conversations" },
      { kind: "outreach" },
      { kind: "maintenance" },
    ]
    await env.GROWTH_QUEUE.sendBatch(jobs.map((body) => ({ body })))
    return json({ queued: jobs.map((job) => job.kind) })
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
    const jobs: GrowthJob[] = [
      { kind: "discovery" },
      { kind: "procurement" },
      { kind: "research" },
      { kind: "conversations" },
      { kind: "outreach" },
      { kind: "maintenance" },
    ]

    ctx.waitUntil(
      env.GROWTH_QUEUE.sendBatch(jobs.map((body) => ({ body }))).catch((error) =>
        console.error("Unable to enqueue GIBP growth jobs", error instanceof Error ? error.stack : error),
      ),
    )
  },

  async queue(batch: MessageBatch<GrowthJob>, env: Env) {
    for (const message of batch.messages) {
      try {
        await runQueueJob(env, message.body.kind)
        message.ack()
      } catch (error) {
        console.error(
          `GIBP growth queue job failed: ${message.body.kind}`,
          error instanceof Error ? error.stack : error,
        )
        message.retry()
      }
    }
  },
} satisfies ExportedHandler<Env, GrowthJob>
