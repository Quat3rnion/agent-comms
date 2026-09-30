import { describe, expect, test } from "bun:test"
import {
  ClaimCache,
  ClaimTracker,
  FamilyIndex,
  canonicalPath,
  claimLine,
  decideEdit,
  extractEditPaths,
  extractPermissionPaths,
  releaseLine,
} from "../src/claims.ts"
import { parseLine, serializeLine } from "../src/proto.ts"
import type { Claim } from "../src/types.ts"

const set = (holder: string, nick: string, since: number, deadline: number, path: string) =>
  parseLine(`CLAIMSET ${holder} ${nick} ${since} ${deadline} :${path}`)

describe("ClaimCache", () => {
  test("apply CLAIMSET and CLAIMDEL, path with spaces", () => {
    const c = new ClaimCache()
    expect(c.apply(set("a1", "fix-auth", 100, 700, "/w/API guide.md"))).toBe(true)
    expect(c.get("/w/API guide.md")).toEqual({
      path: "/w/API guide.md",
      holderAccount: "a1",
      holderNick: "fix-auth",
      since: 100,
      deadline: 700,
    })
    // Same claim again: no change.
    expect(c.apply(set("a1", "fix-auth", 100, 700, "/w/API guide.md"))).toBe(false)
    // Refresh: change.
    expect(c.apply(set("a1", "fix-auth", 100, 800, "/w/API guide.md"))).toBe(true)
    expect(c.ofAccount("a1").length).toBe(1)
    expect(c.ofAccount("zz")).toEqual([])
    expect(c.apply(parseLine("CLAIMDEL :/w/API guide.md"))).toBe(true)
    expect(c.get("/w/API guide.md")).toBeUndefined()
    expect(c.apply(parseLine("CLAIMDEL /w/none"))).toBe(false)
    expect(c.apply(parseLine("PING x"))).toBe(false)
  })

  test("ignores malformed CLAIMSET", () => {
    const c = new ClaimCache()
    expect(c.apply(parseLine("CLAIMSET a1 nick x y /p"))).toBe(false)
    expect(c.apply(parseLine("CLAIMSET a1 nick 1 2"))).toBe(false)
    expect(c.all()).toEqual([])
  })

  test("burst rebuild drops stale entries", () => {
    const c = new ClaimCache()
    c.apply(set("a1", "n1", 1, 999, "/keep"))
    c.apply(set("a2", "n2", 1, 999, "/gone"))
    c.serverBurstStarted()
    c.apply(set("a1", "n1", 1, 999, "/keep")) // identical re-set still counts
    c.apply(set("a3", "n3", 1, 999, "/new"))
    c.serverBurstEnded()
    expect(c.all().map((x) => x.path).sort()).toEqual(["/keep", "/new"])
    // Nothing stale after the burst.
    c.serverBurstEnded()
    expect(c.all().length).toBe(2)
  })

  test("pruneExpired", () => {
    const c = new ClaimCache()
    c.apply(set("a1", "n1", 1, 100, "/old"))
    c.apply(set("a1", "n1", 1, 300, "/live"))
    c.pruneExpired(200)
    expect(c.all().map((x) => x.path)).toEqual(["/live"])
  })

  test("replaceAll and clear", () => {
    const c = new ClaimCache()
    const claim: Claim = { path: "/x", holderAccount: "a", holderNick: "n", since: 1, deadline: 2 }
    c.replaceAll([claim])
    expect(c.get("/x")).toEqual(claim)
    c.clear()
    expect(c.all()).toEqual([])
  })
})

describe("canonicalPath", () => {
  test("non-existent file under symlinked dir", () => {
    const real = new Map<string, string>([
      ["/", "/"],
      ["/work", "/work"],
      ["/work/link", "/private/real"],
    ])
    const realpath = (p: string) => real.get(p) ?? null
    expect(canonicalPath("link/sub/new.ts", "/work", realpath)).toBe("/private/real/sub/new.ts")
    expect(canonicalPath("/work/./link/../link/new.ts", "/elsewhere", realpath)).toBe(
      "/private/real/new.ts",
    )
  })

  test("keeps case from realpath", () => {
    const realpath = (p: string) => (p === "/users/Me" ? "/Users/me" : p === "/" ? "/" : null)
    expect(canonicalPath("/users/Me/a.ts", "/", realpath)).toBe("/Users/me/a.ts")
  })

  test("falls back to resolved path when nothing exists", () => {
    expect(canonicalPath("a/b.ts", "/w", () => null)).toBe("/w/a/b.ts")
  })
})

