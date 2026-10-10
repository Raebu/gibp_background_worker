import { describe, expect, it } from "vitest"
import { workingTimeDecision } from "../src/lifecycle"
import { scoreAssessmentAnswers } from "../src/experience"
import { topicKeyForSignal } from "../src/learning"
import { normalizeBuyingSignalKind } from "../src/discovery"

describe("autonomous revenue OS", () => {
  it("keeps outreach inside recipient working hours", () => {
    const contact = { timezone: "UTC", country_code: "GB" }
    const account = { country_code: "GB" }
    const monday = Date.parse("2026-10-12T10:00:00Z")
    const saturday = Date.parse("2026-10-10T10:00:00Z")

    expect(workingTimeDecision(contact as any, account as any, monday).allowed).toBe(true)
    const weekend = workingTimeDecision(contact as any, account as any, saturday)
    expect(weekend.allowed).toBe(false)
    expect(weekend.next_action_at.startsWith("2026-10-12T09:")).toBe(true)
  })

  it("scores lead-magnet assessments deterministically", () => {
    const fields: Array<[string, string]> = [
      ["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"], ["e", "E"], ["f", "F"],
    ]
    expect(scoreAssessmentAnswers({ a:5,b:5,c:5,d:5,e:5,f:5 }, fields)).toBe(100)
    expect(scoreAssessmentAnswers({ a:0,b:0,c:0,d:0,e:0,f:0 }, fields)).toBe(0)
    expect(scoreAssessmentAnswers({ a:3,b:3,c:3,d:3,e:3,f:3 }, fields)).toBe(60)
  })

  it("normalises buying-signal taxonomy", () => {
    expect(normalizeBuyingSignalKind("iso 20022", "Programme")).toBe("iso_20022")
    expect(normalizeBuyingSignalKind("", "Bank launches instant payments programme")).toBe("instant_payments")
    expect(normalizeBuyingSignalKind("", "New Head of Payments appointed")).toBe("executive_change")
  })

  it("groups authority signals by market theme", () => {
    expect(topicKeyForSignal("ISO 20022 migration expands")).toBe("iso-20022")
    expect(topicKeyForSignal("Cross-border correspondent banking overhaul")).toBe("cross-border-payments")
    expect(topicKeyForSignal("Stablecoin settlement initiative")).toBe("digital-money")
  })
})
