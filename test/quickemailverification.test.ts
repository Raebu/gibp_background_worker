import { describe, expect, it } from "vitest"
import { qevDailyCap, qevPerRun, qevSafeToSend } from "../src/quickemailverification"

describe("QuickEmailVerification safety gate", () => {
  it("accepts only a valid safe individual mailbox", () => {
    expect(qevSafeToSend({
      result: "valid",
      success: true,
      safe_to_send: true,
      disposable: false,
      accept_all: false,
      role: false,
    })).toBe(true)
  })

  it("rejects role and catch-all mailboxes even when valid", () => {
    expect(qevSafeToSend({
      result: "valid",
      success: true,
      safe_to_send: false,
      role: true,
    })).toBe(false)

    expect(qevSafeToSend({
      result: "valid",
      success: true,
      safe_to_send: false,
      accept_all: true,
    })).toBe(false)
  })

  it("caps the free-tier budget at 100 requests per day", () => {
    expect(qevDailyCap({} as any)).toBe(100)
    expect(qevDailyCap({ QEV_DAILY_CAP: "500" } as any)).toBe(100)
    expect(qevPerRun({ QEV_VERIFICATIONS_PER_RUN: "99" } as any)).toBe(10)
  })
})
