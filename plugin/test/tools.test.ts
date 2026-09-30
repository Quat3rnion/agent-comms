import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { ClaimTracker } from "../src/claims.ts"
import { HopTracker } from "../src/delivery.ts"
import { Inbox } from "../src/inbox.ts"
import type { SendResult } from "../src/link.ts"
import type { IrcMessage, Tags } from "../src/proto.ts"
import { getTag, msg } from "../src/proto.ts"
import { DEFAULT_OPTIONS } from "../src/options.ts"
import { buildTools, registerTools } from "../src/tools.ts"
import type { ToolDeps, ToolDef } from "../src/tools.ts"
import type { InboundMessage, LinkState, Options, RegistryApi, SessionRecord } from "../src/types.ts"
import { LinkDownError } from "../src/types.ts"

type FakeLinkT = ToolDeps["link"]

class FakeLink implements FakeLinkT {
  state: LinkState = "established"
  throwDown = false
  sendResult: SendResult = { ok: true, msgid: "m1" }
  sendAsCalls: Array<{ account: string; inner: IrcMessage }> = []
  multiCalls: Array<{ account: string; target: string; lines: string[]; tags: Tags }> = []
  queries: Array<{ account: string; inner: IrcMessage }> = []
  requests: IrcMessage[] = []
  queryHandler: (inner: IrcMessage) => IrcMessage[] = () => []
  requestHandler: (m: IrcMessage) => IrcMessage = (m) => msg("CLAIMDEL", [m.params[1] ?? ""])

  get connected(): boolean {
    return this.state === "established"
  }
  async waitConnected(): Promise<boolean> {
    return this.connected
  }
  send(): void {
    if (!this.connected) throw new LinkDownError()
  }
  async request(m: IrcMessage): Promise<IrcMessage> {
    if (this.throwDown) throw new LinkDownError()
    this.requests.push(m)
    return this.requestHandler(m)
  }
  async query(account: string, inner: IrcMessage): Promise<IrcMessage[]> {
    if (this.throwDown) throw new LinkDownError()
    this.queries.push({ account, inner })
    return this.queryHandler(inner)
  }
  /** Runs inside sendAs after a short delay, before the result is returned. */
  beforeSendResult: (() => void) | undefined = undefined
  async sendAs(account: string, inner: IrcMessage): Promise<SendResult> {
    if (this.throwDown) throw new LinkDownError()
    this.sendAsCalls.push({ account, inner })
    if (this.beforeSendResult) {
      await Bun.sleep(5)
      this.beforeSendResult()
    }
    return this.sendResult
  }
  async sendMultiline(account: string, target: string, lines: string[], tags: Tags): Promise<SendResult> {
    if (this.throwDown) throw new LinkDownError()
    this.multiCalls.push({ account, target, lines, tags })
    return this.sendResult
  }
}

function record(sessionID: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionID,
    account: sessionID,
    nick: "me",
    provisional: false,
    parentID: null,
    agent: "build",
    title: "",
    project: "proj",
    optedOut: false,
    busy: true,
    channels: [],
    ...over,
  }
}

function registryOf(...recs: SessionRecord[]): RegistryApi {
  const map = new Map(recs.map((r) => [r.sessionID, r]))
  return {
    get: (id) => map.get(id),
    byNick: (nick) => recs.find((r) => r.nick === nick),
    all: () => recs,
    aliases: () => [],
  }
}

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

interface Harness {
  link: FakeLink
  inbox: Inbox
  hop: HopTracker
  claims: ClaimTracker
  changed: string[]
  tools: Map<string, ToolDef>
  run: (name: string, input: unknown, sessionID?: string, signal?: AbortSignal) => Promise<string>
}

function harness(options: Partial<Options> = {}): Harness {
  const link = new FakeLink()
  const opts: Options = { ...DEFAULT_OPTIONS, previewChars: 300, ...options }
  const inbox = new Inbox({ previewChars: opts.previewChars })
  const hop = new HopTracker()
  const claims = new ClaimTracker()
  const changed: string[] = []
  const tools = new Map(
    buildTools({
      link,
      inbox,
      registry: registryOf(record("s1"), record("off", { optedOut: true })),
      hop,
      claims,
      options: opts,
      onChannelsChanged: (id) => changed.push(id),
    }).map((t) => [t.name, t]),
  )
  return {
    link,
    inbox,
    hop,
    claims,
    changed,
    tools,
    run: async (name, input, sessionID = "s1", signal) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`no tool ${name}`)
      const res = await tool.execute(input, signal ? { sessionID, signal } : { sessionID })
      return res.content
    },
  }
}

