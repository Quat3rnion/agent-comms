/**
 * Lifecycle e2e tests: AGENT INTERRUPT, title rename with alias, opencode restart
 * with dormant presence and DM replay, and subagent nicks.
 *
 * Run with `bun run test:e2e` (default `bun test` skips this directory).
 * The server binary must exist: `cargo build -p agent-comms`.
 */
import type { OpenCode } from "@opencode/sdk"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { sourceNick } from "../src/proto.ts"
import { IrcClient } from "./irc-client.ts"
import { createMockModel } from "./mock-model.ts"
import type { MockModel, Recorded } from "./mock-model.ts"
import { removeSharedRoot, startOpencode } from "./opencode.ts"
import type { OpencodeLog, StartOpencodeOptions, TestOpencode } from "./opencode.ts"
import { startServer } from "./server.ts"
import type { TestServer } from "./server.ts"

let server: TestServer
let model: MockModel
let operator: IrcClient
/** The opencode host of the running test. Used for diagnostics. */
let current: TestOpencode | undefined
/** Log lines of a re-opened host (restart test). Used for diagnostics. */
let extraLogs: OpencodeLog[] = []

beforeAll(async () => {
  model = createMockModel()
  server = await startServer()
  operator = await IrcClient.connect({
    host: server.host,
    port: server.port,
    password: server.operatorPassword,
  })
  operator.join("#lobby")
  await operator.waitFor((l) => l.command === "366" && l.params[1] === "#lobby", 10_000)
}, 60_000)

afterAll(async () => {
  await operator?.close()
  await model?.close()
  await server?.cleanup()
  removeSharedRoot()
}, 30_000)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function tagged(tag: string): (r: Recorded) => boolean {
  return (r) => r.allText.includes(`[[e2e:${tag}]]`)
}

const NICK_IN_SYSTEM = /IRC \(agent-comms\): you are "([^"]+)"/

/** The IRC nick that the plugin put into the system text of a model request. */
function nickOf(r: Recorded): string | null {
  return NICK_IN_SYSTEM.exec(r.allText)?.[1] ?? null
}

function diagnostics(): string {
  const logs = [...(current?.logs ?? []), ...extraLogs].slice(-40).map((l) => `[${l.level}] ${l.message}`)
  const requests = model.requests.map(
    (r) => `#${r.index} ${r.kind} tag=${r.tag} nick=${nickOf(r)} tools=${r.tools.length} answer=${r.answer}`,
  )
  return [
    "--- server log (tail) ---",
    server.log().split("\n").slice(-40).join("\n"),
    "--- opencode log (tail) ---",
    logs.join("\n"),
    "--- model requests ---",
    requests.join("\n"),
    "--- operator IRC lines (tail) ---",
    operator.raw.slice(-40).join("\n"),
  ].join("\n")
}

async function withDiagnostics(body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    console.error(diagnostics())
    throw error
  }
}

async function open(projectName: string): Promise<TestOpencode> {
  const oc = await startOpencode({
    serverPort: server.port,
    tokenPath: server.tokenPath,
    mockUrl: model.url,
    projectName,
  })
  current = oc
  return oc
}

/** Send `AGENT <verb> <nick>` and return the NOTICE texts for `nick` up to `end of AGENT <verb>`. */
async function agentVerb(verb: string, nick: string, timeoutMs = 15_000): Promise<string[]> {
  const since = operator.mark()
  operator.quote(`AGENT ${verb} ${nick}`)
  await operator.waitForMessage(`end of AGENT ${verb}`, timeoutMs, { since })
  const prefix = `[${nick}] `
  return operator.lines
    .slice(since)
    .filter((l) => l.command === "NOTICE" && (l.params[1] ?? "").startsWith(prefix))
    .map((l) => l.params[1] ?? "")
}

/** Handle of a host that `reopenOpencode` created. */
interface ReopenedHost {
  readonly sdk: OpenCode.Interface
  readonly logs: OpencodeLog[]
  close(): Promise<void>
}

