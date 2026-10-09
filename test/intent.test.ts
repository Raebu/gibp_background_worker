import { describe, expect, it } from "vitest"
import { makeIntentToken, readIntentToken } from "../src/security"

describe("website intent token", () => {
  it("round-trips signed attribution claims", async () => {
    const env = { INTENT_SIGNING_SECRET: "test-secret" } as any
    const token = await makeIntentToken("conversation-1", "account-1", env, 1)
    await expect(readIntentToken(token, env)).resolves.toMatchObject({
      v: 1,
      c: "conversation-1",
      a: "account-1",
    })
  })

  it("rejects tampering", async () => {
    const env = { INTENT_SIGNING_SECRET: "test-secret" } as any
    const token = await makeIntentToken("conversation-1", "account-1", env, 1)
    await expect(readIntentToken(token + "x", env)).resolves.toBeNull()
  })
})
