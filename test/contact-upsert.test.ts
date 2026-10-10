import { describe, expect, it } from "vitest"
import fs from "node:fs"

describe("contact email upserts", () => {
  it("use targetless UPSERT with the lower(email) unique expression index", () => {
    const apollo = fs.readFileSync("src/apollo.ts", "utf8")
    const discovery = fs.readFileSync("src/discovery.ts", "utf8")
    const migration = fs.readFileSync("migrations/0001_initial.sql", "utf8")

    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON contacts(lower(email))")
    expect(apollo).not.toContain("ON CONFLICT(email) DO UPDATE")
    expect(discovery).not.toContain("ON CONFLICT(email) DO UPDATE")
    expect(apollo).toContain("ON CONFLICT DO UPDATE")
    expect(discovery).toContain("ON CONFLICT DO UPDATE")
  })
})
