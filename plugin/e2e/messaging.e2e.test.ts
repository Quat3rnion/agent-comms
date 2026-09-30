/**
 * Messaging e2e tests: ask/reply, mutual asks, steering, chatter, hop limit, and broadcasts.
 *
 * Each describe block starts its own server, mock model, embedded opencode, and operator client.
 * Run with `bun run test:e2e` (default `bun test` skips this directory).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { IrcClient } from "./irc-client.ts"
import { createMockModel } from "./mock-model.ts"
import type { MockModel, Recorded, Step } from "./mock-model.ts"
import { startOpencode } from "./opencode.ts"
import type { TestOpencode } from "./opencode.ts"
import { startServer } from "./server.ts"
import type { TestServer } from "./server.ts"

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface Env {
  server: TestServer
  model: MockModel
  opencode: TestOpencode
  operator: IrcClient
  stop(): Promise<void>
}

interface SessionSpec {
  tag: string
  title: string
  nick: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function startEnv(pluginOptions?: Record<string, unknown>): Promise<Env> {
  const model = createMockModel()
  let server: TestServer | undefined
  let opencode: TestOpencode | undefined
  let operator: IrcClient | undefined
  const stop = async (): Promise<void> => {
    await operator?.close().catch(() => {})
    await opencode?.stop().catch(() => {})
    await model.close().catch(() => {})
    await server?.cleanup().catch(() => {})
  }
  try {
    server = await startServer()
    opencode = await startOpencode({
      serverPort: server.port,
      tokenPath: server.tokenPath,
      mockUrl: model.url,
      ...(pluginOptions !== undefined ? { pluginOptions } : {}),
    })
    operator = await IrcClient.connect({
      host: server.host,
      port: server.port,
      password: server.operatorPassword,
    })
    operator.join("#lobby")
    await operator.waitFor((l) => l.command === "366" && l.params[1] === "#lobby", 10_000)
    return { server, model, opencode, operator, stop }
  } catch (error) {
    if (server !== undefined) console.error(`--- server log (tail) ---\n${server.log().split("\n").slice(-40).join("\n")}`)
    await stop()
    throw error
  }
}

function oneLine(text: string | null | undefined, max: number): string {
  if (text === null || text === undefined) return "-"
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** The nick that the plugin context text shows in this request, or null. */
function nickInRequest(r: Recorded): string | null {
  for (const m of r.messages) {
    if (m.role !== "system" && m.role !== "developer") continue
    const found = /IRC \(agent-comms\): you are "([^"]+)"/.exec(m.text)
    if (found?.[1] !== undefined) return found[1]
  }
  return null
}

function diagnostics(env: Env | undefined): string {
  if (env === undefined) return "(no environment)"
  const logs = env.opencode.logs.slice(-40).map((l) => `[${l.level}] ${l.message}`)
  const requests = env.model.requests.map(
    (r) =>
      `#${r.index} ${r.kind} tag=${r.tag} nick=${nickInRequest(r)} answer=${r.answer}\n` +
      `    lastUser=${oneLine(r.lastUser, 200)}\n    lastTool=${oneLine(r.lastToolResult, 200)}`,
  )
  return [
    "--- server log (tail) ---",
    env.server.log().split("\n").slice(-60).join("\n"),
    "--- opencode log (tail) ---",
    logs.join("\n"),
    "--- operator lines (tail) ---",
    env.operator.raw.slice(-25).join("\n"),
    "--- model requests ---",
    requests.join("\n"),
  ].join("\n")
}

async function withDiagnostics(env: Env | undefined, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    console.error(diagnostics(env))
    throw error
  }
}

/** Script matcher: the first user message of the session has the tag. */
function tagged(tag: string): (r: Recorded) => boolean {
  return (r) => r.allText.includes(`[[e2e:${tag}]]`)
}

/** True when a tool result follows the last user message (the model already acted on it). */
function answered(r: Recorded): boolean {
  let last = -1
  r.messages.forEach((m, i) => {
    if (m.role === "user") last = i
  })
  return r.messages.slice(last + 1).some((m) => m.role === "tool")
}

