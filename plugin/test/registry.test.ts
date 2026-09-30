import { describe, expect, test } from "bun:test"
import { KEY_PREFIX, Registry, parsePersisted } from "../src/registry.ts"
import type { RegistryStorage } from "../src/registry.ts"
import type { SessionRecord } from "../src/types.ts"

const DIR = "/work/webapp"

function rec(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionID: "ses_a",
    account: "ses_a",
    nick: "fix-auth",
    provisional: false,
    parentID: null,
    agent: "build",
    title: "Fix auth",
    project: "webapp",
    optedOut: false,
    busy: false,
    channels: ["#lobby", "#webapp"],
    ...over,
  }
}

function memStorage(): { map: Map<string, unknown>; storage: RegistryStorage } {
  const map = new Map<string, unknown>()
  const storage = {
    set: async (key: string, value: unknown) => {
      map.set(key, value)
    },
    remove: async (key: string) => {
      map.delete(key)
    },
    scan: async (o: { prefix: string; after?: string; limit?: number }) => {
      const keys = [...map.keys()]
        .filter((k) => k.startsWith(o.prefix) && (o.after === undefined || k > o.after))
        .sort()
      const limit = o.limit ?? keys.length
      const page = keys.slice(0, limit)
      const last = page[page.length - 1]
      return {
        entries: page.map((key) => ({ key, value: map.get(key) })),
        ...(keys.length > limit && last !== undefined ? { next: last } : {}),
      }
    },
  }
  return { map, storage: storage as unknown as RegistryStorage }
}

describe("Registry basics", () => {
  test("put, get, all, remove", () => {
    const r = new Registry(null, DIR)
    r.put(rec())
    expect(r.get("ses_a")?.nick).toBe("fix-auth")
    expect(r.all()).toHaveLength(1)
    expect(r.remove("ses_a")?.sessionID).toBe("ses_a")
    expect(r.get("ses_a")).toBeUndefined()
  })

  test("byNick folds case by rfc1459 rules and skips opted-out sessions", () => {
    const r = new Registry(null, DIR)
    r.put(rec({ nick: "Fix{Auth}" }))
    r.put(rec({ sessionID: "ses_b", account: "ses_b", nick: "hidden", optedOut: true }))
    expect(r.byNick("fix[auth]")?.sessionID).toBe("ses_a")
    expect(r.byNick("FIX{AUTH}")?.sessionID).toBe("ses_a")
    expect(r.byNick("hidden")).toBeUndefined()
    expect(r.byNick("nobody")).toBeUndefined()
  })

  test("setNick keeps the old nick as an alias", () => {
    const r = new Registry(null, DIR)
    r.put(rec({ nick: "build-abcd" }))
    r.setNick("ses_a", "fix-auth")
    expect(r.get("ses_a")?.nick).toBe("fix-auth")
    expect(r.aliases("ses_a")).toEqual(["build-abcd"])
    // Going back to the alias removes it from the alias list.
    r.setNick("ses_a", "build-abcd")
    expect(r.aliases("ses_a")).toEqual(["fix-auth"])
  })

  test("setNick with alias false does not keep the old nick", () => {
    const r = new Registry(null, DIR)
    r.put(rec({ nick: "fix-auth" }))
    r.setNick("ses_a", "fix-auth-2", { alias: false })
    expect(r.aliases("ses_a")).toEqual([])
  })

  test("setBusy and setOptedOut", () => {
    const r = new Registry(null, DIR)
    r.put(rec())
    r.setBusy("ses_a", true)
    r.setOptedOut("ses_a", true)
    expect(r.get("ses_a")?.busy).toBe(true)
    expect(r.get("ses_a")?.optedOut).toBe(true)
  })

  test("children and ownedBy order parents before children", () => {
    const r = new Registry(null, DIR)
    r.put(rec({ sessionID: "ses_c", account: "ses_c", nick: "p|x1", parentID: "ses_b" }))
    r.put(rec({ sessionID: "ses_b", account: "ses_b", nick: "p", parentID: "ses_a" }))
    r.put(rec())
    r.put(rec({ sessionID: "ses_z", account: "ses_z", nick: "other" }), "/elsewhere")
    expect(r.children("ses_a").map((x) => x.sessionID)).toEqual(["ses_b"])
    expect(r.ownedBy(DIR).map((x) => x.sessionID)).toEqual(["ses_a", "ses_b", "ses_c"])
    expect(r.ownedBy("/elsewhere").map((x) => x.sessionID)).toEqual(["ses_z"])
  })

  test("nextChildIndex counts per parent", () => {
    const r = new Registry(null, DIR)
    r.put(rec())
    r.put(rec({ sessionID: "ses_b", account: "ses_b", nick: "other" }))
    expect(r.nextChildIndex("ses_a")).toBe(1)
    expect(r.nextChildIndex("ses_a")).toBe(2)
    expect(r.nextChildIndex("ses_b")).toBe(1)
  })

  test("channel helpers ignore case and rename in every session", () => {
    const r = new Registry(null, DIR)
    r.put(rec({ channels: ["#lobby", "#Old"] }))
    r.put(rec({ sessionID: "ses_b", account: "ses_b", nick: "old|x1", channels: ["#lobby", "#old"] }))
    r.addChannel("ses_a", "#LOBBY")
    r.addChannel("ses_a", "#extra")
    r.removeChannel("ses_a", "#EXTRA")
    r.replaceChannel("#old", "#new")
    expect(r.get("ses_a")?.channels).toEqual(["#lobby", "#new"])
    expect(r.get("ses_b")?.channels).toEqual(["#lobby", "#new"])
  })
})

