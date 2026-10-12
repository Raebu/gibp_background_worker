import { describe, expect, it } from "vitest"
import { canonicalSourceSite, sourceSiteFromOrigin } from "../src/surfaces"

describe("multi-surface routing", () => {
  it("canonicalises GIBP website surfaces", () => {
    expect(canonicalSourceSite("https://www.gibp.global/path")).toBe("gibp.global")
    expect(canonicalSourceSite("GIBP.APP")).toBe("gibp.app")
    expect(canonicalSourceSite("", "gibp.app")).toBe("gibp.app")
  })

  it("derives source sites only from approved GIBP origins", () => {
    expect(sourceSiteFromOrigin("https://www.gibp.global")).toBe("gibp.global")
    expect(sourceSiteFromOrigin("https://gibp.app")).toBe("gibp.app")
    expect(sourceSiteFromOrigin("https://example.com")).toBeNull()
    expect(sourceSiteFromOrigin(null)).toBeNull()
  })
})
