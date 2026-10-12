import { describe, expect, it } from "vitest"
declare const require: (name: string) => { readFileSync(path: string, encoding: string): string }
const fs = require("fs")

describe("contact email persistence", () => {
  it("deduplicates expression-indexed emails explicitly instead of relying on UPSERT inference", () => {
    const apollo = fs.readFileSync("src/apollo.ts", "utf8")
    const discovery = fs.readFileSync("src/discovery.ts", "utf8")
    const engine = fs.readFileSync("src/engine.ts", "utf8")
    const migration = fs.readFileSync("migrations/0001_initial.sql", "utf8")

    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON contacts(lower(email))")
    for (const source of [apollo, discovery, engine]) {
      expect(source).toContain("SELECT id FROM contacts WHERE lower(email)=lower(?) LIMIT 1")
      expect(source).not.toContain("ON CONFLICT(email) DO UPDATE")
    }

    expect(apollo).not.toContain("third_party_professional_data_review_required','research_only',?,?)\n       ON CONFLICT DO UPDATE SET")
    expect(discovery).not.toContain("corporate_b2b_public_professional', 'active', ?, ?)\n           ON CONFLICT DO UPDATE SET")
  })
})