describe("buildTools", () => {
  test("exposes the eight tools with JSON schemas", () => {
    const h = harness()
    expect([...h.tools.keys()]).toEqual(["send", "ask", "wait", "read", "join", "part", "names", "list", "release"])
    for (const t of h.tools.values()) {
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.input["type"]).toBe("object")
    }
    expect(h.tools.get("send")?.description).toContain("acknowledgement")
  })
})

describe("send", () => {
  test("sends a PRIVMSG with hop and reply tags", async () => {
    const h = harness()
    h.hop.startTurn("s1", 2, false)
    const out = await h.run("send", { target: "bob", text: "hi there", replyTo: "abc" })
    expect(out).toBe("Sent to bob (msgid m1).")
    const call = h.link.sendAsCalls[0]
    expect(call?.account).toBe("s1")
    expect(call?.inner.command).toBe("PRIVMSG")
    expect(call?.inner.params).toEqual(["bob", "hi there"])
    expect(getTag(call?.inner as IrcMessage, "+agent-comms.local/hop")).toBe("3")
    expect(getTag(call?.inner as IrcMessage, "+draft/reply")).toBe("abc")
  })

  test("omits the reply tag without replyTo", async () => {
    const h = harness()
    await h.run("send", { target: "#dev", text: "status" })
    expect(getTag(h.link.sendAsCalls[0]?.inner as IrcMessage, "+draft/reply")).toBeUndefined()
    expect(getTag(h.link.sendAsCalls[0]?.inner as IrcMessage, "+agent-comms.local/hop")).toBe("1")
  })

  test("rejects a message over the size limit", async () => {
    const h = harness({ maxMessageBytes: 20 })
    const out = await h.run("send", { target: "bob", text: "é".repeat(15) })
    expect(out).toBe(
      "Error: message is 30 bytes; the limit is 20. Write the content to a file and send the path instead.",
    )
    expect(h.link.sendAsCalls).toHaveLength(0)
  })

  test("sends a multiline message as a batch", async () => {
    const h = harness()
    const out = await h.run("send", { target: "#dev", text: "one\r\ntwo\nthree" })
    expect(out).toBe("Sent to #dev (msgid m1).")
    expect(h.link.sendAsCalls).toHaveLength(0)
    expect(h.link.multiCalls[0]?.lines).toEqual(["one", "two", "three"])
    expect(h.link.multiCalls[0]?.target).toBe("#dev")
    expect(h.link.multiCalls[0]?.tags.some(([k]) => k === "+agent-comms.local/hop")).toBe(true)
  })

  test("rejects NUL and lone CR", async () => {
    const h = harness()
    expect(await h.run("send", { target: "bob", text: "a\0b" })).toContain("CR or NUL")
    expect(await h.run("send", { target: "bob", text: "a\rb" })).toContain("CR or NUL")
    expect(h.link.sendAsCalls).toHaveLength(0)
  })

  test("reports a down link", async () => {
    const h = harness()
    h.link.state = "down"
    expect(await h.run("send", { target: "bob", text: "hi" })).toBe(
      "Error: IRC server unreachable. The message was NOT sent.",
    )
    h.link.state = "established"
    h.link.throwDown = true
    expect(await h.run("send", { target: "bob", text: "hi" })).toBe(
      "Error: IRC server unreachable. The message was NOT sent.",
    )
  })

  test("reports an unregistered or opted-out session", async () => {
    const h = harness()
    expect(await h.run("send", { target: "bob", text: "hi" }, "nope")).toBe("IRC is off for this session (use /irc on).")
    expect(await h.run("read", {}, "off")).toBe("IRC is off for this session (use /irc on).")
  })

  test("adopts a session that the registry does not know yet", async () => {
    const link = new FakeLink()
    const opts: Options = { ...DEFAULT_OPTIONS }
    const late = record("late")
    const asked: string[] = []
    const tools = buildTools({
      link,
      inbox: new Inbox({ previewChars: 300 }),
      registry: registryOf(record("s1")),
      hop: new HopTracker(),
      claims: new ClaimTracker(),
      options: opts,
      adopt: async (id) => {
        asked.push(id)
        return id === "late" ? late : undefined
      },
    })
    const send = tools.find((t) => t.name === "send")
    if (!send) throw new Error("no send tool")
    const res = await send.execute({ target: "bob", text: "hi" }, { sessionID: "late" })
    expect(asked).toEqual(["late"])
    expect(res.content).not.toContain("IRC is off")
    const off = await send.execute({ target: "bob", text: "hi" }, { sessionID: "stranger" })
    expect(off.content).toBe("IRC is off for this session (use /irc on).")
  })

  test("maps SENDFAIL codes", async () => {
    const h = harness()
    h.link.sendResult = { ok: false, code: "NOSUCHNICK", reason: "no such nick" }
    expect(await h.run("send", { target: "ghost", text: "hi" })).toContain("no such nick/agent")
    h.link.sendResult = { ok: false, code: "BROADCASTDENIED", reason: "" }
    expect(await h.run("send", { target: "#dev", text: "@all hi" })).toBe(
      "Error: BROADCASTDENIED: @all is reserved for the operator",
    )
    h.link.sendResult = { ok: false, code: "WEIRD", reason: "odd" }
    expect(await h.run("send", { target: "bob", text: "hi" })).toBe("Error: WEIRD: odd")
  })

  test("validates input", async () => {
    const h = harness()
    expect(await h.run("send", { text: "hi" })).toContain("target is required")
    expect(await h.run("send", { target: "bob", text: 5 })).toContain("text must be a string")
    expect(await h.run("send", "nope")).toContain("must be an object")
  })
})