/** Parse the last `(msgid X; reply with irc_send to "Y" and replyTo "X")` hint in a text. */
function replyRef(text: string): { msgid: string; target: string } | null {
  const re = /\(msgid ([^;\s]+); reply with irc_send to "([^"]+)" and replyTo "[^"]*"\)/g
  let out: { msgid: string; target: string } | null = null
  for (const found of text.matchAll(re)) {
    if (found[1] !== undefined && found[2] !== undefined) out = { msgid: found[1], target: found[2] }
  }
  return out
}

/** All msgids of injected `[IRC` messages in the user messages of a request. */
function injectedMsgids(r: Recorded): string[] {
  const ids: string[] = []
  for (const m of r.messages) {
    if (m.role !== "user" || !m.text.includes("[IRC")) continue
    for (const found of m.text.matchAll(/\(msgid ([^;\s]+); reply with irc_send/g)) {
      if (found[1] !== undefined) ids.push(found[1])
    }
  }
  return ids
}

/** Tool result texts of the calls of tool `name` in a request. */
function toolResultsFor(r: Recorded, name: string): string[] {
  const ids = new Set(
    r.messages.flatMap((m) => (m.toolCalls ?? []).filter((c) => c.name === name).map((c) => c.id)),
  )
  return r.messages
    .filter((m) => m.role === "tool" && m.toolCallId !== undefined && ids.has(m.toolCallId))
    .map((m) => m.text)
}

function primaryOf(env: Env, tag: string, since: number): Recorded[] {
  return env.model.requests.filter((r) => r.index >= since && r.kind === "primary" && r.tag === tag)
}

function executionStarts(env: Env, sessionID: string, sinceEvent: number): number {
  return env.opencode.events.slice(sinceEvent).filter((e) => {
    if (e.type !== "session.execution.started") return false
    const data = (e as { data?: unknown }).data
    return typeof data === "object" && data !== null && (data as { sessionID?: unknown }).sessionID === sessionID
  }).length
}

async function waitForNick(env: Env, nick: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let members: string[] = []
  while (Date.now() < deadline) {
    members = await env.operator.names("#lobby")
    if (members.includes(nick)) return
    await sleep(250)
  }
  throw new Error(`nick ${nick} not in #lobby within ${timeoutMs} ms; members: ${members.join(" ")}`)
}

/**
 * Create the sessions, run one tagged first turn in each (opencode then generates the
 * title, and the plugin renames the nick to the title slug), and wait for the nicks.
 * The scripts of the tags must answer a plain "hello" turn with text.
 */
async function setupSessions(env: Env, specs: SessionSpec[]): Promise<string[]> {
  for (const s of specs) env.model.title(s.tag, s.title)
  const ids = await Promise.all(
    specs.map(async (s) => {
      const id = await env.opencode.createSession()
      await env.opencode.prompt(id, "hello", { tag: s.tag })
      return id
    }),
  )
  await Promise.all(ids.map((id) => env.opencode.waitIdle(id, 30_000)))
  for (const s of specs) await waitForNick(env, s.nick)
  // Let the plugin see the idle state of each session.
  await sleep(500)
  return ids
}

/** Wait until no request that matches `predicate` arrives for `quietMs`. Returns the elapsed time. */
async function waitQuiet(
  env: Env,
  predicate: (r: Recorded) => boolean,
  quietMs: number,
  deadlineMs: number,
): Promise<number> {
  const start = Date.now()
  let count = env.model.find(predicate).length
  let lastChange = Date.now()
  while (Date.now() - start < deadlineMs) {
    await sleep(250)
    const now = env.model.find(predicate).length
    if (now !== count) {
      count = now
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= quietMs) {
      return Date.now() - start
    }
  }
  throw new Error(`requests did not stop within ${deadlineMs} ms (${count} matching requests)`)
}

/** A gate that a function step awaits. It opens by itself after `maxMs`, so no test hangs. */
function createGate(maxMs = 30_000): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
    setTimeout(resolve, maxMs)
  })
  return { wait, open }
}

