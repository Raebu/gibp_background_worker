import { describe, expect, it } from "vitest"
import { scoreApolloCandidateTitle } from "../src/apollo"

describe("Apollo candidate title scoring", () => {
  it("prioritises payments and transaction-banking decision-makers", () => {
    expect(scoreApolloCandidateTitle("Head of Payments")).toBe(100)
    expect(scoreApolloCandidateTitle("Director, Transaction Banking")).toBe(98)
    expect(scoreApolloCandidateTitle("Treasury Director")).toBe(95)
  })

  it("keeps adjacent executive technology and partnership roles eligible", () => {
    expect(scoreApolloCandidateTitle("Chief Technology Officer")).toBeGreaterThanOrEqual(90)
    expect(scoreApolloCandidateTitle("Head of Partnerships")).toBeGreaterThanOrEqual(80)
    expect(scoreApolloCandidateTitle("Chief Operating Officer")).toBeGreaterThanOrEqual(75)
  })

  it("rejects unrelated senior roles", () => {
    expect(scoreApolloCandidateTitle("Vice President, Human Resources")).toBe(0)
    expect(scoreApolloCandidateTitle("Marketing Director")).toBe(0)
    expect(scoreApolloCandidateTitle("Chief Legal Officer")).toBe(0)
  })
})
