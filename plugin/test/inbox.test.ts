import { describe, expect, test } from "bun:test"
import { Inbox } from "../src/inbox.ts"
import type { InboundMessage } from "../src/types.ts"

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    account: "s1",
    msgid: "m1",
    time: "2026-01-01T00:00:00.000Z",
    senderAccount: "acc-b",
    senderNick: "bob",
    target: "#lobby",
    isChannel: true,
    command: "PRIVMSG",
    text: "hello",
    role: "agent",
    rel: "peer",
    broadcast: null,
    hop: 0,
    replyTo: null,
    parentNick: null,
    replay: false,
    ...over,
  }
}

const T = (n: number) => `2026-01-01T00:00:0${n}.000Z`

describe("Inbox unread and read", () => {
  test("counts by target, sorted, only unread", () => {
    const inbox = new Inbox({ previewChars: 20 })
    inbox.add("s1", inbound({ msgid: "a", target: "#x" }), true)
    inbox.add("s1", inbound({ msgid: "b", target: "#y" }), true)
    inbox.add("s1", inbound({ msgid: "c", target: "#y" }), true)
    inbox.add("s1", inbound({ msgid: "d", target: "#z" }), false)
    expect(inbox.unreadCounts("s1")).toEqual([
      { target: "#y", count: 2 },
      { target: "#x", count: 1 },
    ])
    expect(inbox.totalUnread("s1")).toBe(3)
    expect(inbox.totalUnread("other")).toBe(0)
  })

  test("read returns oldest first, marks read, respects target and limit", () => {
    const inbox = new Inbox({ previewChars: 20 })
    inbox.add("s1", inbound({ msgid: "a", target: "#x", time: T(1) }), true)
    inbox.add("s1", inbound({ msgid: "b", target: "#y", time: T(2) }), true)
    inbox.add("s1", inbound({ msgid: "c", target: "#x", time: T(3) }), true)
    const first = inbox.read("s1", { target: "#x", limit: 1 })
    expect(first.map((e) => e.msgid)).toEqual(["a"])
    expect(inbox.totalUnread("s1")).toBe(2)
    const rest = inbox.read("s1", {})
    expect(rest.map((e) => e.msgid)).toEqual(["b", "c"])
    expect(inbox.totalUnread("s1")).toBe(0)
    expect(inbox.read("s1", {})).toEqual([])
    const times = inbox.lastReadTimes("s1")
    expect(times.get("#x")).toBe(T(3))
    expect(times.get("#y")).toBe(T(2))
  })

  test("default limit is 20", () => {
    const inbox = new Inbox({ previewChars: 20 })
    for (let i = 0; i < 25; i++) inbox.add("s1", inbound({ msgid: `m${i}` }), true)
    expect(inbox.read("s1").length).toBe(20)
    expect(inbox.totalUnread("s1")).toBe(5)
  })

  test("previews cut on a code point boundary", () => {
    const inbox = new Inbox({ previewChars: 3 })
    inbox.add("s1", inbound({ msgid: "a", text: "😀😀😀😀" }), true)
    inbox.add("s1", inbound({ msgid: "b", text: "abc" }), true)
    const [a, b] = inbox.read("s1")
    expect(a?.preview).toBe("😀😀😀…")
    expect(a?.truncated).toBe(true)
    expect(b?.preview).toBe("abc")
    expect(b?.truncated).toBe(false)
  })

  test("get returns the full text of any stored message", () => {
    const inbox = new Inbox({ previewChars: 3 })
    inbox.add("s1", inbound({ msgid: "a", text: "long long text" }), true)
    inbox.add("s1", inbound({ msgid: "b", text: "pushed text" }), false)
    inbox.read("s1")
    expect(inbox.get("s1", "a")?.text).toBe("long long text")
    expect(inbox.get("s1", "b")?.text).toBe("pushed text")
    expect(inbox.get("s1", "zz")).toBeUndefined()
    expect(inbox.get("other", "a")).toBeUndefined()
  })

  test("maxStored drops the oldest", () => {
    const inbox = new Inbox({ previewChars: 10, maxStored: 2 })
    inbox.add("s1", inbound({ msgid: "a" }), true)
    inbox.add("s1", inbound({ msgid: "b" }), true)
    inbox.add("s1", inbound({ msgid: "c" }), true)
    expect(inbox.get("s1", "a")).toBeUndefined()
    expect(inbox.totalUnread("s1")).toBe(2)
  })

  test("duplicate msgid is ignored", () => {
    const inbox = new Inbox({ previewChars: 10 })
    inbox.add("s1", inbound({ msgid: "a" }), true)
    inbox.add("s1", inbound({ msgid: "a" }), true)
    expect(inbox.totalUnread("s1")).toBe(1)
  })

  test("markRead clears messages up to time and server count", () => {
    const inbox = new Inbox({ previewChars: 10 })
    inbox.add("s1", inbound({ msgid: "a", time: T(1) }), true)
    inbox.add("s1", inbound({ msgid: "b", time: T(5) }), true)
    inbox.setServerUnread("s1", "#lobby", 4)
    expect(inbox.totalUnread("s1")).toBe(6)
    inbox.markRead("s1", "#lobby", T(2))
    expect(inbox.totalUnread("s1")).toBe(1)
    expect(inbox.lastReadTimes("s1").get("#lobby")).toBe(T(2))
  })

  test("server unread seeds counts", () => {
    const inbox = new Inbox({ previewChars: 10 })
    inbox.setServerUnread("s1", "#a", 3)
    inbox.setServerUnread("s1", "bob", 1)
    expect(inbox.unreadCounts("s1")).toEqual([
      { target: "#a", count: 3 },
      { target: "bob", count: 1 },
    ])
    inbox.setServerUnread("s1", "#a", 0)
    expect(inbox.totalUnread("s1")).toBe(1)
  })

  test("clear drops everything", () => {
    const inbox = new Inbox({ previewChars: 10 })
    inbox.add("s1", inbound(), true)
    inbox.recordJoinContext("s1", "#x", null, [])
    inbox.clear("s1")
    expect(inbox.totalUnread("s1")).toBe(0)
    expect(inbox.get("s1", "m1")).toBeUndefined()
    expect(inbox.takeJoinContext("s1")).toBeNull()
  })
})