describe("ask and wait", () => {
  test("returns the reply", async () => {
    const h = harness()
    h.link.sendResult = { ok: true, msgid: "q1" }
    const p = h.run("ask", { target: "bob", question: "why?", timeoutSec: 5 })
    await Bun.sleep(10)
    expect(h.inbox.hasWaiter("s1")).toBe(true)
    h.inbox.offer("s1", inbound({ msgid: "r1", text: "because", replyTo: "q1" }), true)
    expect(await p).toBe("Answer from bob (msgid r1):\nbecause")
  })

  test("returns early on another directed message, then wait continues", async () => {
    const h = harness()
    h.link.sendResult = { ok: true, msgid: "q1" }
    const p = h.run("ask", { target: "bob", question: "why?", timeoutSec: 5 })
    await Bun.sleep(10)
    h.inbox.offer("s1", inbound({ msgid: "x1", senderNick: "carol", text: "urgent", target: "me", isChannel: false }), true)
    const out = await p
    expect(out).toBe(
      'No answer yet. A directed message arrived first from carol in DM (msgid x1):\nurgent\nHandle it, then call irc_wait with msgid "q1" to keep waiting for the answer.',
    )
    const w = h.run("wait", { msgid: "q1", timeoutSec: 5 })
    await Bun.sleep(10)
    h.inbox.offer("s1", inbound({ msgid: "r2", text: "done", replyTo: "q1" }), true)
    expect(await w).toBe("Answer from bob (msgid r2):\ndone")
  })

  test("times out", async () => {
    const h = harness()
    h.link.sendResult = { ok: true, msgid: "q9" }
    const out = await h.run("ask", { target: "bob", question: "why?", timeoutSec: 0.03 })
    expect(out).toBe("No answer within 0.03s. A late answer will arrive as a normal message. (question msgid q9)")
    const w = await h.run("wait", { msgid: "q9", timeoutSec: 0.02 })
    expect(w).toContain("No answer within 0.02s")
  })

  test("is cancelled by the abort signal", async () => {
    const h = harness()
    const ac = new AbortController()
    const p = h.run("wait", { msgid: "q1", timeoutSec: 5 }, "s1", ac.signal)
    await Bun.sleep(5)
    ac.abort()
    expect(await p).toBe("Cancelled.")
  })

  test("ask does not wait when the send fails", async () => {
    const h = harness()
    h.link.state = "down"
    const out = await h.run("ask", { target: "bob", question: "why?" })
    expect(out).toContain("NOT sent")
    expect(h.inbox.hasWaiter("s1")).toBe(false)
  })

  test("a directed message that arrives while the question is sent returns early", async () => {
    const h = harness()
    h.link.sendResult = { ok: true, msgid: "q1" }
    h.link.beforeSendResult = () => {
      expect(
        h.inbox.offer("s1", inbound({ msgid: "x1", senderNick: "carol", text: "urgent", target: "me", isChannel: false }), true),
      ).toBe("buffered")
    }
    const started = Date.now()
    const out = await h.run("ask", { target: "bob", question: "why?", timeoutSec: 5 })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(out).toStartWith("No answer yet. A directed message arrived first from carol in DM (msgid x1)")
    expect(h.inbox.hasWaiter("s1")).toBe(false)
  })

  test("a reply that arrives before the send resolves is returned", async () => {
    const h = harness()
    h.link.sendResult = { ok: true, msgid: "q1" }
    h.link.beforeSendResult = () => {
      expect(h.inbox.offer("s1", inbound({ msgid: "r1", text: "fast", replyTo: "q1" }), false)).toBe("buffered")
    }
    const started = Date.now()
    const out = await h.run("ask", { target: "bob", question: "why?", timeoutSec: 5 })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(out).toBe("Answer from bob (msgid r1):\nfast")
  })

  test("unused buffered messages are redelivered after the ask", async () => {
    const link = new FakeLink()
    const inbox = new Inbox({ previewChars: 300 })
    const redelivered: Array<{ sessionID: string; msgids: string[] }> = []
    const tools = buildTools({
      link,
      inbox,
      registry: registryOf(record("s1")),
      hop: new HopTracker(),
      claims: new ClaimTracker(),
      options: DEFAULT_OPTIONS,
      redeliver: (sessionID, messages) => redelivered.push({ sessionID, msgids: messages.map((m) => m.msgid) }),
    })
    const ask = tools.find((t) => t.name === "ask")
    link.sendResult = { ok: true, msgid: "q1" }
    link.beforeSendResult = () => {
      inbox.offer("s1", inbound({ msgid: "x1", target: "me", isChannel: false }), true)
      inbox.offer("s1", inbound({ msgid: "r1", text: "fast", replyTo: "q1" }), false)
    }
    const res = await ask?.execute({ target: "bob", question: "why?", timeoutSec: 5 }, { sessionID: "s1" })
    expect(res?.content).toBe("Answer from bob (msgid r1):\nfast")
    expect(redelivered).toEqual([{ sessionID: "s1", msgids: ["x1"] }])
  })

  test("buffered messages are released as unread when the send fails", async () => {
    const h = harness()
    h.link.sendResult = { ok: false, code: "NOSUCHNICK", reason: "" }
    h.link.beforeSendResult = () => {
      h.inbox.offer("s1", inbound({ msgid: "x1", target: "me", isChannel: false }), true)
    }
    expect(await h.run("ask", { target: "ghost", question: "why?" })).toContain("no such nick/agent")
    expect(h.inbox.totalUnread("s1")).toBe(1)
    expect(h.inbox.get("s1", "x1")?.msgid).toBe("x1")
  })

  test("rejects a bad timeout", async () => {
    const h = harness()
    expect(await h.run("wait", { msgid: "q1", timeoutSec: 0 })).toContain("greater than 0")
  })
})

