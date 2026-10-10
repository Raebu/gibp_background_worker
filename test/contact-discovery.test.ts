import { describe, expect, it } from "vitest"
import { extractNamedPublicContacts, isGenericRoleEmail } from "../src/discovery"
import { isGenericRoleAddress } from "../src/compliance"

describe("named public contact discovery", () => {
  it("extracts a named payments decision-maker from an official mailto link", () => {
    const html = `
      <section>
        <h2>Jane Smith</h2>
        <p>Head of Payments</p>
        <a href="mailto:jane.smith@examplebank.com">Jane Smith</a>
      </section>
    `

    expect(extractNamedPublicContacts(html, "examplebank.com")).toEqual([
      {
        name: "Jane Smith",
        role: "Head of Payments",
        email: "jane.smith@examplebank.com",
      },
    ])
  })

  it("extracts a named executive from JSON-LD", () => {
    const html = `
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Person",
          "name": "Alex Morgan",
          "jobTitle": "Chief Technology Officer",
          "email": "alex.morgan@examplebank.com"
        }
      </script>
    `

    expect(extractNamedPublicContacts(html, "examplebank.com")).toEqual([
      {
        name: "Alex Morgan",
        role: "Chief Technology Officer",
        email: "alex.morgan@examplebank.com",
      },
    ])
  })

  it("rejects generic role mailboxes even when displayed publicly", () => {
    const html = `
      <section>
        <p>Head of Payments</p>
        <a href="mailto:contact@examplebank.com">Jane Smith</a>
      </section>
    `

    expect(extractNamedPublicContacts(html, "examplebank.com")).toEqual([])
    expect(isGenericRoleEmail("contact@examplebank.com")).toBe(true)
    expect(isGenericRoleAddress("partnerships@examplebank.com")).toBe(true)
  })

  it("does not infer a person when the public page does not name one", () => {
    const html = `
      <section>
        <p>Payments Transformation team</p>
        <a href="mailto:payments@examplebank.com">Email the team</a>
      </section>
    `

    expect(extractNamedPublicContacts(html, "examplebank.com")).toEqual([])
  })
})