// ---------------------------------------------------------------------------
// 1. ask_reply_same_turn
// ---------------------------------------------------------------------------

describe("ask_reply_same_turn", () => {
  let env: Env | undefined

  beforeAll(async () => {
    env = await startEnv({ askTimeoutMs: 30_000 })
  }, 60_000)

  afterAll(async () => {
    await env?.stop()
  }, 30_000)

  test(
    "irc_ask gets the answer of an idle peer in the same turn",
    async () => {
      await withDiagnostics(env, async () => {
        const e = env as Env
        const GO = "ASK-GO"
        const QUESTION = "what is the new token format?"
        const ANSWER = "JWT with kid header"

        let asked = false
        e.model.script(
          tagged("add-login"),
          [
            (r): Step => {
              if (!answered(r) && r.lastUser.includes(GO) && !asked) {
                asked = true
                return {
                  toolCall: { name: "irc_ask", arguments: { target: "fix-auth", question: QUESTION, timeoutSec: 30 } },
                }
              }
              return { text: "done" }
            },
          ],
          { repeatLast: true },
        )

        const replied = new Set<string>()
        e.model.script(
          tagged("fix-auth"),
          [
            (r): Step => {
              if (!answered(r) && r.lastUser.includes("[IRC peer request] add-login")) {
                const ref = replyRef(r.lastUser)
                if (ref !== null && !replied.has(ref.msgid)) {
                  replied.add(ref.msgid)
                  return {
                    toolCall: {
                      name: "irc_send",
                      arguments: { target: "add-login", text: ANSWER, replyTo: ref.msgid },
                    },
                  }
                }
              }
              return { text: "ready" }
            },
          ],
          { repeatLast: true },
        )

        const [addID] = await setupSessions(e, [
          { tag: "add-login", title: "Add Login", nick: "add-login" },
          { tag: "fix-auth", title: "Fix Auth", nick: "fix-auth" },
        ])
        const mark = e.model.requests.length
        await e.opencode.prompt(addID as string, `${GO} ask fix-auth about the token format`, { tag: "add-login" })

        const woken = await e.model.waitForRequest(
          (r) =>
            r.index >= mark &&
            r.kind === "primary" &&
            r.tag === "fix-auth" &&
            r.lastUser.includes("[IRC peer request] add-login"),
          30_000,
        )
        expect(woken.lastUser).toContain(QUESTION)
        expect(replyRef(woken.lastUser)).not.toBeNull()

        await e.model.waitForRequest(
          (r) =>
            r.index >= mark &&
            r.kind === "primary" &&
            r.tag === "add-login" &&
            (r.lastToolResult ?? "").includes("Answer from"),
          40_000,
        )

        const addRequests = primaryOf(e, "add-login", mark)
        expect(addRequests.length).toBeGreaterThanOrEqual(2)
        const [askRequest, next] = addRequests
        expect(askRequest?.answer).toBe("toolCalls: irc_ask")
        // The request right after the irc_ask call carries the answer. No new user text came in between.
        expect(next?.lastToolResult ?? "").toContain("Answer from fix-auth")
        expect(next?.lastToolResult ?? "").toContain(ANSWER)
        expect(next?.lastUser ?? "").toContain(GO)
        expect(next?.lastUser ?? "").not.toContain("[IRC")

        await e.opencode.waitIdle(addID as string, 30_000)
      })
    },
    90_000,
  )
})

// ---------------------------------------------------------------------------
// 2. mutual_ask_no_deadlock
// ---------------------------------------------------------------------------

