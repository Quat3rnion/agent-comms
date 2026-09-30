/**
 * Embed opencode in the test process with the V2 SDK. No HTTP listener opens.
 *
 * SDK exports used, and why:
 * - `OpenCode.create(options)` from `@opencode/sdk`: builds the opencode server in
 *   memory and routes API calls through its HTTP router without a socket.
 *   Options used (type `ServerOptions` in `@opencode/server/options`):
 *   - `config.content`  inline opencode config (JSON text): plugin, provider, model, permissions.
 *   - `config.directory` the global config dir. It points to an empty temp dir.
 *   - `config.project: false` stops the search for opencode.json files above the project dir.
 *   - `database.path`   SQLite file inside the temp dir.
 *   - `models.fetch: false` no request to models.dev.
 *   - `fs.filewatcher: false`, `fs.fff: false` fewer background services.
 *   - `log.emit`        collect log lines. They are shown when a test fails.
 * - `opencode.sessions.create/prompt/active/context`, `opencode.message.list`,
 *   `opencode.permission.request.list/list/reply`, `opencode.plugin.list`,
 *   `opencode.events.subscribe` (the generated Promise client; see `@opencode/client`).
 * - `opencode.close()`: release the host and its plugins (the agent-comms plugin closes its
 *   IRC link there).
 *
 * `@opencode/simulation` is NOT used. It replaces the model with a driver-controlled
 * scripted route, but it needs the simulation control protocol of the opencode frontend.
 * An OpenAI-compatible stub (./mock-model.ts) is simpler and tests the real
 * `openai-compatible` provider path.
 *
 * Isolation: opencode reads XDG_* and HOME once, when `@opencode/util/global` loads. This
 * module sets HOME, OPENCODE_TEST_HOME and XDG_* to a temp directory BEFORE it imports the
 * SDK (dynamic import). The SDK therefore never sees ~/.config/opencode. All opencode
 * hosts in one test process share this one temp root. Each host has its own database,
 * config directory and project directory.
 */
import type { OpenCode, OpenCodeEvent } from "@opencode/sdk"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

export type PermissionEffect = "allow" | "deny" | "ask"

export interface PermissionRule {
  action: string
  resource: string
  effect: PermissionEffect
}

export interface StartOpencodeOptions {
  /** Port of the agent-comms server (plugin option `port`). */
  serverPort: number
  /** Link token file (plugin option `tokenPath`). */
  tokenPath: string
  /** Base URL of the mock model, for example `http://127.0.0.1:41000/v1`. */
  mockUrl: string
  /** Plugin options. They override the test defaults. */
  pluginOptions?: Record<string, unknown>
  /**
   * Extra permission rules. They come AFTER the allow-all rule, so they win
   * (the last matching rule wins). Use `{ action: "edit", resource: "*", effect: "ask" }` to test asks.
   */
  permissions?: PermissionRule[]
  /** Extra top-level config keys. They are merged over the generated config. */
  extraConfig?: Record<string, unknown>
  /** Name of the project directory. It becomes the base of the IRC nick. Default: `e2e-project`. */
  projectName?: string
}

export interface OpencodeLog {
  level: string
  message: string
  attributes?: Readonly<Record<string, unknown>>
}

export interface PendingPermission {
  id: string
  sessionID: string
  action: string
  resources: string[]
  message?: string
}

export interface TestOpencode {
  /** The full embedded SDK host. Use it for anything that the helpers do not cover. */
  readonly sdk: OpenCode.Interface
  readonly projectDir: string
  readonly rootDir: string
  /** Every event received, in order. */
  readonly events: OpenCodeEvent[]
  /** Log lines that opencode wrote (level info and above). */
  readonly logs: OpencodeLog[]
  /** Create a session in the project directory. Returns the session ID. */
  createSession(title?: string, agent?: string): Promise<string>
  /**
   * Send a user prompt. Returns when opencode accepted it. It does not wait for the reply.
   * Give `tag` to prefix the text with `[[e2e:<tag>]]` so the mock model can match the session.
   */
  prompt(sessionID: string, text: string, options?: { tag?: string }): Promise<void>
  /** Wait until the session runs no work. Rejects on timeout. */
  waitIdle(sessionID: string, timeoutMs?: number): Promise<void>
  /** Messages of a session, oldest first. */
  messages(sessionID: string): Promise<unknown[]>
  /** Wait for an event. Events that already arrived count. */
  waitForEvent(predicate: (event: OpenCodeEvent) => boolean, timeoutMs?: number): Promise<OpenCodeEvent>
  /** Pending permission requests, for one session or for the whole project. */
  permissionRequests(sessionID?: string): Promise<PendingPermission[]>
  /** Wait for at least one pending permission request. */
  waitForPermission(sessionID?: string, timeoutMs?: number): Promise<PendingPermission>
  replyPermission(
    sessionID: string,
    requestID: string,
    decision: "once" | "always" | "reject",
    message?: string,
  ): Promise<void>
  /** Names of the plugins that opencode loaded for the project. */
  loadedPlugins(): Promise<string[]>
  /** Close the host. Delete the temp dirs unless `E2E_KEEP=1`. */
  stop(): Promise<void>
}