describe("FamilyIndex", () => {
  test("siblings, grandchild, unrelated", () => {
    const f = new FamilyIndex(
      new Map<string, string | null>([
        ["root", null],
        ["c1", "root"],
        ["c2", "root"],
        ["g1", "c1"],
        ["other", null],
      ]),
    )
    expect(f.isFamily("c1", "c2")).toBe(true)
    expect(f.isFamily("g1", "c2")).toBe(true)
    expect(f.isFamily("g1", "root")).toBe(true)
    expect(f.isFamily("c1", "other")).toBe(false)
    expect(f.isFamily("unknown", "root")).toBe(false)
    expect(f.isFamily("unknown", "unknown")).toBe(true)
  })

  test("set and delete", () => {
    const f = new FamilyIndex()
    f.set("a", null)
    f.set("b", "a")
    expect(f.isFamily("a", "b")).toBe(true)
    f.delete("b")
    expect(f.isFamily("a", "b")).toBe(false)
  })

  test("cycle guard", () => {
    const f = new FamilyIndex()
    f.set("a", "b")
    f.set("b", "c")
    f.set("c", "a")
    f.set("x", "a")
    f.set("z", null)
    expect(f.isFamily("a", "c")).toBe(true)
    expect(f.isFamily("x", "b")).toBe(true)
    expect(f.isFamily("a", "z")).toBe(false)
  })
})

describe("decideEdit", () => {
  const NOW = 1000
  const mk = (): ClaimCache => {
    const c = new ClaimCache()
    c.apply(set("holder", "docs-bot", NOW - 180, NOW + 400, "/w/a.ts"))
    c.apply(set("holder", "docs-bot", NOW - 45, NOW + 400, "/w/b.ts"))
    c.apply(set("holder", "docs-bot", NOW - 7200, NOW - 10, "/w/expired.ts"))
    return c
  }
  const family = new FamilyIndex(
    new Map<string, string | null>([
      ["root", null],
      ["me", "root"],
      ["holder", null],
      ["kid", "holder"],
    ]),
  )
  const base = {
    account: "me" as string | null,
    sessionFamilyAccount: null as string | null,
    paths: ["/w/a.ts"],
    cache: mk(),
    family,
    linkState: "established" as const,
    failMode: "ask" as const,
    nowSec: NOW,
  }

  test("conflict deny message", () => {
    const d = decideEdit(base)
    expect(d).toEqual({
      effect: "deny",
      message:
        "/w/a.ts is claimed by docs-bot (for 3 min). Use irc_ask docs-bot to coordinate, or ask your user.",
    })
  })

  test("multiple conflicts in one message; seconds and hours", () => {
    const d = decideEdit({ ...base, paths: ["/w/a.ts", "/w/b.ts", "/w/expired.ts"] })
    expect(d.effect).toBe("deny")
    if (d.effect === "deny") {
      expect(d.message).toContain("/w/a.ts is claimed by docs-bot (for 3 min)")
      expect(d.message).toContain("/w/b.ts is claimed by docs-bot (for 45 s)")
      expect(d.message).toContain("/w/expired.ts is claimed by docs-bot (for 2 h)")
    }
  })

  test("nickOf overrides cached nick", () => {
    const d = decideEdit({ ...base, nickOf: () => "renamed" })
    expect(d.effect === "deny" && d.message.includes("claimed by renamed")).toBe(true)
  })

  test("family and own claims allow", () => {
    expect(decideEdit({ ...base, account: "kid" }).effect).toBe("allow")
    expect(decideEdit({ ...base, account: "holder" }).effect).toBe("allow")
  })

  test("no claim allows", () => {
    expect(decideEdit({ ...base, paths: ["/w/free.ts"] }).effect).toBe("allow")
  })

  test("offline failMode open / deny / ask", () => {
    for (const linkState of ["down", "connecting", "linked", "never"] as const) {
      expect(decideEdit({ ...base, linkState, failMode: "open" }).effect).toBe("allow")
    }
    const deny = decideEdit({ ...base, linkState: "down", failMode: "deny" })
    expect(deny).toEqual({
      effect: "deny",
      message:
        "IRC server unreachable: file claims cannot be checked, so edits are blocked (failMode=deny). Ask your user.",
    })
    const ask = decideEdit({ ...base, linkState: "down", failMode: "ask", paths: ["/w/free.ts", "/w/x.ts"] })
    expect(ask).toEqual({
      effect: "ask",
      message:
        "IRC server unreachable: claims cannot be checked. Allow this edit of /w/free.ts, /w/x.ts?",
    })
  })

  test("ask mode: cached claim denies, expired cached claim is ignored", () => {
    const d = decideEdit({ ...base, linkState: "down", failMode: "ask" })
    expect(d.effect).toBe("deny")
    if (d.effect === "deny") expect(d.message.endsWith("(cached; IRC server unreachable)")).toBe(true)
    const e = decideEdit({ ...base, linkState: "down", failMode: "ask", paths: ["/w/expired.ts"] })
    expect(e.effect).toBe("ask")
  })

  test("opted-out session is still bound by claims", () => {
    const d = decideEdit({ ...base, account: null, sessionFamilyAccount: null })
    expect(d.effect).toBe("deny")
  })

  test("opted-out session is allowed by claims of its ancestor's family", () => {
    expect(decideEdit({ ...base, account: null, sessionFamilyAccount: "kid" }).effect).toBe("allow")
    expect(decideEdit({ ...base, account: null, sessionFamilyAccount: "holder" }).effect).toBe("allow")
    expect(decideEdit({ ...base, account: null, sessionFamilyAccount: "root" }).effect).toBe("deny")
  })
})