describe("read", () => {
  test("returns previews, marks read and sends MARKREAD", async () => {
    const h = harness({ previewChars: 10 })
    h.inbox.add("s1", inbound({ msgid: "a", text: "short", time: "2026-01-01T00:00:01.000Z" }), true)
    h.inbox.add("s1", inbound({ msgid: "b", text: "a very long message text", time: "2026-01-01T00:00:02.000Z" }), true)
    const out = await h.run("read", {})
    expect(out.split("\n")).toEqual([
      "[2026-01-01T00:00:01.000Z] #lobby <bob> short (msgid a)",
      "[2026-01-01T00:00:02.000Z] #lobby <bob> a very lon… (msgid b; truncated, use irc_read with msgid for full text)",
    ])
    expect(h.inbox.totalUnread("s1")).toBe(0)
    const mark = h.link.queries.find((q) => q.inner.command === "MARKREAD")
    expect(mark?.account).toBe("s1")
    expect(mark?.inner.params).toEqual(["#lobby", "timestamp=2026-01-01T00:00:02.000Z"])
    expect(await h.run("read", {})).toBe("No unread messages.")
  })

  test("reads one message in full by msgid", async () => {
    const h = harness({ previewChars: 5 })
    h.inbox.add("s1", inbound({ msgid: "a", text: "a very long message text" }), true)
    expect(await h.run("read", { msgid: "a" })).toBe(
      "[2026-01-01T00:00:00.000Z] #lobby <bob> (msgid a)\na very long message text",
    )
    expect(await h.run("read", { msgid: "zzz" })).toContain("Unknown msgid")
  })

  test("falls back to server history for a target", async () => {
    const h = harness()
    h.link.queryHandler = (inner) =>
      inner.command === "CHATHISTORY"
        ? [
            msg("PRIVMSG", ["#dev", "old news"], {
              source: "carol!c@agent-comms.local",
              tags: [
                ["time", "2026-01-01T00:00:00.000Z"],
                ["msgid", "h1"],
              ],
            }),
          ]
        : []
    const out = await h.run("read", { target: "#dev", limit: 5 })
    expect(out).toContain("[2026-01-01T00:00:00.000Z] #dev <carol> old news (msgid h1)")
    const q = h.link.queries[0]?.inner
    expect(q?.command).toBe("CHATHISTORY")
    expect(q?.params).toEqual(["LATEST", "#dev", "*", "5"])
  })
})

