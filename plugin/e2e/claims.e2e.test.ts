/**
 * End-to-end tests for file claims, the family exemption, fail-closed behaviour during an
 * IRC server outage, and the wake budget.
 *
 * Run with `bun run test:e2e` (default `bun test` skips this directory).
 * The server binary must exist: `cargo build -p agent-comms`.
 *
 * Each test starts its own server, mock model, opencode host and operator client, because
 * the tests use different plugin options and one test stops the server.
 */
import { afterAll, expect, test } from "bun:test"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { IrcClient } from "./irc-client.ts"
import { createMockModel } from "./mock-model.ts"
import type { MockModel, Recorded, Step } from "./mock-model.ts"
import { removeSharedRoot, startOpencode } from "./opencode.ts"
import type { PermissionRule, TestOpencode } from "./opencode.ts"
import { startServer } from "./server.ts"
import type { TestServer } from "./server.ts"

afterAll(() => {
  removeSharedRoot()
})

// ---------------------------------------------------------------------------
// Local harness helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function clip(text: string | null, max: number): string {
  if (text === null) return "null"
  const flat = text.replace(/\s+/g, " ")
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

interface Env {
  server: TestServer
  model: MockModel
  opencode: TestOpencode
  operator: IrcClient
  diagnostics(): string
  dispose(): Promise<void>
}

async function connectOperator(server: TestServer): Promise<IrcClient> {
  const operator = await IrcClient.connect({
    host: server.host,
    port: server.port,
    password: server.operatorPassword,
  })
  operator.join("#lobby")
  await operator.waitFor((l) => l.command === "366" && l.params[1] === "#lobby", 10_000)
  return operator
}

async function setup(
  options: { pluginOptions?: Record<string, unknown>; permissions?: PermissionRule[] } = {},
): Promise<Env> {
  const model = createMockModel()
  const server = await startServer()
  const start: Parameters<typeof startOpencode>[0] = {
    serverPort: server.port,
    tokenPath: server.tokenPath,
    mockUrl: model.url,
  }
  if (options.pluginOptions !== undefined) start.pluginOptions = options.pluginOptions
  if (options.permissions !== undefined) start.permissions = options.permissions
  const opencode = await startOpencode(start)
  const operator = await connectOperator(server)

  const env: Env = {
    server,
    model,
    opencode,
    operator,
    diagnostics() {
      const logs = opencode.logs.slice(-40).map((l) => `[${l.level}] ${l.message}`)
      const requests = model.requests.map(
        (r) =>
          `#${r.index} ${r.kind} tag=${r.tag} answer=${r.answer} lastUser=${clip(r.lastUser, 120)} ` +
          `lastToolResult=${clip(r.lastToolResult, 200)}`,
      )
      return [
        "--- server log (tail) ---",
        server.log().split("\n").slice(-40).join("\n"),
        "--- opencode log (tail) ---",
        logs.join("\n"),
        "--- operator lines (tail) ---",
        env.operator.raw.slice(-25).join("\n"),
        "--- model requests ---",
        requests.join("\n"),
      ].join("\n")
    },
    async dispose() {
      for (const step of [
        () => env.operator.close(),
        () => opencode.stop(),
        () => model.close(),
        () => server.cleanup(),
      ]) {
        try {
          await step()
        } catch {
          // best effort teardown
        }
      }
    },
  }
  return env
}

/** Run `body` with a fresh environment. Print diagnostics on failure, then tear down. */
async function withEnv(
  options: Parameters<typeof setup>[0],
  body: (env: Env) => Promise<void>,
): Promise<void> {
  const env = await setup(options)
  try {
    await body(env)
  } catch (error) {
    console.error(env.diagnostics())
    throw error
  } finally {
    await env.dispose()
  }
}

const tagIs =
  (tag: string) =>
  (r: Recorded): boolean =>
    r.kind === "primary" && r.tag === tag

/** Argument names of a tool that opencode offered in this request. */
function toolParams(r: Recorded, name: string): string[] {
  const body = r.body as { tools?: unknown } | null
  const tools = body?.tools
  if (!Array.isArray(tools)) return []
  for (const t of tools) {
    const fn = (t as { function?: { name?: unknown; parameters?: { properties?: unknown } } }).function
    if (fn?.name === name) {
      const props = fn.parameters?.properties
      return typeof props === "object" && props !== null ? Object.keys(props) : []
    }
  }
  return []
}