describe("Inbox waiters", () => {
  test("reply resolves the waiter and is consumed", async () => {
    const inbox = new Inbox({ previewChars: 10 })
    const p = inbox.waitFor("s1", { replyTo: "q1", timeoutMs: 1000 })
    expect(inbox.hasWaiter("s1")).toBe(true)
    const reply = inbound({ msgid: "r1", replyTo: "q1" })
    expect(inbox.offer("s1", reply, false)).toBe("consumed-as-reply")
    const res = await p
    expect(res).toEqual({ kind: "reply", message: reply })
    expect(inbox.hasWaiter("s1")).toBe(false)
  })

  test("directed message interrupts", async () => {
    const inbox = new Inbox({ previewChars: 10 })
    const p = inbox.waitFor("s1", { replyTo: "q1", timeoutMs: 1000 })
    const other = inbound({ msgid: "o1", replyTo: "zzz" })
    expect(inbox.offer("s1", other, true)).toBe("interrupted-waiter")
    expect(await p).toEqual({ kind: "interrupted", message: other })
    expect(inbox.hasWaiter("s1")).toBe(false)
  })

  test("undirected non-reply leaves the waiter alone", async () => {
    const inbox = new Inbox({ previewChars: 10 })
    const p = inbox.waitFor("s1", { replyTo: "q1", timeoutMs: 30 })
    expect(inbox.offer("s1", inbound({ msgid: "c1" }), false)).toBe("none")
    expect(inbox.hasWaiter("s1")).toBe(true)
    expect(await p).toEqual({ kind: "timeout" })
    expect(inbox.hasWaiter("s1")).toBe(false)
  })

  test("offer without waiter gives none, also for a late reply", async () => {
    const inbox = new Inbox({ previewChars: 10 })
    expect(inbox.offer("s1", inbound({ replyTo: "q1" }), true)).toBe("none")
    const p = inbox.waitFor("s1", { replyTo: "q1", timeoutMs: 5 })
    expect(await p).toEqual({ kind: "timeout" })
    expect(inbox.offer("s1", inbound({ msgid: "late", replyTo: "q1" }), true)).toBe("none")
  })

  test("waiters are per session", async () => {
    const inbox = new Inbox({ previewChars: 10 })
    const p = inbox.waitFor("s1", { replyTo: "q1", timeoutMs: 20 })
    expect(inbox.offer("s2", inbound({ replyTo: "q1" }), true)).toBe("none")
    expect(await p).toEqual({ kind: "timeout" })
  })

  test("abort signal", async () => {
    const inbox = new Inbox({ previewChars: 10 })
    const ac = new AbortController()
    const p = inbox.waitFor("s1", { replyTo: "q1", timeoutMs: 1000, signal: ac.signal })
    ac.abort()
    expect(await p).toEqual({ kind: "aborted" })
    expect(inbox.hasWaiter("s1")).toBe(false)
  })

  test("already aborted signal", async () => {
    const inbox = new Inbox({ previewChars: 10 })
    const ac = new AbortController()
    ac.abort()
    expect(await inbox.waitFor("s1", { replyTo: "q1", timeoutMs: 1000, signal: ac.signal })).toEqual({
      kind: "aborted",
    })
    expect(inbox.hasWaiter("s1")).toBe(false)
  })
})