describe("join, part and names", () => {
  test("join returns topic and context", async () => {
    const h = harness({ joinContextLines: 3 })
    h.link.queryHandler = (inner) => {
      switch (inner.command) {
        case "JOIN":
          return [msg("JOIN", ["#dev"], { source: "me!s1@agent-comms.local" })]
        case "TOPIC":
          return [msg("332", ["me", "#dev", "the topic"])]
        case "CHATHISTORY":
          return [
            msg("PRIVMSG", ["#dev", "first line"], {
              source: "carol!c@agent-comms.local",
              tags: [
                ["time", "2026-01-01T00:00:00.000Z"],
                ["msgid", "h1"],
              ],
            }),
          ]
        default:
          return []
      }
    }
    const out = await h.run("join", { channel: "#dev" })
    expect(out).toContain("Joined #dev.")
    expect(out).toContain("Topic: the topic")
    expect(out).toContain("<carol> first line (msgid h1)")
    expect(h.changed).toEqual(["s1"])
    const hist = h.link.queries.find((q) => q.inner.command === "CHATHISTORY")
    expect(hist?.inner.params).toEqual(["LATEST", "#dev", "*", "3"])
  })

  test("join rejects a non-channel and reports server errors", async () => {
    const h = harness()
    expect(await h.run("join", { channel: "dev" })).toContain('starts with "#"')
    h.link.queryHandler = () => [msg("473", ["me", "#dev", "Cannot join channel (+i)"])]
    expect(await h.run("join", { channel: "#dev" })).toContain("473")
    expect(h.changed).toEqual([])
    h.link.state = "down"
    expect(await h.run("join", { channel: "#dev" })).toBe("Error: IRC server unreachable.")
  })

  test("part leaves the channel", async () => {
    const h = harness()
    h.link.queryHandler = () => [msg("PART", ["#dev"], { source: "me!s1@agent-comms.local" })]
    expect(await h.run("part", { channel: "#dev", reason: "done" })).toBe("Left #dev.")
    expect(h.link.queries[0]?.inner.params).toEqual(["#dev", "done"])
    expect(h.changed).toEqual(["s1"])
  })

  test("names strips prefixes and marks away members", async () => {
    const h = harness()
    h.link.queryHandler = (inner) => {
      if (inner.command === "NAMES") {
        return [msg("353", ["me", "=", "#dev", "@alice +bob carol"]), msg("366", ["me", "#dev", "End of /NAMES list"])]
      }
      if (inner.command === "WHO") {
        return [
          msg("352", ["me", "#dev", "u", "h", "srv", "alice", "H@", "0 Alice"]),
          msg("352", ["me", "#dev", "u", "h", "srv", "bob", "G+", "0 Bob"]),
        ]
      }
      return []
    }
    const out = await h.run("names", { channel: "#dev" })
    expect(out).toContain("Members of #dev (3): alice, bob (away), carol")
    expect(out).toContain("AWAY")
  })

  test("list shows channel kinds, awake counts and filters active ones", async () => {
    const h = harness()
    h.link.queryHandler = (inner) => {
      if (inner.command === "LIST") {
        return [
          msg("321", ["me", "Channel", "Users  Name"]),
          msg("322", ["me", "#lobby", "3", "Everyone"]),
          msg("322", ["me", "#webapp", "2", ""]),
          msg("322", ["me", "#fix-auth", "2", ""]),
          msg("322", ["me", "#quiet", "1", "nobody home"]),
          msg("323", ["me", "End of /LIST"]),
        ]
      }
      if (inner.command === "WHO") {
        const ch = inner.params[0]
        const rows: Record<string, Array<[string, string]>> = {
          "#lobby": [["fix-auth", "H"], ["docs-bot", "G"], ["alice", "H*"]],
          "#webapp": [["fix-auth", "H"], ["docs-bot", "G"]],
          "#fix-auth": [["fix-auth", "H@"], ["fix-auth|explore1", "G"]],
          "#quiet": [["docs-bot", "G"]],
        }
        return (rows[ch ?? ""] ?? []).map(([n, f]) => msg("352", ["me", ch ?? "", "u", "h", "srv", n, f, "0 x"]))
      }
      return []
    }
    const out = await h.run("list", {})
    expect(out).toContain("Channels (4):")
    expect(out).toContain("#lobby [lobby] 3 member(s), 2 awake — Everyone")
    expect(out).toContain("#fix-auth [family] 2 member(s), 1 awake")
    expect(out).toContain("#webapp [project/ad-hoc] 2 member(s), 1 awake")
    expect(out).toContain("#quiet [project/ad-hoc] 1 member(s), 0 awake")
    expect(h.link.queries[0]?.inner.command).toBe("LIST")

    const active = await h.run("list", { activeOnly: true })
    expect(active).toContain("Channels (3 active):")
    expect(active).not.toContain("#quiet")
  })
})