describe("mutual_ask_no_deadlock", () => {
  let env: Env | undefined

  beforeAll(async () => {
    env = await startEnv({ askTimeoutMs: 30_000 })
  }, 60_000)

  afterAll(async () => {
    await env?.stop()
  }, 30_000)

  test(
    "two agents that ask each other at the same time both return",
    async () => {
      await withDiagnostics(env, async () => {
        const e = env as Env
        const GO = "MUTUAL-GO"

        const asker = (target: string, question: string) => {
          let asked = false
          return (r: Recorded): Step => {
            if (answered(r)) return { text: "done" }
            if (r.lastUser.includes("[IRC")) return { text: "noted" }
            if (r.lastUser.includes(GO) && !asked) {
              asked = true
              return { toolCall: { name: "irc_ask", arguments: { target, question, timeoutSec: 30 } } }
            }
            return { text: "ready" }
          }
        }
        e.model.script(tagged("mutual-a"), [asker("mutual-beta", "which schema version do you use?")], {
          repeatLast: true,
        })
        e.model.script(tagged("mutual-b"), [asker("mutual-alpha", "which port does your service use?")], {
          repeatLast: true,
        })

        const [aID, bID] = (await setupSessions(e, [
          { tag: "mutual-a", title: "Mutual Alpha", nick: "mutual-alpha" },
          { tag: "mutual-b", title: "Mutual Beta", nick: "mutual-beta" },
        ])) as [string, string]
        const mark = e.model.requests.length

        const started = Date.now()
        await Promise.all([
          e.opencode.prompt(aID, `${GO} ask mutual-beta`, { tag: "mutual-a" }),
          e.opencode.prompt(bID, `${GO} ask mutual-alpha`, { tag: "mutual-b" }),
        ])
        await Promise.all([e.opencode.waitIdle(aID, 60_000), e.opencode.waitIdle(bID, 60_000)])
        const elapsed = Date.now() - started
        expect(elapsed).toBeLessThan(60_000)

        const results = e.model.requests
          .filter((r) => r.index >= mark && r.kind === "primary" && (r.tag === "mutual-a" || r.tag === "mutual-b"))
          .flatMap((r) => toolResultsFor(r, "irc_ask"))
        expect(results.length).toBeGreaterThan(0)
        const early = results.filter((t) => t.includes("No answer yet") || t.includes("Answer from"))
        expect(early.length).toBeGreaterThan(0)
      })
    },
    90_000,
  )
})

// ---------------------------------------------------------------------------
// 3. busy_session_gets_steer
// ---------------------------------------------------------------------------

describe("busy_session_gets_steer", () => {
  let env: Env | undefined

  beforeAll(async () => {
    env = await startEnv()
  }, 60_000)

  afterAll(async () => {
    await env?.stop()
  }, 30_000)

  test(
    "an operator DM to a busy session steers the running turn",
    async () => {
      await withDiagnostics(env, async () => {
        const e = env as Env
        const GO = "SLOW-GO"
        const STEER = "please also update the changelog"
        const gate = createGate()

        let slowDone = false
        e.model.script(
          tagged("steer"),
          [
            async (r): Promise<Step> => {
              if (!answered(r) && r.lastUser.includes(GO) && !slowDone) {
                slowDone = true
                await gate.wait
                return { toolCall: { name: "irc_names", arguments: { channel: "#lobby" } } }
              }
              return { text: "done" }
            },
          ],
          { repeatLast: true },
        )

        const [id] = (await setupSessions(e, [{ tag: "steer", title: "Steer Target", nick: "steer-target" }])) as [
          string,
        ]
        const mark = e.model.requests.length
        const eventMark = e.opencode.events.length
        await e.opencode.prompt(id, `${GO} list the lobby`, { tag: "steer" })

        await e.model.waitForRequest(
          (r) => r.index >= mark && r.kind === "primary" && r.tag === "steer" && r.lastUser.includes(GO),
          20_000,
        )
        // The model request is held. The session is busy now.
        await sleep(700)
        e.operator.privmsg("steer-target", STEER)
        // Give the plugin time to deliver the steer before the slow step ends.
        await sleep(2_000)
        gate.open()

        const steered = await e.model.waitForRequest(
          (r) =>
            r.index >= mark &&
            r.kind === "primary" &&
            r.tag === "steer" &&
            r.allText.includes(STEER) &&
            /\[IRC\] \S+ \(operator\) in DM: /.test(r.allText),
          30_000,
        )
        expect(steered.allText).toContain(GO)

        await e.opencode.waitIdle(id, 30_000)
        // The steer went into the running turn. No second run started.
        expect(executionStarts(e, id, eventMark)).toBe(1)
      })
    },
    90_000,
  )
})