const PLUGIN_DIR = resolve(import.meta.dir, "..")
const MOCK_KEY_ENV = "E2E_MOCK_KEY"
const MODEL_ID = "mock"
const PROVIDER_ID = "e2e"

let isolatedRoot: string | null = null

/** Point HOME and XDG_* to one temp root. It must run before the SDK loads. */
function isolate(): string {
  if (isolatedRoot !== null) return isolatedRoot
  const root = mkdtempSync(join(tmpdir(), "opencode-e2e-"))
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  process.env["HOME"] = home
  process.env["OPENCODE_TEST_HOME"] = home
  process.env["XDG_CONFIG_HOME"] = join(home, ".config")
  process.env["XDG_DATA_HOME"] = join(home, ".local", "share")
  process.env["XDG_STATE_HOME"] = join(home, ".local", "state")
  process.env["XDG_CACHE_HOME"] = join(home, ".cache")
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OPENCODE_") && key !== "OPENCODE_TEST_HOME") delete process.env[key]
  }
  process.env[MOCK_KEY_ENV] = "e2e-not-a-real-key"
  isolatedRoot = root
  return root
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function eventSessionID(event: OpenCodeEvent): string | undefined {
  const data = (event as { data?: unknown }).data
  if (typeof data === "object" && data !== null) {
    const id = (data as { sessionID?: unknown }).sessionID
    if (typeof id === "string") return id
  }
  return undefined
}

