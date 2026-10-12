import { describe, expect, it } from "vitest"
import { reputationPauseReasons, webhookDedupeKey } from "../src/operations"

describe("live operations hardening", () => {
  it("trips immediately on a complaint", () => {
    const result = reputationPauseReasons(
      { sent: 1, bounces: 0, complaints: 1, qevExceptions: 0, deadLetters: 0 },
      50,
    )
    expect(result.reasons).toContain("complaint_detected")
  })

  it("trips on sustained bounce risk but not a single isolated bounce", () => {
    expect(
      reputationPauseReasons(
        { sent: 20, bounces: 2, complaints: 0, qevExceptions: 0, deadLetters: 0 },
        50,
      ).reasons,
    ).toContain("bounce_rate_high")

    expect(
      reputationPauseReasons(
        { sent: 20, bounces: 1, complaints: 0, qevExceptions: 0, deadLetters: 0 },
        50,
      ).reasons,
    ).not.toContain("bounce_rate_high")
  })

  it("trips on repeated verification or critical queue failures", () => {
    expect(
      reputationPauseReasons(
        { sent: 5, bounces: 0, complaints: 0, qevExceptions: 5, deadLetters: 2 },
        50,
      ).reasons,
    ).toEqual(expect.arrayContaining(["qev_degraded", "critical_queue_failures"]))
  })

  it("recognises a daily cap breach", () => {
    expect(
      reputationPauseReasons(
        { sent: 51, bounces: 0, complaints: 0, qevExceptions: 0, deadLetters: 0 },
        50,
      ).reasons,
    ).toContain("daily_cap_exceeded")
  })

  it("deduplicates inbound and provider events with stable keys", () => {
    expect(webhookDedupeKey({ id: "evt_123", type: "email.opened", data: {} }))
      .toBe("event:evt_123")
    expect(webhookDedupeKey({ type: "email.received", data: { email_id: "em_123" } }))
      .toBe("received:em_123")
    expect(
      webhookDedupeKey({
        type: "suppression.added",
        data: { email: "Person@Example.com", reason: "complaint" },
      }),
    ).toBe("suppression:person@example.com:complaint")
  })
})
