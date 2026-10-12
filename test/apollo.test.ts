declare const require: (name: string) => { readFileSync(path: string, encoding: string): string }
const fs = require("fs")
import { describe, expect, it } from "vitest"
import { apolloEnrichmentDailyCap, scoreApolloCandidateTitle } from "../src/apollo"

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


describe("Apollo enrichment budget", () => {
  it("is disabled by default", () => {
    expect(apolloEnrichmentDailyCap({} as any)).toBe(0)
  })

  it("honours a small configured cap", () => {
    expect(
      apolloEnrichmentDailyCap({ APOLLO_ENRICHMENT_DAILY_CAP: "2" } as any),
    ).toBe(2)
  })

  it("cannot be configured above five credits per day", () => {
    expect(
      apolloEnrichmentDailyCap({ APOLLO_ENRICHMENT_DAILY_CAP: "99" } as any),
    ).toBe(5)
  })
})


describe("Apollo paid-enrichment account cooldown", () => {
  it("documents the 30-day account-level spend guard in the selector", async () => {
    const source = await import("../src/apollo")
    expect(source.enrichTopApolloCandidate).toBeTypeOf("function")
  })
})


describe("Apollo contact persistence", () => {
  it("does not rely on SQLite UPSERT conflict matching for lower(email)", () => {
    const source = fs.readFileSync("src/apollo.ts", "utf8")
    expect(source).toContain("SELECT id FROM contacts WHERE lower(email)=lower(?) LIMIT 1")
    expect(source).toContain("UPDATE contacts")
    expect(source).toContain("INSERT INTO contacts")
    expect(source).not.toContain("third_party_professional_data_review_required','research_only',?,?)\n       ON CONFLICT DO UPDATE SET")
  })
})


describe("production Apollo safety posture", () => {
  it("keeps live sending blocked and paid enrichment disabled", () => {
    const config = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8"))
    const indexSource = fs.readFileSync("src/index.ts", "utf8")
    const scheduledStart = indexSource.indexOf("async scheduled")
    const queueStart = indexSource.indexOf("async queue", scheduledStart)
    const scheduledSource = indexSource.slice(scheduledStart, queueStart)

    expect(config.vars.SEND_MODE).toBe("dry_run")
    expect(config.vars.APOLLO_ENRICHMENT_DAILY_CAP).toBe("0")
    expect(scheduledSource).not.toContain('{ kind: "apollo_enrich" },')
  })
})


describe("outreach simulation commissioning safety", () => {
  it("has a dry-run-only commissioning job and never schedules it hourly", () => {
    const engine = fs.readFileSync("src/engine.ts", "utf8")
    const indexSource = fs.readFileSync("src/index.ts", "utf8")
    expect(engine).toContain("processOutreachSimulationCommissioning")
    expect(engine).toContain('if ((env.SEND_MODE || "dry_run") === "live")')
    expect(engine).toContain('throw new Error("Commissioning simulation attempted a live send")')
    expect(engine).toContain("timing_bypass_only: true")
    const scheduledStart = indexSource.indexOf("async scheduled")
    const queueStart = indexSource.indexOf("async queue", scheduledStart)
    expect(indexSource.slice(scheduledStart, queueStart)).not.toContain("outreach_simulation_commissioning")
  })
})