/**
 * Create a new embedded opencode host on the database, config directory and project
 * directory of an earlier host (a restart of opencode). This copies the setup of
 * `startOpencode` in ./opencode.ts, but it reuses `prev.rootDir` and never deletes it.
 * The earlier host must be closed, and the isolated environment must be set (the
 * earlier `startOpencode` call did that).
 */
async function reopenOpencode(prev: TestOpencode, options: StartOpencodeOptions): Promise<ReopenedHost> {
  const configDir = join(prev.rootDir, "config")
  const pluginOptions = {
    host: "127.0.0.1",
    port: options.serverPort,
    tokenPath: options.tokenPath,
    graceMs: 200,
    askTimeoutMs: 5000,
    ...options.pluginOptions,
  }
  const config = {
    model: "e2e/mock",
    snapshots: false,
    update: "disable",
    providers: {
      e2e: {
        name: "E2E Mock",
        env: ["E2E_MOCK_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: options.mockUrl },
        models: {
          mock: {
            name: "Mock Model",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 8192 },
          },
        },
      },
    },
    permissions: [{ action: "*", resource: "*", effect: "allow" }, ...(options.permissions ?? [])],
    ...options.extraConfig,
  }
  const { OpenCode: OpenCodeRuntime } = await import("@opencode/sdk")
  const pluginModule = (await import(join(resolve(import.meta.dir, ".."), "src", "index.ts"))) as {
    default: { setup: (ctx: object) => unknown } & Record<string, unknown>
  }
  const base = pluginModule.default
  const plugin = {
    ...base,
    setup: (ctx: object) =>
      base.setup(
        new Proxy(ctx, {
          get: (target, prop, receiver) => (prop === "options" ? pluginOptions : Reflect.get(target, prop, receiver)),
        }),
      ),
  }
  const logs: OpencodeLog[] = []
  const sdk = await OpenCodeRuntime.create({
    plugins: [plugin as never],
    config: { content: JSON.stringify(config), directory: configDir, project: false },
    database: { path: join(prev.rootDir, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    log: {
      level: (process.env["E2E_LOG_LEVEL"] as "info" | "debug" | undefined) ?? "info",
      emit: (entry) => {
        const item: OpencodeLog = { level: entry.level, message: entry.message }
        if (entry.attributes !== undefined) item.attributes = entry.attributes
        logs.push(item)
        if (process.env["E2E_VERBOSE"] === "1") console.error(`[opencode ${entry.level}] ${entry.message}`)
      },
    },
  })
  let closed = false
  return {
    sdk,
    logs,
    async close() {
      if (closed) return
      closed = true
      await sdk.close()
    },
  }
}

/** Close a host but keep its temp directories (database, config, project). */
async function stopKeepingData(oc: TestOpencode): Promise<void> {
  const before = process.env["E2E_KEEP"]
  process.env["E2E_KEEP"] = "1"
  try {
    await oc.stop()
  } finally {
    if (before === undefined) delete process.env["E2E_KEEP"]
    else process.env["E2E_KEEP"] = before
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test(
  "agent_interrupt_stops_turn",
  async () => {
    let release: () => void = () => {}
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const oc = await open("interrupt-project")
    try {
      await withDiagnostics(async () => {
        const tag = "interrupt"
        model.script(tagged(tag), [
          async () => {
            await blocked
            return { text: "too late" }
          },
        ])

        const sessionID = await oc.createSession("Interrupt Me")
        await oc.prompt(sessionID, "Work for a long time.", { tag })

        const request = await model.waitForRequest((r) => r.kind === "primary" && tagged(tag)(r), 30_000)
        const nick = nickOf(request)
        expect(nick, `no IRC nick in the system text\n${diagnostics()}`).not.toBeNull()
        const target = nick as string

        // The busy state reaches the plugin through the event stream. Ask again until it shows.
        let status: string[] = []
        for (let i = 0; i < 20; i++) {
          status = await agentVerb("STATUS", target)
          if (status.some((t) => t.startsWith(`[${target}] busy`))) break
          await sleep(300)
        }
        expect(
          status.some((t) => t.startsWith(`[${target}] busy`)),
          `AGENT STATUS did not report busy: ${JSON.stringify(status)}\n${diagnostics()}`,
        ).toBe(true)

        const reply = await agentVerb("INTERRUPT", target)
        expect(reply, `unexpected AGENT INTERRUPT reply\n${diagnostics()}`).toContain(`[${target}] interrupted`)

        // The model step is still blocked. The session must be idle anyway.
        await oc.waitIdle(sessionID, 15_000)
      })
    } finally {
      release()
      await oc.stop()
      current = undefined
    }
  },
  90_000,
)

test(
  "title_rename_alias",
  async () => {
    const oc = await open("rename-project")
    try {
      await withDiagnostics(async () => {
        const tag = "rename-alias"
        model.title(tagged(tag), "Fix Auth")
        model.script(tagged(tag), [{ text: "first turn done" }], { repeatLast: true })

        const since = operator.mark()
        const sessionID = await oc.createSession()
        await oc.prompt(sessionID, "Fix the auth module.", { tag })

        const nickLine = await operator.waitFor((l) => l.command === "NICK" && l.params[0] === "fix-auth", 30_000, {
          since,
        })
        const oldNick = sourceNick(nickLine)
        expect(oldNick, `NICK line without a source\n${diagnostics()}`).not.toBeNull()
        expect(oldNick as string, `unexpected provisional nick\n${diagnostics()}`).toMatch(/^[a-z0-9-]+-[a-z0-9]{1,4}$/)
        expect(oldNick).not.toBe("fix-auth")

        await oc.waitIdle(sessionID, 30_000)

        const text = `alias ping ${Date.now()}`
        operator.privmsg(oldNick as string, text)

        const request = await model.waitForRequest(
          (r) => r.kind === "primary" && r.allText.includes("[IRC]") && r.allText.includes(text),
          30_000,
        )
        expect(request.tag).toBe(tag)
        await oc.waitIdle(sessionID, 30_000).catch(() => undefined)
      })
    } finally {
      await oc.stop()
      current = undefined
    }
  },
  90_000,
)

test(
  "restart_keeps_presence_and_dm_wakes",
  async () => {
    const options: StartOpencodeOptions = {
      serverPort: server.port,
      tokenPath: server.tokenPath,
      mockUrl: model.url,
      projectName: "restart-project",
    }
    const oc = await open("restart-project")
    let stopped = false
    let reopened: ReopenedHost | undefined
    try {
      await withDiagnostics(async () => {
        const tag = "restart"
        model.script(tagged(tag), [{ text: "hello before restart" }], { repeatLast: true })

        const sessionID = await oc.createSession("Restart Keeper")
        await oc.prompt(sessionID, "Say hello.", { tag })
        const first = await model.waitForRequest((r) => r.kind === "primary" && tagged(tag)(r), 30_000)
        await oc.waitIdle(sessionID, 30_000)

        const nick = nickOf(first)
        expect(nick, `no IRC nick in the system text\n${diagnostics()}`).not.toBeNull()
        const target = nick as string
        await operator.waitForMember("#lobby", target, 30_000)

        // Stop opencode. The account stays in #lobby and becomes AWAY dormant.
        const beforeStop = operator.mark()
        await stopKeepingData(oc)
        stopped = true
        await operator.waitFor(
          (l) => l.command === "AWAY" && sourceNick(l) === target && l.params[0] === "dormant",
          15_000,
          { since: beforeStop },
        )
        const names = await operator.names("#lobby")
        expect(names, `${target} left #lobby after the stop\n${diagnostics()}`).toContain(target)

        // A DM while opencode is down is stored by the server.
        const text = `wake after restart ${Date.now()}`
        operator.privmsg(target, text)
        await sleep(500)

        // Start opencode again on the same database, config and project directory.
        reopened = await reopenOpencode(oc, options)
        extraLogs = reopened.logs
        // Load the project location, so that the plugin starts and links.
        const location = { directory: oc.projectDir }
        await reopened.sdk.plugin.list({ location })

        const request = await model.waitForRequest(
          (r) => r.kind === "primary" && r.allText.includes("[IRC]") && r.allText.includes(text),
          30_000,
        )
        expect(request.tag, `the replayed DM woke the wrong session\n${diagnostics()}`).toBe(tag)
      })
    } finally {
      if (reopened !== undefined) await reopened.close().catch(() => undefined)
      if (!stopped) await oc.stop().catch(() => undefined)
      else if (process.env["E2E_KEEP"] !== "1") rmSync(oc.rootDir, { recursive: true, force: true })
      current = undefined
      extraLogs = []
    }
  },
  90_000,
)

test(
  "subagent_nick",
  async () => {
    const oc = await open("subagent-project")
    try {
      await withDiagnostics(async () => {
        const parentTag = "sub-parent"
        const childTag = "sub-child"
        let chosenAgent = "general"
        model.script(tagged(parentTag), [
          (r) => {
            const agent = pickSubagent(r)
            if (agent === null) return { text: "no subagent tool" }
            chosenAgent = agent
            return {
              toolCall: {
                name: "subagent",
                arguments: {
                  agent,
                  description: "Child task",
                  prompt: `[[e2e:${childTag}]] Do the child task.`,
                },
              },
            }
          },
          { text: "parent done" },
        ])
        model.script(tagged(childTag), [{ text: "child done" }], { repeatLast: true })

        const since = operator.mark()
        const parentID = await oc.createSession("Sub Parent")
        await oc.prompt(parentID, "Start a subagent.", { tag: parentTag })

        const first = await model.waitForRequest((r) => r.kind === "primary" && tagged(parentTag)(r), 30_000)
        expect(first.tools, `the subagent tool is not offered\n${diagnostics()}`).toContain("subagent")
        const parentNick = nickOf(first)
        expect(parentNick, `no IRC nick in the parent system text\n${diagnostics()}`).not.toBeNull()
        const pnick = parentNick as string

        await model.waitForRequest((r) => r.kind === "primary" && tagged(childTag)(r), 30_000)

        const childRe = new RegExp(`^${escapeRe(pnick)}\\|${escapeRe(chosenAgent)}\\d+$`, "i")
        const childNick = await operator.waitForMember("#lobby", (n) => childRe.test(n), 30_000, { since })
        expect(childNick).toMatch(childRe)

        // The family channel #<parent-nick> holds the child and the parent.
        const family = `#${pnick}`
        const beforeJoin = operator.mark()
        operator.join(family)
        await operator.waitFor((l) => l.command === "366" && l.params[1]?.toLowerCase() === family.toLowerCase(), 10_000, {
          since: beforeJoin,
        })
        const members = operator.lines
          .slice(beforeJoin)
          .filter((l) => l.command === "353" && l.params[2]?.toLowerCase() === family.toLowerCase())
          .flatMap((l) => (l.params[3] ?? "").split(" "))
          .map((n) => n.replace(/^[~&@%+]+/, ""))
          .filter((n) => n !== "")
        expect(members, `family channel ${family} members\n${diagnostics()}`).toContain(childNick)
        expect(members, `family channel ${family} members\n${diagnostics()}`).toContain(pnick)
        operator.part(family)

        await oc.waitIdle(parentID, 30_000).catch(() => undefined)
      })
    } finally {
      await oc.stop()
      current = undefined
    }
  },
  90_000,
)

/** Read the `subagent` tool schema of a request and pick an agent for it. */
function pickSubagent(r: Recorded): string | null {
  const body = r.body as { tools?: unknown }
  if (!Array.isArray(body.tools)) return null
  for (const t of body.tools) {
    const fn = (t as { function?: { name?: unknown; parameters?: unknown } }).function
    if (fn?.name !== "subagent") continue
    const params = fn.parameters as { properties?: Record<string, { enum?: unknown }> } | undefined
    const choices = params?.properties?.["agent"]?.enum
    if (Array.isArray(choices) && choices.length > 0) {
      const names = choices.filter((c): c is string => typeof c === "string")
      return names.includes("general") ? "general" : (names[0] ?? "general")
    }
    return "general"
  }
  return null
}
