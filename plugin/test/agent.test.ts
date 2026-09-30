import { describe, expect, test } from "bun:test"
import { AGENT_TEXT_MAX_BYTES, agentText, handleAgentRequest } from "../src/agent.ts"
import type { AgentDeps } from "../src/agent.ts"
import { ClaimTracker } from "../src/claims.ts"
import { WakeBudget } from "../src/delivery.ts"
import { Inbox } from "../src/inbox.ts"
import type { IrcMessage } from "../src/proto.ts"
import { msg } from "../src/proto.ts"
import { Registry } from "../src/registry.ts"
import type { InboundMessage, SessionRecord } from "../src/types.ts"

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
    channels: ["#lobby"],
    ...over,
  }
}

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    account: "ses_a",
    msgid: "m1",
    time: "2026-01-01T00:00:00.000Z",
    senderAccount: "ses_x",
    senderNick: "bob",
    target: "#lobby",
    isChannel: true,
    command: "PRIVMSG",
    text: "hi",
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

function setup() {
  const registry = new Registry(null, "/work")
  registry.put(rec())
  const inbox = new Inbox({ previewChars: 50 })
  const claims = new ClaimTracker()
  const budgets = new Map<string, WakeBudget>()
  const blocked = new Map<string, number>()
  const interrupted: string[] = []
  const state = { failInterrupt: false }
  const deps: AgentDeps = {
    registry,
    inbox,
    claims,
    budget: (id) => {
      let b = budgets.get(id)
      if (!b) {
        b = new WakeBudget(10, 3_600_000)
        budgets.set(id, b)
      }
      return b
    },
    hopBlocked: {
      get: (id) => blocked.get(id) ?? 0,
      reset: (id) => {
        blocked.delete(id)
      },
    },
    interrupt: async (id) => {
      if (state.failInterrupt) throw new Error("boom")
      interrupted.push(id)
    },
    now: () => 1000,
  }
  return { registry, inbox, claims, budgets, blocked, interrupted, state, deps }
}

const req = (id: string, verb: string, account: string): IrcMessage => msg("AGENT", [id, verb, account])
const summary = (lines: IrcMessage[]): string[] => lines.map((l) => `${l.command} ${l.params.join("|")}`)

describe("handleAgentRequest STATUS", () => {
  test("reports idle state, budget, unread, claims, hop-blocked", async () => {
    const s = setup()
    s.deps.budget("ses_a").consume(1000)
    s.inbox.add("ses_a", inbound(), true)
    s.claims.record("ses_a", "/work/a.ts")
    s.claims.record("ses_a", "/work/b.ts")
    s.blocked.set("ses_a", 3)
    const out = await handleAgentRequest(req("r1", "STATUS", "ses_a"), s.deps)
    expect(summary(out)).toEqual([
      "AGENTREPLY r1|ses_a|idle; wake budget 1/10; unread 1; claims 2; hop-blocked 3",
      "AGENTEND r1",
    ])
  })

  test("reports busy and opted-out", async () => {
    const s = setup()
    s.registry.setBusy("ses_a", true)
    let out = await handleAgentRequest(req("r1", "STATUS", "ses_a"), s.deps)
    expect(out[0]?.params[2]).toStartWith("busy;")
    s.registry.setOptedOut("ses_a", true)
    out = await handleAgentRequest(req("r2", "STATUS", "ses_a"), s.deps)
    expect(out[0]?.params[2]).toStartWith("opted-out;")
  })

  test("status text fits in 400 bytes", async () => {
    const s = setup()
    const out = await handleAgentRequest(req("r1", "STATUS", "ses_a"), s.deps)
    expect(new TextEncoder().encode(out[0]?.params[2] ?? "").length).toBeLessThanOrEqual(AGENT_TEXT_MAX_BYTES)
  })
})

describe("handleAgentRequest INTERRUPT and RESUME", () => {
  test("INTERRUPT interrupts the session", async () => {
    const s = setup()
    const out = await handleAgentRequest(req("r1", "INTERRUPT", "ses_a"), s.deps)
    expect(s.interrupted).toEqual(["ses_a"])
    expect(summary(out)).toEqual(["AGENTREPLY r1|ses_a|interrupted", "AGENTEND r1"])
  })

  test("INTERRUPT failure still ends the request", async () => {
    const s = setup()
    s.state.failInterrupt = true
    const out = await handleAgentRequest(req("r1", "INTERRUPT", "ses_a"), s.deps)
    expect(out[0]?.params[2]).toBe("interrupt failed: boom")
    expect(out[1]?.command).toBe("AGENTEND")
  })

  test("RESUME resets budget and hop-blocked counter", async () => {
    const s = setup()
    s.deps.budget("ses_a").consume(1000)
    s.blocked.set("ses_a", 2)
    const out = await handleAgentRequest(req("r1", "RESUME", "ses_a"), s.deps)
    expect(summary(out)).toEqual(["AGENTREPLY r1|ses_a|budget and hop limit reset", "AGENTEND r1"])
    expect(s.deps.budget("ses_a").remaining(1000)).toBe(10)
    expect(s.blocked.get("ses_a")).toBeUndefined()
  })
})

describe("handleAgentRequest errors", () => {
  test("unknown account gets FAIL and AGENTEND", async () => {
    const s = setup()
    const out = await handleAgentRequest(req("r9", "STATUS", "ses_nope"), s.deps)
    expect(summary(out)).toEqual(["FAIL AGENT|UNKNOWN_ACCOUNT|ses_nope|unknown", "AGENTEND r9"])
  })

  test("unknown verb gets a reply and AGENTEND", async () => {
    const s = setup()
    const out = await handleAgentRequest(req("r1", "DANCE", "ses_a"), s.deps)
    expect(out[0]?.command).toBe("AGENTREPLY")
    expect(out[1]?.command).toBe("AGENTEND")
  })

  test("a request without an id gets no reply", async () => {
    const s = setup()
    expect(await handleAgentRequest(msg("AGENT", []), s.deps)).toEqual([])
  })

  test("a request with missing parameters ends", async () => {
    const s = setup()
    const out = await handleAgentRequest(msg("AGENT", ["r1"]), s.deps)
    expect(out[out.length - 1]?.command).toBe("AGENTEND")
  })
})

describe("agentText", () => {
  test("flattens line breaks", () => {
    expect(agentText("a\r\nb\nc")).toBe("a b c")
  })

  test("cuts on a character boundary", () => {
    const out = agentText("é".repeat(300), 401)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(401)
    expect(out).not.toContain("\uFFFD")
    expect(out.length).toBe(200)
  })
})
