/**
 * Start a real `agent-comms serve` process on an ephemeral port with a temp config dir.
 *
 * The binary is `AGENT_COMMS_BIN`, or `<repo>/target/debug/agent-comms`.
 * Build it first with `cargo build -p agent-comms`.
 *
 * Nothing here reads or writes `~/.config/agent-comms`. The child process gets
 * its own HOME and XDG directories inside the temp dir.
 */
import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, connect } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

export interface StartServerOptions {
  /** Operator password. Default: `e2e-operator-password`. */
  operatorPassword?: string
  /** Extra `[limits]` values. They override the test defaults. */
  limits?: Record<string, number>
  /** Extra lines for the top level of config.toml (raw TOML). */
  extraConfig?: string
  /** Use this directory instead of a new temp directory. It must exist. */
  configDir?: string
  /** Milliseconds to wait until the port accepts connections. Default: 15000. */
  readyTimeoutMs?: number
  /** Value for RUST_LOG. Default: `E2E_RUST_LOG` or `info`. */
  rustLog?: string
}

export interface TestServer {
  readonly host: string
  readonly port: number
  readonly configDir: string
  readonly dataDir: string
  readonly secretsPath: string
  /** Path of the link token file that the plugin option `tokenPath` must use. */
  readonly tokenPath: string
  readonly logPath: string
  readonly operatorPassword: string
  /** Read the link token text. */
  readLinkToken(): string
  /** Contents of the server log so far. */
  log(): string
  /** True while the process runs. */
  running(): boolean
  /** Stop the process (SIGTERM, then SIGKILL after 5 s). Data stays. */
  stop(): Promise<void>
  /** Stop, then start the same server again on the same port with the same data. */
  restart(): Promise<void>
  /** Stop and delete the temp directory. */
  cleanup(): Promise<void>
}

export function serverBinary(): string {
  const fromEnv = process.env["AGENT_COMMS_BIN"]
  if (fromEnv !== undefined && fromEnv !== "") return resolve(fromEnv)
  return resolve(import.meta.dir, "../../target/debug/agent-comms")
}

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      srv.close(() => (port > 0 ? resolvePort(port) : reject(new Error("no free port"))))
    })
  })
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolveOk) => {
    const socket = connect({ host, port })
    socket.once("connect", () => {
      socket.destroy()
      resolveOk(true)
    })
    socket.once("error", () => {
      socket.destroy()
      resolveOk(false)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isolatedEnv(configDir: string, rustLog: string): NodeJS.ProcessEnv {
  const home = join(configDir, "home")
  mkdirSync(home, { recursive: true })
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    AGENT_COMMS_CONFIG_DIR: configDir,
    RUST_LOG: rustLog,
  }
}

function toml(value: string): string {
  return JSON.stringify(value)
}

export async function startServer(options: StartServerOptions = {}): Promise<TestServer> {
  const bin = serverBinary()
  if (!existsSync(bin)) {
    throw new Error(`agent-comms binary not found at ${bin}. Run \`cargo build -p agent-comms\` or set AGENT_COMMS_BIN.`)
  }
  const host = "127.0.0.1"
  const operatorPassword = options.operatorPassword ?? "e2e-operator-password"
  const ownsDir = options.configDir === undefined
  const configDir = options.configDir ?? mkdtempSync(join(tmpdir(), "agent-comms-e2e-"))
  const dataDir = join(configDir, "data")
  const secretsPath = join(configDir, "secrets.toml")
  const tokenPath = join(configDir, "link-token")
  const logPath = join(configDir, "server.log")
  const port = await freePort()
  const rustLog = options.rustLog ?? process.env["E2E_RUST_LOG"] ?? "info"
  const env = isolatedEnv(configDir, rustLog)

  // Write config.toml first. `install` keeps an existing config, so it never
  // creates the default data directory in the real home directory.
  const limits: Record<string, number> = {
    claim_idle_secs: 60,
    agent_request_timeout_secs: 5,
    link_ping_secs: 30,
    link_timeout_secs: 60,
    flood_burst: 200,
    flood_rate_per_sec: 200,
    ...options.limits,
  }
  const config = [
    `bind = ${toml(`${host}:${port}`)}`,
    `data_dir = ${toml(dataDir)}`,
    `secrets_path = ${toml(secretsPath)}`,
    "require_sasl = true",
    options.extraConfig ?? "",
    "",
    "[limits]",
    ...Object.entries(limits).map(([k, v]) => `${k} = ${v}`),
    "",
  ].join("\n")
  writeFileSync(join(configDir, "config.toml"), config, { mode: 0o600 })

  // `install` writes secrets.toml (mode 0600, argon2 hashes) and the link-token file.
  const install = spawnSync(
    bin,
    ["--config-dir", configDir, "install", "--no-launchd", "--password-stdin"],
    { env, encoding: "utf8", input: `${operatorPassword}\n` },
  )
  if (install.status !== 0) {
    throw new Error(`agent-comms install failed (${install.status}): ${install.stderr}${install.stdout}`)
  }

  let child: ChildProcess | null = null
  let exited = false

  const start = async (): Promise<void> => {
    const fd = openSync(logPath, "a")
    exited = false
    const proc = spawn(bin, ["--config-dir", configDir, "serve", "--log-format", "text"], {
      env,
      stdio: ["ignore", fd, fd],
    })
    closeSync(fd)
    child = proc
    proc.once("exit", () => {
      if (child === proc) exited = true
    })
    const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000)
    while (Date.now() < deadline) {
      if (exited) throw new Error(`agent-comms exited during startup. Log:\n${readLog()}`)
      if (await canConnect(host, port)) return
      await sleep(50)
    }
    await stopProcess()
    throw new Error(`agent-comms did not listen on ${host}:${port}. Log:\n${readLog()}`)
  }

  const readLog = (): string => {
    try {
      return readFileSync(logPath, "utf8")
    } catch {
      return ""
    }
  }

  const stopProcess = async (): Promise<void> => {
    const proc = child
    if (proc === null || proc.exitCode !== null || proc.signalCode !== null) {
      child = null
      return
    }
    const done = new Promise<void>((r) => proc.once("exit", () => r()))
    proc.kill("SIGTERM")
    const timedOut = await Promise.race([done.then(() => false), sleep(5000).then(() => true)])
    if (timedOut) {
      proc.kill("SIGKILL")
      await done
    }
    child = null
  }

  await start()

  return {
    host,
    port,
    configDir,
    dataDir,
    secretsPath,
    tokenPath,
    logPath,
    operatorPassword,
    readLinkToken: () => readFileSync(tokenPath, "utf8").trim(),
    log: readLog,
    running: () => child !== null && !exited && child.exitCode === null,
    stop: stopProcess,
    async restart() {
      await stopProcess()
      await start()
    },
    async cleanup() {
      await stopProcess()
      if (ownsDir) rmSync(configDir, { recursive: true, force: true })
    },
  }
}
