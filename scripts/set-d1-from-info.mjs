import { readFileSync, writeFileSync } from "node:fs"

const infoPath = process.argv[2]
if (!infoPath) throw new Error("Usage: node scripts/set-d1-from-info.mjs <d1-info.json>")

const payload = JSON.parse(readFileSync(infoPath, "utf8"))

function findUuid(value) {
  if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return value
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUuid(item)
      if (found) return found
    }
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findUuid(item)
      if (found) return found
    }
  }
  return null
}

const databaseId = findUuid(payload)
if (!databaseId) throw new Error("Could not find a D1 database UUID in Wrangler output")

const configPath = "wrangler.jsonc"
const config = JSON.parse(readFileSync(configPath, "utf8"))
const binding = config.d1_databases?.find((item) => item.binding === "GROWTH_DB")
if (!binding) throw new Error("GROWTH_DB binding is missing from wrangler.jsonc")

binding.database_id = databaseId
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
console.log("Resolved GROWTH_DB configuration.")
