import { afterEach, describe, expect, it, vi } from "vitest"
import { sendResend } from "../src/email"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("one-click unsubscribe", () => {
  it("adds RFC one-click headers to live commercial email", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify({ id: "em_test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const env: any = {
      SEND_MODE: "live",
      RESEND_API_KEY: "re_test",
      OUTBOUND_FROM_EMAIL: "GIBP <partnerships@gibp.global>",
      PUBLIC_BASE_URL: "https://growth.gibp.global",
      UNSUBSCRIBE_SECRET: "test-secret",
      BUSINESS_POSTAL_ADDRESS: "1 Test Street, London, UK",
    }

    await sendResend(env, {
      to: "person@example.com",
      subject: "Test",
      text: "Hello",
      idempotencyKey: "test-key",
    })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(String(init.body))
    expect(body.headers["List-Unsubscribe"]).toMatch(
      /^<https:\/\/growth\.gibp\.global\/unsubscribe\?token=/,
    )
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    expect((init.headers as Record<string,string>)["Idempotency-Key"]).toBe("test-key")
  })
})
