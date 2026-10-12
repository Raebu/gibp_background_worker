import { describe, expect, it } from "vitest"
import { crmConfigured } from "../src/crm"

describe("CRM configuration", () => {
  it("is disabled by default", () => {
    expect(crmConfigured({ CRM_PROVIDER: "none" } as any)).toBe(false)
  })

  it("requires provider-specific credentials", () => {
    expect(crmConfigured({ CRM_PROVIDER: "hubspot", HUBSPOT_PRIVATE_APP_TOKEN: "x" } as any)).toBe(true)
    expect(crmConfigured({ CRM_PROVIDER: "salesforce", SALESFORCE_INSTANCE_URL: "https://example.my.salesforce.com" } as any)).toBe(false)
    expect(crmConfigured({
      CRM_PROVIDER: "salesforce",
      SALESFORCE_INSTANCE_URL: "https://example.my.salesforce.com",
      SALESFORCE_ACCESS_TOKEN: "x",
    } as any)).toBe(true)
  })
})