// ---------------------------------------------------------------------------
// 4. chatter_does_not_wake
// ---------------------------------------------------------------------------

describe("chatter_does_not_wake", () => {
  let env: Env | undefined

  beforeAll(async () => {
    env = await startEnv()
  }, 60_000)

  afterAll(async () => {
    await env?.stop()
  }, 30_000)

  test(
    "channel chatter does not wake an idle session; a mention does",
    async () => {
      await withDiagnostics(env, async () => {
        const e = env as Env
        e.model.script(
          tagged("quiet"),
          [(r): Step => (!answered(r) && r.lastUser.includes("[IRC") ? { text: "noted" } : { text: "ready" })],
          { repeatLast: true },
        )

        await setupSessions(e, [{ tag: "quiet", title: "Quiet Listener", nick: "quiet-listener" }])
        const mark = e.model.requests.length

        e.operator.privmsg("#lobby", "the weather is nice today")
        await sleep(3_000)
        expect(primaryOf(e, "quiet", mark)).toHaveLength(0)

        const text = "please check the build"
        e.operator.privmsg("#lobby", `quiet-listener: ${text}`)
        const woken = await e.model.waitForRequest(
          (r) =>
            r.index >= mark &&
            r.kind === "primary" &&
            r.tag === "quiet" &&
            r.lastUser.includes("[IRC]") &&
            r.lastUser.includes(text),
          20_000,
        )
        expect(woken.lastUser).not.toContain("the weather is nice today")
      })
    },
    90_000,
  )
})

// ---------------------------------------------------------------------------
// 5. ack_loop_hop_limit
// ---------------------------------------------------------------------------

describe("ack_loop_hop_limit", () => {
  let env: Env | undefined

  beforeAll(async () => {
    env = await startEnv()
  }, 60_000)

  afterAll(async () => {
    await env?.stop()
  }, 30_000)

  test(
    "a reply loop between two agents stops at the hop limit",
    async () => {
      await withDiagnostics(env, async () => {
        const e = env as Env
        const GO = "LOOP-GO"

        const echo = (me: string, firstTarget: string | null) => {
          const handled = new Set<string>()
          let started = false
          return (r: Recorded): Step => {
            if (answered(r)) return { text: "done" }
            if (r.lastUser.includes("[IRC")) {
              const ref = replyRef(r.lastUser)
              if (ref !== null && !handled.has(ref.msgid)) {
                handled.add(ref.msgid)
                return {
                  toolCall: {
                    name: "irc_send",
                    arguments: { target: ref.target, text: `got it, from ${me}`, replyTo: ref.msgid },
                  },
                }
              }
              return { text: "done" }
            }
            if (firstTarget !== null && r.lastUser.includes(GO) && !started) {
              started = true
              return { toolCall: { name: "irc_send", arguments: { target: firstTarget, text: "ping" } } }
            }
            return { text: "ready" }
          }
        }
        e.model.script(tagged("loop-a"), [echo("loop-alpha", "loop-beta")], { repeatLast: true })
        e.model.script(tagged("loop-b"), [echo("loop-beta", null)], { repeatLast: true })

        const [aID] = (await setupSessions(e, [
          { tag: "loop-a", title: "Loop Alpha", nick: "loop-alpha" },
          { tag: "loop-b", title: "Loop Beta", nick: "loop-beta" },
        ])) as [string, string]
        const mark = e.model.requests.length
        const inLoop = (r: Recorded): boolean =>
          r.index >= mark && r.kind === "primary" && (r.tag === "loop-a" || r.tag === "loop-b")

        await e.opencode.prompt(aID, `${GO} send ping to loop-beta`, { tag: "loop-a" })
        await e.model.waitForRequest((r) => inLoop(r) && r.tag === "loop-b" && r.lastUser.includes("[IRC"), 20_000)

        const elapsed = await waitQuiet(e, inLoop, 5_000, 30_000)
        expect(elapsed).toBeLessThan(30_000)

        const injected = new Set(e.model.find(inLoop).flatMap((r) => injectedMsgids(r)))
        expect(injected.size).toBeGreaterThanOrEqual(1)
        expect(injected.size).toBeLessThanOrEqual(4)
      })
    },
    90_000,
  )
})

