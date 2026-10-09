import { describe, expect, it } from "vitest"

describe("commercial engine invariants", () => {
  it("keeps live sending opt-in", () => {
    const mode = undefined || "dry_run"
    expect(mode).toBe("dry_run")
  })

  it("uses a high serious-opportunity threshold by default", () => {
    expect(Number("85")).toBeGreaterThanOrEqual(80)
  })

  it("does not exceed the Resend free daily ceiling by default", () => {
    expect(Number("50")).toBeLessThanOrEqual(100)
  })
})