describe("Inbox ask window", () => {
  test("a reply that arrives before waitFor is returned as the reply", async () => {
    const inbox = new Inbox({ previewChars: 10 })
    const h = inbox.beginAsk("s1")
    const reply = inbound({ msgid: "r1", replyTo: "q1" })
    expect(inbox.offer("s1", reply, false)).toBe("buffered")
    expect(await inbox.waitFor("s1", { replyTo: "q1", timeoutMs: 1000, handle: h })).toEqual({
      kind: "reply",
      message: reply,
    })
    expect(inbox.hasWaiter("s1")).toBe(false)
    expect(inbox.endAsk(h)).toEqual([])
  })

  test("a directed message that arrives before waitFor interrupts", async () => {
    const inbox = new Inbox({ previewChars: 10 })
    const h = inbox.beginAsk("s1")
    const other = inbound({ msgid: "o1", target: "me", isChannel: false })
    expect(inbox.offer("s1", other, true)).toBe("buffered")
    expect(await inbox.waitFor("s1", { replyTo: "q1", timeoutMs: 1000, handle: h })).toEqual({
      kind: "interrupted",
      message: other,
    })
    expect(inbox.endAsk(h)).toEqual([])
  })

  test("the reply wins over an earlier directed message, which is released", async () => {
    const inbox = new Inbox({ previewChars: 10 })
    const h = inbox.beginAsk("s1")
    const other = inbound({ msgid: "o1", target: "me", isChannel: false })
    const reply = inbound({ msgid: "r1", replyTo: "q1" })
    expect(inbox.offer("s1", other, true)).toBe("buffered")
    expect(inbox.offer("s1", reply, false)).toBe("buffered")
    expect(await inbox.waitFor("s1", { replyTo: "q1", timeoutMs: 1000, handle: h })).toEqual({
      kind: "reply",
      message: reply,
    })
    expect(inbox.endAsk(h)).toEqual([other])
  })

  test("unused buffered messages are released by endAsk", async () => {
    const inbox = new Inbox({ previewChars: 10 })
    const h = inbox.beginAsk("s1")
    const unrelated = inbound({ msgid: "u1", replyTo: "zzz" })
    expect(inbox.offer("s1", unrelated, false)).toBe("buffered")
    expect(inbox.offer("s1", inbound({ msgid: "c1" }), false)).toBe("none")
    expect(await inbox.waitFor("s1", { replyTo: "q1", timeoutMs: 10, handle: h })).toEqual({ kind: "timeout" })
    expect(inbox.endAsk(h)).toEqual([unrelated])
    expect(inbox.endAsk(h)).toEqual([])
  })

  test("endAsk after a failed send releases everything", () => {
    const inbox = new Inbox({ previewChars: 10 })
    const h = inbox.beginAsk("s1")
    const a = inbound({ msgid: "a", target: "me", isChannel: false })
    const b = inbound({ msgid: "b", replyTo: "x" })
    inbox.offer("s1", a, true)
    inbox.offer("s1", b, false)
    expect(inbox.endAsk(h)).toEqual([a, b])
    expect(inbox.offer("s1", inbound({ msgid: "c", target: "me", isChannel: false }), true)).toBe("none")
  })

  test("messages go to the waiter after waitFor registers it", async () => {
    const inbox = new Inbox({ previewChars: 10 })
    const h = inbox.beginAsk("s1")
    const p = inbox.waitFor("s1", { replyTo: "q1", timeoutMs: 1000, handle: h })
    const reply = inbound({ msgid: "r1", replyTo: "q1" })
    expect(inbox.offer("s1", reply, false)).toBe("consumed-as-reply")
    expect(await p).toEqual({ kind: "reply", message: reply })
    expect(inbox.offer("s1", inbound({ msgid: "u1", replyTo: "zzz" }), false)).toBe("none")
    expect(inbox.endAsk(h)).toEqual([])
  })

  test("without a window the old behaviour stays", () => {
    const inbox = new Inbox({ previewChars: 10 })
    expect(inbox.offer("s1", inbound({ replyTo: "q1" }), true)).toBe("none")
    expect(inbox.offer("s1", inbound({ msgid: "d1" }), true)).toBe("none")
  })
})

describe("Inbox join context", () => {
  test("returns text once", () => {
    const inbox = new Inbox({ previewChars: 10 })
    expect(inbox.takeJoinContext("s1")).toBeNull()
    inbox.recordJoinContext("s1", "#a", "the topic", ["<bob> hi", "<amy> yo"])
    inbox.recordJoinContext("s1", "#b", null, [])
    expect(inbox.takeJoinContext("s1")).toBe(
      "Joined #a. Topic: the topic. Recent messages:\n<bob> hi\n<amy> yo\n" +
        "Joined #b. Topic: (none). Recent messages:\n",
    )
    expect(inbox.takeJoinContext("s1")).toBeNull()
  })
})