// ---------------------------------------------------------------------------
// 6. broadcast_here_and_all
// ---------------------------------------------------------------------------

describe("broadcast_here_and_all", () => {
  let env: Env | undefined

  beforeAll(async () => {
    env = await startEnv()
  }, 60_000)

  afterAll(async () => {
    await env?.stop()
  }, 30_000)

  test(
    "@here steers busy agents only; @all from an agent is refused",
    async () => {
      await withDiagnostics(env, async () => {
        const e = env as Env
        const BUSY_GO = "BUSY-GO"
        const ALL_GO = "ALL-GO"
        const gate = createGate()

        let slowDone = false
        e.model.script(
          tagged("bc-busy"),
          [
            async (r): Promise<Step> => {
              if (answered(r)) return { text: "done" }
              if (r.lastUser.includes("[IRC")) return { text: "noted" }
              if (r.lastUser.includes(BUSY_GO) && !slowDone) {
                slowDone = true
                await gate.wait
                return { toolCall: { name: "irc_names", arguments: { channel: "#lobby" } } }
              }
              return { text: "ready" }
            },
          ],
          { repeatLast: true },
        )

        let sentAll = false
        e.model.script(
          tagged("bc-idle"),
          [
            (r): Step => {
              if (answered(r)) return { text: "done" }
              if (r.lastUser.includes("[IRC")) return { text: "noted" }
              if (r.lastUser.includes(ALL_GO) && !sentAll) {
                sentAll = true
                return { toolCall: { name: "irc_send", arguments: { target: "#lobby", text: "@all hello" } } }
              }
              return { text: "ready" }
            },
          ],
          { repeatLast: true },
        )

        const [busyID, idleID] = (await setupSessions(e, [
          { tag: "bc-busy", title: "Busy Worker", nick: "busy-worker" },
          { tag: "bc-idle", title: "Idle Worker", nick: "idle-worker" },
        ])) as [string, string]
        const mark = e.model.requests.length

        await e.opencode.prompt(busyID, `${BUSY_GO} list the lobby`, { tag: "bc-busy" })
        await e.model.waitForRequest(
          (r) => r.index >= mark && r.kind === "primary" && r.tag === "bc-busy" && r.lastUser.includes(BUSY_GO),
          20_000,
        )
        await sleep(700)

        e.operator.privmsg("#lobby", "@here standup")
        await sleep(3_000)
        // The idle (dormant) agent does not get @here.
        expect(primaryOf(e, "bc-idle", mark)).toHaveLength(0)
        gate.open()

        const steered = await e.model.waitForRequest(
          (r) =>
            r.index >= mark &&
            r.kind === "primary" &&
            r.tag === "bc-busy" &&
            /\[IRC\] \S+ \(operator\) \(@here\) in #lobby: @here standup/.test(r.allText),
          30_000,
        )
        expect(steered.allText).toContain(BUSY_GO)
        await e.opencode.waitIdle(busyID, 30_000)
        expect(primaryOf(e, "bc-idle", mark)).toHaveLength(0)

        const allMark = e.model.requests.length
        await e.opencode.prompt(idleID, `${ALL_GO} greet everybody`, { tag: "bc-idle" })
        const refused = await e.model.waitForRequest(
          (r) =>
            r.index >= allMark &&
            r.kind === "primary" &&
            r.tag === "bc-idle" &&
            toolResultsFor(r, "irc_send").length > 0,
          30_000,
        )
        const result = toolResultsFor(refused, "irc_send").join("\n")
        expect(result).toContain("@all is reserved for the operator")
        await e.opencode.waitIdle(idleID, 30_000)
      })
    },
    90_000,
  )
})
