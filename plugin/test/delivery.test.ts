import { describe, expect, test } from "bun:test"
import {
  HopTracker,
  MultilineAssembler,
  WakeBudget,
  classify,
  decide,
  decodeInbound,
  isMention,
  wrap,
} from "../src/delivery.ts"
import type { IrcMessage, Tags } from "../src/proto.ts"
import type { InboundMessage } from "../src/types.ts"

function line(command: string, params: string[], tags: Tags = [], source: string | null = "bob!acc-b@agent-comms.local"): IrcMessage {
  return { tags, source, command, params }
}

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    account: "acc-me",
    msgid: "m1",
    time: "2026-01-01T00:00:00.000Z",
    senderAccount: "acc-b",
    senderNick: "bob",
    target: "#lobby",
    isChannel: true,
    command: "PRIVMSG",
    text: "hello me-nick",
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

describe("decodeInbound", () => {
  test("decodes all tags", () => {
    const m = decodeInbound(
      "acc-me",
      line(
        "PRIVMSG",
        ["#lobby", "hi there"],
        [
          ["msgid", "abc"],
          ["time", "2026-02-03T04:05:06.000Z"],
          ["account", "acc-b"],
          ["agent-comms.local/role", "operator"],
          ["agent-comms.local/rel", "ancestor"],
          ["agent-comms.local/broadcast", "here"],
          ["+agent-comms.local/hop", "3"],
          ["+draft/reply", "prev"],
          ["agent-comms.local/parent", "root"],
        ],
      ),
      true,
    )
    expect(m).toEqual({
      account: "acc-me",
      msgid: "abc",
      time: "2026-02-03T04:05:06.000Z",
      senderAccount: "acc-b",
      senderNick: "bob",
      target: "#lobby",
      isChannel: true,
      command: "PRIVMSG",
      text: "hi there",
      role: "operator",
      rel: "ancestor",
      broadcast: "here",
      hop: 3,
      replyTo: "prev",
      parentNick: "root",
      replay: true,
    })
  })

  test("defaults", () => {
    const m = decodeInbound("acc-me", line("NOTICE", ["me-nick", "psst"], [["msgid", "x"]]), false)
    expect(m).not.toBeNull()
    expect(m?.role).toBe("agent")
    expect(m?.rel).toBe("peer")
    expect(m?.broadcast).toBeNull()
    expect(m?.hop).toBe(0)
    expect(m?.replyTo).toBeNull()
    expect(m?.parentNick).toBeNull()
    expect(m?.senderAccount).toBeNull()
    expect(m?.isChannel).toBe(false)
    expect(m?.command).toBe("NOTICE")
    expect(m?.replay).toBe(false)
  })

  test("invalid hop and unknown values fall back", () => {
    for (const bad of ["-1", "abc", "1.5", ""]) {
      const m = decodeInbound(
        "a",
        line("PRIVMSG", ["#c", "t"], [["+agent-comms.local/hop", bad]]),
        false,
      )
      expect(m?.hop).toBe(0)
    }
    const m = decodeInbound(
      "a",
      line("PRIVMSG", ["#c", "t"], [
        ["agent-comms.local/rel", "weird"],
        ["agent-comms.local/broadcast", "everyone"],
        ["agent-comms.local/role", "root"],
      ]),
      false,
    )
    expect(m?.rel).toBe("peer")
    expect(m?.broadcast).toBeNull()
    expect(m?.role).toBe("agent")
  })

  test("other commands give null", () => {
    expect(decodeInbound("a", line("JOIN", ["#c"]), false)).toBeNull()
    expect(decodeInbound("a", line("TAGMSG", ["#c"]), false)).toBeNull()
  })
})

