import { describe, expect, it } from "vitest"
import {
  candidateMeetingSlots,
  googleCalendarConfigured,
  googleSearchConsoleConfigured,
} from "../src/google"

describe("native Google growth integrations", () => {
  it("generates three business-day meeting slots outside busy windows", () => {
    const now = Date.parse("2026-10-12T08:00:00Z")
    const busy = [
      { start: "2026-10-12T09:00:00.000Z", end: "2026-10-12T11:30:00.000Z" },
    ]
    const slots = candidateMeetingSlots(busy, {
      nowMs: now,
      timezone: "Europe/London",
      durationMinutes: 45,
      count: 3,
    })

    expect(slots).toHaveLength(3)
    expect(slots.every((slot) => new Date(slot.end).getTime() - new Date(slot.start).getTime() === 45 * 60_000)).toBe(true)
    expect(slots.some((slot) => slot.start === "2026-10-12T09:00:00.000Z")).toBe(false)
  })

  it("does not offer weekend meeting slots", () => {
    const friday = Date.parse("2026-10-16T17:30:00Z")
    const slots = candidateMeetingSlots([], {
      nowMs: friday,
      timezone: "Europe/London",
      durationMinutes: 45,
      count: 3,
    })
    const weekdays = slots.map((slot) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London",
        weekday: "short",
      }).format(new Date(slot.start)),
    )
    expect(weekdays.every((day) => !["Sat", "Sun"].includes(day))).toBe(true)
  })

  it("requires complete Google credentials before integrations activate", () => {
    const base: any = {}
    expect(googleSearchConsoleConfigured(base)).toBe(false)
    expect(googleCalendarConfigured(base)).toBe(false)

    expect(googleSearchConsoleConfigured({
      GSC_GOOGLE_CLIENT_ID: "id",
      GSC_GOOGLE_CLIENT_SECRET: "secret",
      GSC_GOOGLE_REFRESH_TOKEN: "token",
      GSC_SITE_URL: "sc-domain:gibp.global",
    } as any)).toBe(true)

    expect(googleCalendarConfigured({
      CALENDAR_GOOGLE_CLIENT_ID: "id",
      CALENDAR_GOOGLE_CLIENT_SECRET: "secret",
      CALENDAR_GOOGLE_REFRESH_TOKEN: "token",
      GOOGLE_CALENDAR_ID: "martin@theraeburngroup.com",
    } as any)).toBe(true)
  })
})