describe("release", () => {
  test("releases a single claim", async () => {
    const h = harness()
    h.claims.record("s1", "/tmp/a.txt")
    h.claims.record("s1", "/tmp/b.txt")
    const out = await h.run("release", { path: "/tmp/a.txt" })
    expect(out).toBe("Released 1 claim(s): /tmp/a.txt.")
    expect(h.link.requests).toHaveLength(1)
    expect(h.link.requests[0]?.command).toBe("RELEASE")
    expect(h.link.requests[0]?.params).toEqual(["s1", "/tmp/a.txt"])
    expect(h.claims.held("s1")).toEqual(["/tmp/b.txt"])
  })

  test("resolves a relative path", async () => {
    const h = harness()
    await h.run("release", { path: "rel/file.ts" })
    expect(h.link.requests[0]?.params[1]).toBe(resolve(process.cwd(), "rel/file.ts"))
  })

  test("releases all claims", async () => {
    const h = harness()
    h.claims.record("s1", "/tmp/a.txt")
    h.claims.record("s1", "/tmp/b.txt")
    const out = await h.run("release", {})
    expect(out).toContain("Released 2 claim(s)")
    expect(h.link.requests.map((r) => r.params[1]).sort()).toEqual(["/tmp/a.txt", "/tmp/b.txt"])
    expect(h.claims.held("s1")).toEqual([])
    expect(await h.run("release", {})).toBe("You hold no claims.")
  })

  test("reports NOT_HELD", async () => {
    const h = harness()
    h.link.requestHandler = () => msg("FAIL", ["RELEASE", "NOT_HELD", "s1", "not held"])
    const out = await h.run("release", { path: "/tmp/x" })
    expect(out).toContain("you do not hold this claim")
  })
})

describe("registerTools", () => {
  test("registers the tools in the irc namespace and adapts the context", async () => {
    const h = harness()
    const added: Array<{ name: string; options?: { namespace?: string }; execute: (i: unknown, c: unknown) => Promise<{ content: string }> }> = []
    let namespace: { name: string; description: string } | undefined
    let disposed = false
    const fakeCtx = {
      tool: {
        transform: async (cb: (e: unknown) => void) => {
          cb({
            namespace: (n: { name: string; description: string }) => {
              namespace = n
            },
            add: (t: (typeof added)[number]) => {
              added.push(t)
            },
          })
          return {
            dispose: async () => {
              disposed = true
            },
          }
        },
      },
    }
    const deps: ToolDeps = {
      link: h.link,
      inbox: h.inbox,
      registry: registryOf(record("s1")),
      hop: h.hop,
      claims: h.claims,
      options: DEFAULT_OPTIONS,
    }
    const reg = await registerTools(fakeCtx as unknown as Parameters<typeof registerTools>[0], deps)
    expect(namespace?.name).toBe("irc")
    expect(added.map((t) => t.name)).toEqual(["send", "ask", "wait", "read", "join", "part", "names", "list", "release"])
    expect(added.every((t) => t.options?.namespace === "irc")).toBe(true)
    const send = added.find((t) => t.name === "send")
    const res = await send?.execute({ target: "bob", text: "hi" }, { sessionID: "s1", signal: new AbortController().signal })
    expect(res?.content).toBe("Sent to bob (msgid m1).")
    await reg.dispose()
    expect(disposed).toBe(true)
  })
})
