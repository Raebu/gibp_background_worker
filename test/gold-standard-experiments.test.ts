import { describe, expect, it } from "vitest"
import { applyInitialExperimentCopy } from "../src/experiments"

const account: any = {
  id: "a1",
  name: "Example Bank",
  pipeline: "direct",
}

describe("gold-standard outreach experiments", () => {
  it("keeps the control copy unchanged", () => {
    const copy = { subject: "Original subject", text: "Original body?" }
    const result = applyInitialExperimentCopy(copy, account, {
      variant_key: "control",
      assignment_id: "assign-control",
    })
    expect(result.subject).toBe("Original subject")
    expect(result.text).toBe("Original body?")
    expect(result.experiment.variant_key).toBe("control")
  })

  it("applies the priority variant without increasing message count", () => {
    const copy = {
      subject: "A possible fit",
      text: "Hello. Would it be useful if I sent a short architecture overview?",
    }
    const result = applyInitialExperimentCopy(copy, account, {
      variant_key: "priority",
      assignment_id: "assign-priority",
    })
    expect(result.subject).toContain("Institutional payments priorities")
    expect(result.text).toContain("short benchmark")
    expect(result.experiment.assignment_id).toBe("assign-priority")
  })
})