/** A `write` tool call. The argument name for the path comes from the tool schema. */
function writeCall(r: Recorded, path: string, content: string): Step {
  const keys = toolParams(r, "write")
  const key = keys.includes("filePath") ? "filePath" : "path"
  return { toolCall: { name: "write", arguments: { [key]: path, content } } }
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

/** Send CLAIMS and return the NOTICE texts up to `end of CLAIMS`. */
async function claimsList(operator: IrcClient): Promise<string[]> {
  const since = operator.mark()
  operator.quote("CLAIMS")
  await operator.waitFor(
    (l) => l.command === "NOTICE" && (l.params[1] ?? "").includes("end of CLAIMS"),
    10_000,
    { since },
  )
  return operator.lines
    .slice(since)
    .filter((l) => l.command === "NOTICE")
    .map((l) => l.params[1] ?? "")
}

/** Poll CLAIMS until `nick holds path` shows. Returns the matching line. */
async function waitForClaim(operator: IrcClient, nick: string, path: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last: string[] = []
  const needle = `${nick} holds ${path} `
  while (Date.now() < deadline) {
    last = await claimsList(operator)
    const hit = last.find((line) => line.includes(needle))
    if (hit !== undefined) return hit
    await sleep(300)
  }
  throw new Error(`CLAIMS did not show "${needle}" within ${timeoutMs} ms. Last CLAIMS:\n${last.join("\n")}`)
}

/** Poll NAMES #lobby until every nick is present. */
async function waitForNicks(operator: IrcClient, nicks: string[], timeoutMs = 30_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  let last: string[] = []
  while (Date.now() < deadline) {
    last = await operator.names("#lobby")
    if (nicks.every((n) => last.includes(n))) return last
    await sleep(300)
  }
  throw new Error(`nicks ${nicks.join(", ")} not in #lobby within ${timeoutMs} ms. NAMES: ${last.join(" ")}`)
}

// ---------------------------------------------------------------------------
// 1. claim_conflict_denied
// ---------------------------------------------------------------------------

test(
  "claim_conflict_denied: an edit of a file that another session claims is denied",
  async () => {
    await withEnv({}, async ({ model, opencode, operator }) => {
      const file = join(opencode.projectDir, "src", "auth.rs")

      model.title("fix-auth", "Fix Auth")
      model.title("add-login", "Add Login")
      model.script(tagIs("fix-auth"), [(r) => writeCall(r, file, "fix-auth v1\n"), { text: "written" }])
      model.script(tagIs("add-login"), [
        (r) => writeCall(r, file, "add-login was here\n"),
        (r) => ({ text: `result: ${r.lastToolResult ?? ""}` }),
      ])

      const a = await opencode.createSession("Fix Auth")
      await opencode.prompt(a, "Create src/auth.rs.", { tag: "fix-auth" })
      await opencode.waitIdle(a, 30_000)
      expect(readOrNull(file)).toBe("fix-auth v1\n")

      const first = model.find(tagIs("fix-auth"))[0]
      expect(first?.allText ?? "").toContain('IRC (agent-comms): you are "fix-auth"')

      // The claim is on the canonical path (on macOS /var is a link to /private/var).
      const canonical = realpathSync(file)
      const line = await waitForClaim(operator, "fix-auth", canonical)
      expect(line).toContain(`fix-auth holds ${canonical} since`)

      const b = await opencode.createSession("Add Login")
      await opencode.prompt(b, "Change src/auth.rs.", { tag: "add-login" })
      await opencode.waitIdle(b, 30_000)

      const after = model.find((r) => tagIs("add-login")(r) && r.lastToolResult !== null)
      expect(after.length).toBeGreaterThan(0)
      const result = after[0]?.lastToolResult ?? ""
      expect(result).toContain("is claimed by fix-auth")
      expect(readOrNull(file)).toBe("fix-auth v1\n")
    })
  },
  90_000,
)

// ---------------------------------------------------------------------------
// 2. family_exemption
// ---------------------------------------------------------------------------

test(
  "family_exemption: a subagent can edit a file that its parent claims",
  async () => {
    await withEnv({}, async ({ model, opencode, operator }) => {
      const file = join(opencode.projectDir, "src", "auth.rs")

      model.title("fix-auth", "Fix Auth")
      // The embedded SDK cannot create a child session directly (no parentID on
      // sessions.create). The parent model calls the `subagent` tool instead.
      const turn = (tag: string, text: string) => (r: Recorded) => tagIs(tag)(r) && r.lastUser.includes(text)
      model.script(turn("fix-auth", "Create src/auth.rs."), [(r) => writeCall(r, file, "parent v1\n"), { text: "claimed" }])
      model.script(turn("fix-auth", "Let a subagent rewrite"), [
        {
          toolCall: {
            name: "subagent",
            arguments: {
              agent: "general",
              description: "Child writer",
              prompt: "[[e2e:fix-auth-child]] Overwrite src/auth.rs with the child content.",
            },
          },
        },
        { text: "done" },
      ])
      model.script(tagIs("fix-auth-child"), [
        (r) => writeCall(r, file, "child v2\n"),
        (r) => ({ text: `child result: ${r.lastToolResult ?? ""}` }),
      ])

      const parent = await opencode.createSession("Fix Auth")
      await opencode.prompt(parent, "Create src/auth.rs.", { tag: "fix-auth" })
      await opencode.waitIdle(parent, 30_000)
      expect(readOrNull(file)).toBe("parent v1\n")
      await waitForClaim(operator, "fix-auth", realpathSync(file))

      await opencode.prompt(parent, "Let a subagent rewrite src/auth.rs.", { tag: "fix-auth" })
      const childResult = await model.waitForRequest(
        (r) => tagIs("fix-auth-child")(r) && r.lastToolResult !== null,
        45_000,
      )
      await opencode.waitIdle(parent, 60_000)

      // The child request proves that a real child session ran the write.
      expect(childResult.allText).toContain("You are a subagent spawned by another session.")
      const result = childResult.lastToolResult ?? ""
      expect(result).not.toContain("claimed by")
      expect(result).not.toContain("IRC server unreachable")
      expect(result).toContain("successfully")
      expect(readOrNull(file)).toBe("child v2\n")
    })
  },
  90_000,
)

// ---------------------------------------------------------------------------
// 3. outage_fail_closed
// ---------------------------------------------------------------------------

test(
  "outage_fail_closed: during an outage cached claims deny, other edits ask, and the link recovers",
  async () => {
    await withEnv(
      {
        pluginOptions: { graceMs: 500, failMode: "ask", backoffMaxMs: 1000 },
        permissions: [
          { action: "edit", resource: "*", effect: "allow" },
          { action: "write", resource: "*", effect: "allow" },
        ],
      },
      async (env) => {
        const { model, opencode, server } = env
        const fileX = join(opencode.projectDir, "src", "x.rs")
        const fileY = join(opencode.projectDir, "src", "y.rs")

        model.title("fix-auth", "Fix Auth")
        model.title("add-login", "Add Login")
        model.script(tagIs("fix-auth"), [(r) => writeCall(r, fileX, "a owns x\n"), { text: "written" }])
        // One script per turn: a rejected permission can end turn 1 early.
        const turn = (text: string) => (r: Recorded) => tagIs("add-login")(r) && r.lastUser.includes(text)
        model.script(turn("Edit src/x.rs"), [
          (r) => writeCall(r, fileX, "b edits x\n"),
          (r) => writeCall(r, fileY, "b creates y (outage)\n"),
          (r) => ({ text: `after reject: ${r.lastToolResult ?? ""}` }),
        ])
        model.script(turn("Create src/y.rs again"), [
          (r) => writeCall(r, fileY, "b creates y\n"),
          (r) => ({ text: `after restart: ${r.lastToolResult ?? ""}` }),
        ])

        const a = await opencode.createSession("Fix Auth")
        await opencode.prompt(a, "Create src/x.rs.", { tag: "fix-auth" })
        await opencode.waitIdle(a, 30_000)
        expect(readOrNull(fileX)).toBe("a owns x\n")
        await waitForClaim(env.operator, "fix-auth", realpathSync(fileX))

        const b = await opencode.createSession("Add Login")
        await waitForNicks(env.operator, ["fix-auth", "add-login"])

        await server.stop()
        await sleep(1500)

        await opencode.prompt(b, "Edit src/x.rs, then create src/y.rs.", { tag: "add-login" })

        // The cached claim on X denies the edit.
        const denied = await model.waitForRequest(
          (r) => tagIs("add-login")(r) && r.lastToolResult !== null,
          20_000,
        )
        const deniedText = denied.lastToolResult ?? ""
        expect(deniedText).toContain("claimed by")
        expect(deniedText.includes("IRC server unreachable") || deniedText.includes("cached")).toBe(true)
        expect(readOrNull(fileX)).toBe("a owns x\n")

        // A new file needs approval, because claims cannot be checked.
        const ask = await opencode.waitForPermission(b, 20_000)
        expect(ask.message ?? "").toContain("IRC server unreachable")
        await opencode.replyPermission(b, ask.id, "reject")

        await opencode.waitIdle(b, 30_000)
        const rejected = model.find((r) => tagIs("add-login")(r) && r.answer?.startsWith("text: after reject") === true)[0]
        if (rejected !== undefined) {
          // The loop went on: the model saw the failed tool call.
          const rejectedText = rejected.lastToolResult ?? ""
          expect(rejectedText).not.toBe("")
          expect(rejectedText).not.toContain("successfully")
        } else {
          // The rejection ended the turn: the stored write call must be a failure.
          const stored = JSON.stringify(await opencode.messages(b))
          expect(stored).toMatch(/error|fail|reject|denied/i)
        }
        expect(existsSync(fileY)).toBe(false)

        // The server comes back. The plugin reconnects and introduces the sessions again.
        await server.restart()
        await env.operator.close()
        env.operator = await connectOperator(server)
        await waitForNicks(env.operator, ["fix-auth", "add-login"], 45_000)
        // The server restores the nicks as dormant by itself, so also wait until the
        // plugin link is back: AGENT STATUS must stop answering "dormant".
        const linkDeadline = Date.now() + 30_000
        for (;;) {
          const since = env.operator.lines.length
          env.operator.quote("AGENT STATUS add-login")
          const reply = await env.operator.waitFor(
            (l) => l.command === "NOTICE" && (l.params[1] ?? "").startsWith("[add-login]"),
            5_000,
            { since },
          )
          if (!(reply.params[1] ?? "").includes("dormant")) break
          if (Date.now() > linkDeadline) throw new Error("plugin link did not come back")
          await sleep(300)
        }

        await opencode.prompt(b, "Create src/y.rs again.", { tag: "add-login" })
        // `answer` is set after the request is recorded, so wait for the run to end first.
        await model.waitForRequest((r) => tagIs("add-login")(r) && r.lastUser.includes("Create src/y.rs again"), 30_000)
        await opencode.waitIdle(b, 30_000)
        const done = model.find(
          (r) => tagIs("add-login")(r) && r.answer?.startsWith("text: after restart") === true,
        )[0]
        if (done === undefined) throw new Error("no 'after restart' answer")
        const doneText = done.lastToolResult ?? ""
        expect(doneText).not.toContain("IRC server unreachable")
        expect(doneText).not.toContain("claimed by")
        expect(readOrNull(fileY)).toBe("b creates y\n")
        expect(await opencode.permissionRequests(b)).toHaveLength(0)
      },
    )
  },
  90_000,
)

// ---------------------------------------------------------------------------
// 4. wake_budget
// ---------------------------------------------------------------------------

test(
  "mention of three dormant subagents stays inside the wake budget",
  async () => {
    await withEnv({ pluginOptions: { wakeBudget: 2 } }, async ({ model, opencode, operator }) => {
      const tokens = ["wake-token-1", "wake-token-2", "wake-token-3"]
      const operatorText = "operator-ping-budget"

      model.title("sink", "Idle Sink")
      model.title("peer", "Peer Sender")
      model.script(tagIs("sink"), [{ text: "noted." }], { repeatLast: true })
      // The delays let the sink go idle between messages, so each message is a wake
      // (a message to a busy session steers and does not use the budget).
      model.script(tagIs("peer"), [
        { toolCall: { name: "irc_send", arguments: { target: "idle-sink", text: `please check ${tokens[0]}` } } },
        {
          toolCall: { name: "irc_send", arguments: { target: "idle-sink", text: `please check ${tokens[1]}` } },
          delayMs: 3000,
        },
        {
          toolCall: { name: "irc_send", arguments: { target: "idle-sink", text: `please check ${tokens[2]}` } },
          delayMs: 3000,
        },
        { text: "sent" },
      ])

      const sink = await opencode.createSession("Idle Sink")
      await opencode.prompt(sink, "Wait for work.", { tag: "sink" })
      await opencode.waitIdle(sink, 30_000)
      await waitForNicks(operator, ["idle-sink"])

      const peer = await opencode.createSession("Peer Sender")
      await opencode.prompt(peer, "Send three requests to idle-sink.", { tag: "peer" })
      await opencode.waitIdle(peer, 45_000)

      const sends = model.find((r) => tagIs("peer")(r) && (r.lastToolResult ?? "").includes("Sent to"))
      expect(sends.length).toBe(3)

      // Give late wakes time to show (the whole window stays under 20 s).
      await sleep(4000)
      const wakes = model.find((r) => tagIs("sink")(r) && r.lastUser.includes("[IRC peer request]"))
      expect(wakes.length).toBeGreaterThanOrEqual(1)
      expect(wakes.length).toBeLessThanOrEqual(2)
      const leaked = model.find((r) => tagIs("sink")(r) && r.allText.includes(tokens[2] as string))
      expect(leaked).toHaveLength(0)

      // An operator DM bypasses the budget and wakes the sink.
      await opencode.waitIdle(sink, 30_000).catch(() => undefined)
      operator.privmsg("idle-sink", operatorText)
      const woken = await model.waitForRequest(
        (r) => tagIs("sink")(r) && r.lastUser.includes("[IRC]") && r.lastUser.includes(operatorText),
        30_000,
      )
      const budgetUsedUp = /Wake budget used up/.test(woken.allText)
      const unread = /Unread: [^\n]*?\s([1-9]\d*)\b/.test(woken.allText)
      expect(budgetUsedUp || unread).toBe(true)
      expect(woken.allText).not.toContain(tokens[2] as string)
    })
  },
  90_000,
)
