import { afterEach, describe, expect, it, vi } from "vitest"
import { verifySupabaseProductUser } from "../src/security"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Supabase-authenticated product events", () => {
  it("accepts a valid Supabase user access token", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify({ id: "user-123", email: "Person@Example.com" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const request = new Request("https://growth.gibp.global/events/product", {
      headers: { Authorization: "Bearer user-jwt" },
    })
    const user = await verifySupabaseProductUser(request, {
      SUPABASE_AUTH_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    } as any)

    expect(user).toEqual({ id: "user-123", email: "person@example.com" })
    const [, init] = fetchMock.mock.calls[0]
    expect((init?.headers as Record<string,string>).apikey).toBe("sb_publishable_test")
    expect((init?.headers as Record<string,string>).Authorization).toBe("Bearer user-jwt")
  })

  it("does not reinterpret the internal site token as a user token", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const request = new Request("https://growth.gibp.global/events/product", {
      headers: { Authorization: "Bearer internal-token" },
    })
    const user = await verifySupabaseProductUser(request, {
      SITE_EVENT_TOKEN: "internal-token",
      SUPABASE_AUTH_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    } as any)

    expect(user).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a token that Supabase Auth rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })))
    const request = new Request("https://growth.gibp.global/events/product", {
      headers: { Authorization: "Bearer invalid" },
    })
    const user = await verifySupabaseProductUser(request, {
      SUPABASE_AUTH_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    } as any)
    expect(user).toBeNull()
  })
})