describe("Registry persistence", () => {
  test("writes session/<id> and loads it back with aliases and counter", async () => {
    const { map, storage } = memStorage()
    const a = new Registry(storage, DIR)
    a.put(rec({ nick: "build-abcd" }))
    a.setNick("ses_a", "fix-auth")
    a.nextChildIndex("ses_a")
    a.nextChildIndex("ses_a")
    a.setBusy("ses_a", true)
    await a.flush()
    expect([...map.keys()]).toEqual([`${KEY_PREFIX}ses_a`])

    const b = new Registry(storage, DIR)
    expect(await b.load()).toBe(1)
    expect(b.get("ses_a")?.nick).toBe("fix-auth")
    expect(b.get("ses_a")?.busy).toBe(false)
    expect(b.aliases("ses_a")).toEqual(["build-abcd"])
    expect(b.nextChildIndex("ses_a")).toBe(3)
    expect(b.directoryOf("ses_a")).toBe(DIR)
  })

  test("load keeps only sessions of its own directory and skips bad entries", async () => {
    const { map, storage } = memStorage()
    const other = new Registry(storage, "/elsewhere")
    other.put(rec({ sessionID: "ses_o", account: "ses_o", nick: "o" }))
    await other.flush()
    map.set(`${KEY_PREFIX}junk`, { nope: true })
    const a = new Registry(storage, DIR, () => {})
    a.put(rec())
    await a.flush()

    const b = new Registry(storage, DIR, () => {})
    expect(await b.load()).toBe(1)
    expect(b.all().map((x) => x.sessionID)).toEqual(["ses_a"])
  })

  test("load pages through storage", async () => {
    const { storage } = memStorage()
    const a = new Registry(storage, DIR)
    for (let i = 0; i < 450; i++) {
      const id = `ses_${String(i).padStart(4, "0")}`
      a.put(rec({ sessionID: id, account: id, nick: `n${i}` }))
    }
    await a.flush()
    const b = new Registry(storage, DIR)
    expect(await b.load()).toBe(450)
  })

  test("remove deletes the stored entry", async () => {
    const { map, storage } = memStorage()
    const a = new Registry(storage, DIR)
    a.put(rec())
    await a.flush()
    a.remove("ses_a")
    await a.flush()
    expect(map.size).toBe(0)
  })

  test("parsePersisted rejects wrong shapes", () => {
    expect(parsePersisted(null)).toBeNull()
    expect(parsePersisted({ v: 2 })).toBeNull()
    expect(
      parsePersisted({ v: 1, record: { sessionID: "x" }, aliases: [], lastChild: 0, directory: DIR }),
    ).toBeNull()
  })
})