describe("ClaimTracker", () => {
  test("record, held, release, burst lines", () => {
    const t = new ClaimTracker()
    t.record("a1", "/w/A b.ts")
    t.record("a1", "/w/c.ts")
    t.record("a2", "/w/d.ts")
    expect(t.held("a1").sort()).toEqual(["/w/A b.ts", "/w/c.ts"])
    const lines = t.burstLines().map(serializeLine).sort()
    expect(lines).toEqual([
      "CLAIM a1 /w/c.ts",
      "CLAIM a1 :/w/A b.ts",
      "CLAIM a2 /w/d.ts",
    ])
    t.release("a1", "/w/c.ts")
    expect(t.held("a1")).toEqual(["/w/A b.ts"])
    expect(t.releaseAll("a1")).toEqual(["/w/A b.ts"])
    expect(t.held("a1")).toEqual([])
    expect(t.releaseAll("nobody")).toEqual([])
  })

  test("applyServer removes on CLAIMDEL or another holder", () => {
    const t = new ClaimTracker()
    t.record("a1", "/w/x.ts")
    t.record("a1", "/w/y.ts")
    t.record("a1", "/w/z.ts")
    t.applyServer(parseLine("CLAIMDEL /w/x.ts"))
    expect(t.held("a1").sort()).toEqual(["/w/y.ts", "/w/z.ts"])
    t.applyServer(set("other", "o", 1, 2, "/w/y.ts"))
    expect(t.held("a1")).toEqual(["/w/z.ts"])
    t.applyServer(set("a1", "n", 1, 2, "/w/z.ts"))
    expect(t.held("a1")).toEqual(["/w/z.ts"])
  })

  test("line helpers", () => {
    expect(serializeLine(claimLine("a1", "/w/x.ts"))).toBe("CLAIM a1 /w/x.ts")
    expect(serializeLine(releaseLine("a1", "/w/x y.ts"))).toBe("RELEASE a1 :/w/x y.ts")
  })
})

describe("extractEditPaths", () => {
  const tools = ["edit", "write", "multiedit", "apply_patch", "patch"]

  test("edit / write", () => {
    expect(extractEditPaths("edit", { filePath: "/a.ts", oldString: "x" }, tools)).toEqual(["/a.ts"])
    expect(extractEditPaths("write", { file_path: "/b.ts", content: "" }, tools)).toEqual(["/b.ts"])
    expect(extractEditPaths("write", { path: "/c.ts" }, tools)).toEqual(["/c.ts"])
    expect(extractEditPaths("write", { filename: "/d.ts" }, tools)).toEqual(["/d.ts"])
  })

  test("multiedit and files arrays, deduplicated", () => {
    expect(
      extractEditPaths(
        "multiedit",
        { filePath: "/a.ts", edits: [{ filePath: "/a.ts" }, { file_path: "/b.ts" }], files: ["/c.ts", { path: "/d.ts" }] },
        tools,
      ).sort(),
    ).toEqual(["/a.ts", "/b.ts", "/c.ts", "/d.ts"])
  })

  test("apply_patch envelope", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Move to: src/a2.ts",
      "@@",
      "-x",
      "+y",
      "*** Add File: src/new file.ts",
      "+z",
      "*** Delete File: src/old.ts",
      "*** End Patch",
    ].join("\n")
    expect(extractEditPaths("apply_patch", { patchText }, tools)).toEqual([
      "src/a.ts",
      "src/a2.ts",
      "src/new file.ts",
      "src/old.ts",
    ])
  })

  test("unified diff", () => {
    const patch = ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1 +1 @@", "-a", "+b", "--- /dev/null", "+++ b/src/n.ts"].join(
      "\n",
    )
    expect(extractEditPaths("patch", { patch }, tools)).toEqual(["src/x.ts", "src/n.ts"])
    expect(extractEditPaths("patch", { diff: patch }, tools)).toEqual(["src/x.ts", "src/n.ts"])
  })

  test("non-edit tools and bad input", () => {
    expect(extractEditPaths("read", { filePath: "/a.ts" }, tools)).toEqual([])
    expect(extractEditPaths("edit", null, tools)).toEqual([])
    expect(extractEditPaths("edit", "str", tools)).toEqual([])
  })
})

describe("extractPermissionPaths", () => {
  const actions = ["edit"]
  test("null for other actions", () => {
    expect(extractPermissionPaths({ action: "bash", resources: ["ls"] }, actions)).toBeNull()
  })
  test("drops globs and adds metadata", () => {
    expect(
      extractPermissionPaths(
        { action: "edit", resources: ["/w/a.ts", "/w/**/*.ts", "/w/q?.ts", "/w/[x].ts"], metadata: { filePath: "/w/b.ts", path: "/w/a.ts" } },
        actions,
      ),
    ).toEqual(["/w/a.ts", "/w/b.ts"])
    expect(extractPermissionPaths({ action: "edit", resources: [] }, actions)).toEqual([])
  })
})