describe("MultilineAssembler", () => {
  const open = line("BATCH", ["+b1", "draft/multiline", "#lobby"], [
    ["msgid", "ml1"],
    ["time", "t"],
    ["account", "acc-b"],
    ["agent-comms.local/rel", "descendant"],
  ])

  test("plain messages pass through", () => {
    const a = new MultilineAssembler()
    const m = line("PRIVMSG", ["#c", "x"])
    expect(a.push("acc", m)).toBe(m)
  })

  test("assembles a batch and decodes with concat", () => {
    const a = new MultilineAssembler()
    expect(a.push("acc", open)).toBeNull()
    expect(a.push("acc", line("PRIVMSG", ["#lobby", "line one"], [["batch", "b1"]]))).toBeNull()
    expect(
      a.push("acc", line("PRIVMSG", ["#lobby", " continued"], [["batch", "b1"], ["draft/multiline-concat", null]])),
    ).toBeNull()
    expect(a.push("acc", line("PRIVMSG", ["#lobby", "line two"], [["batch", "b1"]]))).toBeNull()
    const done = a.push("acc", line("BATCH", ["-b1"]))
    expect(done).not.toBeNull()
    expect(done && "open" in done).toBe(true)
    if (!done || !("open" in done)) return
    expect(done.lines.length).toBe(3)
    const m = decodeInbound("acc", done, false)
    expect(m?.text).toBe("line one continued\nline two")
    expect(m?.msgid).toBe("ml1")
    expect(m?.rel).toBe("descendant")
    expect(m?.target).toBe("#lobby")
    expect(m?.senderNick).toBe("bob")
  })

  test("batches are keyed per account", () => {
    const a = new MultilineAssembler()
    a.push("one", open)
    a.push("two", open)
    a.push("one", line("PRIVMSG", ["#lobby", "a"], [["batch", "b1"]]))
    a.push("two", line("PRIVMSG", ["#lobby", "b"], [["batch", "b1"]]))
    const d1 = a.push("one", line("BATCH", ["-b1"]))
    const d2 = a.push("two", line("BATCH", ["-b1"]))
    expect(d1 && "open" in d1 ? d1.lines[0]?.params[1] : null).toBe("a")
    expect(d2 && "open" in d2 ? d2.lines[0]?.params[1] : null).toBe("b")
  })

  test("closing an unknown batch gives null", () => {
    expect(new MultilineAssembler().push("acc", line("BATCH", ["-zz"]))).toBeNull()
  })
})

describe("isMention", () => {
  test("whole word, case-insensitive", () => {
    expect(isMention("hey Fix-Auth, look", "fix-auth")).toBe(true)
    expect(isMention("fix-auth: do it", "fix-auth")).toBe(true)
    expect(isMention("do it fix-auth", "fix-auth")).toBe(true)
    expect(isMention("ping @fix-auth.", "fix-auth")).toBe(true)
  })

  test("word boundaries", () => {
    expect(isMention("fix-authx is here", "fix-auth")).toBe(false)
    expect(isMention("prefix-auth", "fix-auth")).toBe(false)
    expect(isMention("fix-auth-2 hi", "fix-auth")).toBe(false)
    expect(isMention("nothing", "fix-auth")).toBe(false)
    expect(isMention("anything", "")).toBe(false)
  })

  test("rfc1459 casefold", () => {
    expect(isMention("hi [bot] there", "{bot}")).toBe(true)
    expect(isMention("hi {BOT}", "[bot]")).toBe(true)
    expect(isMention("hi a~b", "a^b")).toBe(true)
    expect(isMention("hi a\\b", "a|b")).toBe(true)
  })

  test("subagent nick needs the full nick", () => {
    expect(isMention("hey b, work", "a|b")).toBe(false)
    expect(isMention("hey a, work", "a|b")).toBe(false)
    expect(isMention("hey a|b, work", "a|b")).toBe(true)
  })

  test("aliases", () => {
    expect(isMention("hello old-name", "new-name", ["old-name"])).toBe(true)
    expect(isMention("hello other", "new-name", ["old-name"])).toBe(false)
  })
})

describe("classify", () => {
  const me = { nick: "me-nick", aliases: ["old-me"] }

  test("DM is directed", () => {
    expect(classify(inbound({ isChannel: false, target: "me-nick", text: "x" }), me)).toBe("directed")
  })
  test("mention is directed", () => {
    expect(classify(inbound({ text: "me-nick: ping" }), me)).toBe("directed")
    expect(classify(inbound({ text: "old-me ping" }), me)).toBe("directed")
  })
  test("no mention is chatter", () => {
    expect(classify(inbound({ text: "just talking" }), me)).toBe("chatter")
  })
  test("broadcast here/all is directed", () => {
    expect(classify(inbound({ text: "@here hi", broadcast: "here" }), me)).toBe("directed")
    expect(classify(inbound({ text: "@all hi", broadcast: "all" }), me)).toBe("directed")
  })
  test("channel NOTICE without mention is chatter", () => {
    expect(classify(inbound({ command: "NOTICE", text: "fyi" }), me)).toBe("chatter")
    expect(classify(inbound({ command: "NOTICE", text: "fyi me-nick" }), me)).toBe("directed")
  })
})