export async function startOpencode(options: StartOpencodeOptions): Promise<TestOpencode> {
  const sharedRoot = isolate()
  const rootDir = mkdtempSync(join(sharedRoot, "host-"))
  const projectDir = join(rootDir, "projects", options.projectName ?? "e2e-project")
  const configDir = join(rootDir, "config")
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  // A git repository gives a stable project identity. Failure is not fatal.
  spawnSync("git", ["init", "-q"], { cwd: projectDir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } })
  writeFileSync(join(projectDir, "README.md"), "# e2e project\n")

  const pluginOptions = {
    host: "127.0.0.1",
    port: options.serverPort,
    tokenPath: options.tokenPath,
    graceMs: 200,
    askTimeoutMs: 5000,
    ...options.pluginOptions,
  }
  const config = {
    model: `${PROVIDER_ID}/${MODEL_ID}`,
    snapshots: false,
    update: "disable",
    plugins: [{ package: PLUGIN_DIR, options: pluginOptions }],
    providers: {
      [PROVIDER_ID]: {
        name: "E2E Mock",
        env: [MOCK_KEY_ENV],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: options.mockUrl },
        models: {
          [MODEL_ID]: {
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

  // Dynamic import: the SDK must load after `isolate()` set the environment.
  const { OpenCode: OpenCodeRuntime } = await import("@opencode/sdk")
  const logs: OpencodeLog[] = []
  const sdk = await OpenCodeRuntime.create({
    config: { content: JSON.stringify(config), directory: configDir, project: false },
    database: { path: join(rootDir, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    log: {
      level: "info",
      emit: (entry) => {
        const item: OpencodeLog = { level: entry.level, message: entry.message }
        if (entry.attributes !== undefined) item.attributes = entry.attributes
        logs.push(item)
        if (process.env["E2E_VERBOSE"] === "1") console.error(`[opencode ${entry.level}] ${entry.message}`)
      },
    },
  })

  // Record the event stream in the background.
  const events: OpenCodeEvent[] = []
  const eventWaiters: Array<{ predicate: (e: OpenCodeEvent) => boolean; resolve: (e: OpenCodeEvent) => void }> = []
  const abort = new AbortController()
  const pump = (async () => {
    try {
      for await (const event of sdk.events.subscribe({ signal: abort.signal })) {
        events.push(event)
        for (let i = eventWaiters.length - 1; i >= 0; i--) {
          const w = eventWaiters[i]
          if (w !== undefined && w.predicate(event)) {
            eventWaiters.splice(i, 1)
            w.resolve(event)
          }
        }
      }
    } catch {
      // aborted on stop
    }
  })()
  await sleep(50)

  const location = { directory: projectDir }
  /** Index into `events` at the last `prompt()` call, per session. */
  const promptMark = new Map<string, number>()

  const permissionList = async (sessionID?: string): Promise<PendingPermission[]> => {
    const list =
      sessionID === undefined
        ? (await sdk.permission.request.list({ location })).data
        : await sdk.permission.list({ sessionID })
    return list.map((p) => {
      const item: PendingPermission = { id: p.id, sessionID: p.sessionID, action: p.action, resources: [...p.resources] }
      if (p.message !== undefined) item.message = p.message
      return item
    })
  }

  const waitForEvent = (predicate: (e: OpenCodeEvent) => boolean, timeoutMs = 15_000): Promise<OpenCodeEvent> => {
    const existing = events.find(predicate)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise<OpenCodeEvent>((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: (e: OpenCodeEvent) => (clearTimeout(timer), resolvePromise(e)),
      }
      const timer = setTimeout(() => {
        const at = eventWaiters.indexOf(waiter)
        if (at !== -1) eventWaiters.splice(at, 1)
        reject(new Error(`opencode: no matching event within ${timeoutMs} ms (${events.length} events seen)`))
      }, timeoutMs)
      eventWaiters.push(waiter)
    })
  }

  return {
    sdk,
    projectDir,
    rootDir,
    events,
    logs,

    async createSession(title, agent) {
      const input: { location: { directory: string }; title?: string; agent?: string } = { location }
      if (title !== undefined) input.title = title
      if (agent !== undefined) input.agent = agent
      const session = await sdk.sessions.create(input)
      return session.id
    },

    async prompt(sessionID, text, opts) {
      promptMark.set(sessionID, events.length)
      const body = opts?.tag === undefined ? text : `[[e2e:${opts.tag}]] ${text}`
      await sdk.sessions.prompt({ sessionID, text: body })
    },

    async waitIdle(sessionID, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs
      const since = promptMark.get(sessionID) ?? 0
      // Wait for the run to start, so that an early poll does not see "idle" by mistake.
      const started = (e: OpenCodeEvent): boolean =>
        e.type === "session.execution.started" && eventSessionID(e) === sessionID
      const sawStart = (): boolean => events.slice(since).some(started)
      while (Date.now() < deadline) {
        if (sawStart()) {
          const active = await sdk.sessions.active()
          if (!(sessionID in active)) {
            await sleep(150)
            const again = await sdk.sessions.active()
            if (!(sessionID in again)) return
          }
        }
        await sleep(100)
      }
      throw new Error(`opencode: session ${sessionID} not idle within ${timeoutMs} ms (started: ${sawStart()})`)
    },

    async messages(sessionID) {
      const page = await sdk.message.list({ sessionID, order: "asc", limit: 500 })
      return page.data
    },

    waitForEvent,

    permissionRequests: permissionList,

    async waitForPermission(sessionID, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const [first] = await permissionList(sessionID)
        if (first !== undefined) return first
        await sleep(100)
      }
      throw new Error(`opencode: no permission request within ${timeoutMs} ms`)
    },

    async replyPermission(sessionID, requestID, decision, message) {
      await sdk.permission.reply(
        message === undefined ? { sessionID, requestID, decision } : { sessionID, requestID, decision, message },
      )
    },

    async loadedPlugins() {
      const list = await sdk.plugin.list({ location })
      return list.data.map((p) => JSON.stringify(p))
    },

    async stop() {
      abort.abort()
      await pump
      await sdk.close()
      if (process.env["E2E_KEEP"] !== "1") rmSync(rootDir, { recursive: true, force: true })
    },
  }
}

/** Delete the shared temp root. Call it once in `afterAll` of the last test file. */
export function removeSharedRoot(): void {
  if (isolatedRoot !== null && process.env["E2E_KEEP"] !== "1") {
    rmSync(isolatedRoot, { recursive: true, force: true })
    isolatedRoot = null
  }
}
