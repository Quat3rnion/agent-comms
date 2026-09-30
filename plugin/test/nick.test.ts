import { describe, expect, test } from "bun:test"
import { childBase, childNick, isValidNick, linkName, projectSlug, provisionalNick, slugify } from "../src/nick.ts"

describe("slugify", () => {
  test("basic cases", () => {
    expect(slugify("Fix auth bug", 24)).toBe("fix-auth-bug")
    expect(slugify("  --Hello,   World!!  ", 24)).toBe("hello-world")
  })

  test("empty and non-ASCII input gives session", () => {
    expect(slugify("", 24)).toBe("session")
    expect(slugify("日本語", 24)).toBe("session")
    expect(slugify("---", 24)).toBe("session")
  })

  test("strips accents", () => {
    expect(slugify("Café Déjà", 24)).toBe("cafe-deja")
  })

  test("prefixes when starting with a digit", () => {
    expect(slugify("42 things", 24)).toBe("s-42-things")
    expect(isValidNick(slugify("9", 24))).toBe(true)
  })

  test("cuts without trailing dash", () => {
    expect(slugify("hello world", 6)).toBe("hello")
    expect(slugify("abcdef ghij", 7)).toBe("abcdef")
    expect(slugify("a".repeat(50), 24)).toBe("a".repeat(24))
  })
})

describe("nick helpers", () => {
  test("provisionalNick", () => {
    expect(provisionalNick("build", "ses_01ABCDEF")).toBe("build-cdef")
    expect(provisionalNick("Very Long Agent Name", "ses_01ABCDEF")).toBe("very-long-ag-cdef")
    expect(provisionalNick("build", "a_b-C")).toBe("build-abc")
    expect(isValidNick(provisionalNick("3d", "ses_1"))).toBe(true)
  })

  test("childNick and childBase", () => {
    expect(childNick("fix-auth", "explore1")).toBe("fix-auth|explore1")
    expect(childBase("explore", 1)).toBe("explore1")
    expect(childBase("General Purpose Agent Z", 3)).toBe("general-purpose3")
    expect(isValidNick(childNick("fix-auth", childBase("explore", 2)))).toBe(true)
  })

  test("isValidNick", () => {
    expect(isValidNick("fix-auth|explore1")).toBe(true)
    expect(isValidNick("[a]\\`^{}_")).toBe(true)
    expect(isValidNick("")).toBe(false)
    expect(isValidNick("1abc")).toBe(false)
    expect(isValidNick("-abc")).toBe(false)
    expect(isValidNick("a b")).toBe(false)
    expect(isValidNick("a#b")).toBe(false)
    expect(isValidNick("a".repeat(96))).toBe(true)
    expect(isValidNick("a".repeat(97))).toBe(false)
    expect(isValidNick("abcd", 3)).toBe(false)
  })

  test("projectSlug", () => {
    expect(projectSlug("/home/dev/My Web_App")).toBe("my-web-app")
    expect(projectSlug("/home/dev/webapp/")).toBe("webapp")
    expect(projectSlug("C:\\code\\Proj")).toBe("proj")
    expect(projectSlug("")).toBe("project")
    expect(projectSlug("///")).toBe("project")
    expect(projectSlug("日本")).toBe("project")
    expect(projectSlug("x".repeat(100)).length).toBe(64)
  })
})

describe("linkName", () => {
  test("simple form", () => {
    expect(linkName("local", "webapp")).toBe("svc-local.prj-webapp")
  })

  test("sanitizes characters", () => {
    expect(linkName("a b", "c/d")).toBe("svc-a_b.prj-c_d")
  })

  test("shortens long names to at most 64 characters", () => {
    const name = linkName("s".repeat(100), "p".repeat(100))
    expect(name.length).toBeLessThanOrEqual(64)
    expect(/^[A-Za-z0-9._-]+$/.test(name)).toBe(true)
    expect(name.startsWith("svc-")).toBe(true)
    expect(name).toContain(".prj-")
  })

  test("shortening is stable and distinguishes long parts", () => {
    const a = linkName("x".repeat(80), "proj")
    const b = linkName("x".repeat(80), "proj")
    const c = linkName("x".repeat(79) + "y", "proj")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(a.endsWith(".prj-proj")).toBe(true)
  })
})