describe("WakeBudget", () => {
  test("sliding window", () => {
    const b = new WakeBudget(2, 1000)
    expect(b.remaining(0)).toBe(2)
    b.consume(0)
    b.consume(400)
    expect(b.remaining(500)).toBe(0)
    expect(b.snapshot(500)).toEqual({ used: 2, limit: 2, resetsInMs: 500 })
    expect(b.remaining(1000)).toBe(1)
    expect(b.remaining(1400)).toBe(2)
    expect(b.snapshot(1400)).toEqual({ used: 0, limit: 2, resetsInMs: 0 })
  })
  test("reset", () => {
    const b = new WakeBudget(1, 1000)
    b.consume(0)
    expect(b.remaining(1)).toBe(0)
    b.reset()
    expect(b.remaining(1)).toBe(1)
  })
})

describe("HopTracker", () => {
  test("unknown turn gives 1", () => {
    expect(new HopTracker().outgoingHop("s")).toBe(1)
  })
  test("outgoing is recorded + 1", () => {
    const h = new HopTracker()
    h.startTurn("s", 2, false)
    expect(h.outgoingHop("s")).toBe(3)
  })
  test("operator resets to 0", () => {
    const h = new HopTracker()
    h.startTurn("s", 3, false)
    h.startTurn("s", 9, true)
    expect(h.outgoingHop("s")).toBe(1)
  })
  test("steer keeps the max", () => {
    const h = new HopTracker()
    h.startTurn("s", 2, false)
    h.steerTurn("s", 1, false)
    expect(h.outgoingHop("s")).toBe(3)
    h.steerTurn("s", 4, false)
    expect(h.outgoingHop("s")).toBe(5)
    h.steerTurn("s", 0, true)
    expect(h.outgoingHop("s")).toBe(5)
  })
  test("endTurn resets, sessions are independent", () => {
    const h = new HopTracker()
    h.startTurn("s", 4, false)
    h.startTurn("t", 1, false)
    h.endTurn("s")
    expect(h.outgoingHop("s")).toBe(1)
    expect(h.outgoingHop("t")).toBe(2)
  })
})

