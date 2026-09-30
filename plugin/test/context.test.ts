import { describe, expect, test } from "bun:test"
import { buildContext, CONTEXT_CHAR_CAP, PROTOCOL } from "../src/context.ts"
import type { ContextInput } from "../src/context.ts"

function input(over: Partial<ContextInput> = {}): ContextInput {
  return {
    nick: "fix-auth",
    optedOut: false,
    channels: ["#lobby", "#agent-comms", "#fix-auth"],
    unread: [],
    budget: { used: 2, limit: 10, resetsInMs: 60_000 },
    linkState: "up",
    failMode: "ask",
    hopBlocked: 0,
    joinContext: null,
    ...over,
  }
}

describe("buildContext", () => {
  test("normal text", () => {
    const text = buildContext(
      input({
        unread: [
          { target: "#agent-comms", count: 3 },
          { target: "docs-bot", count: 1 },
        ],
      }),
    )
    expect(text).toBe(
      'IRC (agent-comms): you are "fix-auth" in #lobby, #agent-comms, #fix-auth. ' +
        "Unread: #agent-comms 3, DM docs-bot 1 (use irc_read). " +
        "Wake budget 2/10 used. " +
        "Tools: irc_send (announce/reply; no acknowledgement-only messages), irc_ask (blocking question), irc_wait, irc_read, irc_join, irc_part, irc_names, irc_list, irc_release. " +
        PROTOCOL,
    )
  })

  test("tells the agent to use IRC to reach other agents", () => {
    const text = buildContext(input())
    expect(text).toContain("Other agents cannot see your conversation")
    expect(text).toContain("irc_ask")
    expect(text).toContain("agent-comms skill")
  })

  test("no unread line when nothing is unread", () => {
    expect(buildContext(input())).not.toContain("Unread")
  })

  test("at most 5 unread targets then +N more", () => {
    const unread = Array.from({ length: 8 }, (_, i) => ({ target: `#c${i}`, count: 8 - i }))
    const text = buildContext(input({ unread }))
    expect(text).toContain("#c0 8, #c1 7, #c2 6, #c3 5, #c4 4, +3 more (use irc_read).")
    expect(text).not.toContain("#c5")
  })

  test("budget used up", () => {
    const text = buildContext(input({ budget: { used: 10, limit: 10, resetsInMs: 5 * 60_000 } }))
    expect(text).toContain("Wake budget 10/10 used.")
    expect(text).toContain("Wake budget used up: agent messages wait as unread until 5 min.")
    expect(buildContext(input())).not.toContain("used up")
  })

  test("hop blocked note", () => {
    expect(buildContext(input({ hopBlocked: 2 }))).toContain("2 agent message(s) held back by the hop limit.")
    expect(buildContext(input())).not.toContain("hop limit")
  })

  test("offline with fail mode open", () => {
    const text = buildContext(input({ linkState: "down", failMode: "open" }))
    expect(text).toContain(
      "IRC offline: messages cannot be sent; file claims are not enforced; check with the user before editing shared files.",
    )
  })

  test("offline with fail mode ask, deny, and never linked", () => {
    for (const failMode of ["ask", "deny"] as const) {
      const text = buildContext(input({ linkState: "down", failMode }))
      expect(text).toContain(
        "IRC offline: messages cannot be sent; file claims are enforced from cache; other edits need operator approval.",
      )
    }
    expect(buildContext(input({ linkState: "never" }))).toContain("IRC offline")
    expect(buildContext(input())).not.toContain("offline")
  })

  test("opted out", () => {
    const text = buildContext(input({ optedOut: true, nick: null }))
    expect(text).toContain("off for this session")
    expect(text).toContain("/irc on")
    expect(text).toContain("Claims by other agents still apply")
    expect(text).not.toContain("Tools:")
  })

  test("nick not yet assigned", () => {
    expect(buildContext(input({ nick: null }))).toContain("nick not assigned yet")
  })

  test("join context is appended and not capped", () => {
    const join = "Joined #x. Topic: (none). Recent messages:\n" + "z".repeat(3000)
    const text = buildContext(input({ joinContext: join }))
    expect(text.endsWith(join)).toBe(true)
    expect(text.length).toBeGreaterThan(3000)
  })

  test("main text is capped at CONTEXT_CHAR_CAP characters", () => {
    const channels = Array.from({ length: 200 }, (_, i) => `#channel-number-${i}`)
    const text = buildContext(input({ channels }))
    expect(text.length).toBeLessThanOrEqual(CONTEXT_CHAR_CAP)
    expect(text.endsWith("…")).toBe(true)
  })
})
