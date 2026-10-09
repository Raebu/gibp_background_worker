import { describe, expect, it } from "vitest"
import { computeNextRampCap } from "../src/ramp"

describe("sender reputation ramp", () => {
  it("holds the starting cap until enough real sends exist", () => {
    expect(
      computeNextRampCap(
        { initialSent: 10, inboundReplies: 2, positiveReplies: 2, bounces: 0, complaints: 0 },
        5,
        5,
        20,
      ),
    ).toBe(5)
  })

  it("ramps gradually when quality is healthy", () => {
    expect(
      computeNextRampCap(
        { initialSent: 50, inboundReplies: 8, positiveReplies: 4, bounces: 0, complaints: 0 },
        5,
        5,
        20,
      ),
    ).toBe(10)
  })

  it("reduces volume on sender reputation risk", () => {
    expect(
      computeNextRampCap(
        { initialSent: 100, inboundReplies: 4, positiveReplies: 2, bounces: 4, complaints: 0 },
        15,
        5,
        20,
      ),
    ).toBe(10)
  })

  it("never increases after a complaint", () => {
    expect(
      computeNextRampCap(
        { initialSent: 100, inboundReplies: 10, positiveReplies: 8, bounces: 0, complaints: 1 },
        10,
        5,
        20,
      ),
    ).toBe(5)
  })
})