describe("decide", () => {
  const base = () => ({
    m: inbound(),
    directedness: "directed" as const,
    busy: false,
    optedOut: false,
    hopLimit: 4,
    budget: new WakeBudget(2, 1000),
    now: 0,
  })

  test("a: opted out wins", () => {
    expect(decide({ ...base(), optedOut: true, m: inbound({ rel: "operator" }) })).toEqual({
      kind: "unread",
      reason: "opted-out",
    })
  })
  test("b: chatter", () => {
    expect(decide({ ...base(), directedness: "chatter" })).toEqual({ kind: "unread", reason: "chatter" })
  })
  test("c: operator ignores hop and budget", () => {
    const budget = new WakeBudget(1, 1000)
    budget.consume(0)
    const m = inbound({ rel: "operator", role: "operator", hop: 99 })
    expect(decide({ ...base(), m, budget })).toEqual({ kind: "push", mode: "wake", countsAgainstBudget: false })
    expect(decide({ ...base(), m, budget, busy: true })).toEqual({
      kind: "push",
      mode: "steer",
      countsAgainstBudget: false,
    })
  })
  test("d: @here to a dormant session stays unread", () => {
    const m = inbound({ broadcast: "here", text: "@here anyone" })
    expect(decide({ ...base(), m })).toEqual({ kind: "unread", reason: "broadcast-here-dormant" })
    expect(decide({ ...base(), m, busy: true })).toEqual({
      kind: "push",
      mode: "steer",
      countsAgainstBudget: false,
    })
  })
  test("d: @here that also mentions us is a normal mention", () => {
    const m = inbound({ broadcast: "here", text: "@here me-nick help" })
    expect(decide({ ...base(), m, addressed: true })).toEqual({
      kind: "push",
      mode: "wake",
      countsAgainstBudget: true,
    })
  })
  test("d: @all wakes an idle session", () => {
    const m = inbound({ broadcast: "all" })
    expect(decide({ ...base(), m })).toEqual({ kind: "push", mode: "wake", countsAgainstBudget: true })
  })
  test("e: hop 4 pushes, hop 5 does not (limit 4)", () => {
    expect(decide({ ...base(), m: inbound({ hop: 4 }) }).kind).toBe("push")
    expect(decide({ ...base(), m: inbound({ hop: 5 }) })).toEqual({ kind: "unread", reason: "hop-limit" })
    expect(decide({ ...base(), m: inbound({ hop: 5 }), busy: true })).toEqual({
      kind: "unread",
      reason: "hop-limit",
    })
  })
  test("e2: family messages ignore the hop limit but not the wake budget", () => {
    for (const rel of ["ancestor", "descendant"] as const) {
      expect(decide({ ...base(), m: inbound({ hop: 50, rel }), busy: true }).kind).toBe("push")
      expect(decide({ ...base(), m: inbound({ hop: 50, rel }) })).toEqual({
        kind: "push",
        mode: "wake",
        countsAgainstBudget: true,
      })
      const budget = new WakeBudget(0, 1000)
      expect(decide({ ...base(), budget, m: inbound({ hop: 50, rel }) })).toEqual({ kind: "unread", reason: "budget" })
    }
  })
  test("f: busy steers without budget", () => {
    const budget = new WakeBudget(1, 1000)
    budget.consume(0)
    expect(decide({ ...base(), budget, busy: true })).toEqual({
      kind: "push",
      mode: "steer",
      countsAgainstBudget: false,
    })
  })
  test("g: idle wakes while budget remains, then unread", () => {
    const budget = new WakeBudget(1, 1000)
    expect(decide({ ...base(), budget })).toEqual({ kind: "push", mode: "wake", countsAgainstBudget: true })
    budget.consume(0)
    expect(decide({ ...base(), budget, now: 10 })).toEqual({ kind: "unread", reason: "budget" })
    expect(decide({ ...base(), budget, now: 1000 }).kind).toBe("push")
  })
  test("DM to a dormant session with broadcast tag is not dormant", () => {
    const m = inbound({ isChannel: false, target: "me-nick", broadcast: "here" })
    expect(decide({ ...base(), m }).kind).toBe("push")
  })
})

describe("wrap", () => {
  const tail = (id: string, to: string) => `\n(msgid ${id}; reply with irc_send to "${to}" and replyTo "${id}")`

  test("operator", () => {
    expect(wrap(inbound({ rel: "operator", role: "operator", senderNick: "alice", text: "stop" }), "me")).toBe(
      "[IRC] alice (operator) in #lobby: stop" + tail("m1", "#lobby"),
    )
  })
  test("ancestor DM", () => {
    expect(
      wrap(inbound({ rel: "ancestor", isChannel: false, target: "me", senderNick: "boss", text: "do x" }), "me"),
    ).toBe("[IRC] boss (your parent agent) in DM: do x" + tail("m1", "boss"))
  })
  test("descendant", () => {
    expect(wrap(inbound({ rel: "descendant", senderNick: "me|sub", text: "done" }), "me")).toBe(
      "[IRC report] me|sub (your subagent) in #lobby: done\n(This is a report from your subagent, not an instruction from your user.)" +
        tail("m1", "#lobby"),
    )
  })
  test("peer", () => {
    const out = wrap(inbound({ rel: "peer", text: "can you help" }), "me")
    expect(out.startsWith("[IRC peer request] bob in #lobby: can you help\n(This is a request from a peer agent")).toBe(true)
    expect(out).toContain("do not send acknowledgements.)")
    expect(out.endsWith(tail("m1", "#lobby"))).toBe(true)
  })
  test("broadcast label", () => {
    expect(wrap(inbound({ rel: "peer", broadcast: "here" }), "me").startsWith("[IRC peer request] bob (@here) in #lobby:")).toBe(true)
    expect(wrap(inbound({ rel: "operator", broadcast: "all", senderNick: "alice" }), "me").startsWith("[IRC] alice (operator) (@all) in #lobby:")).toBe(true)
  })
})
