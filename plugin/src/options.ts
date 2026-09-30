import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import type { FailMode, Options } from "./types.ts"

function defaultTokenPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]
  const base = xdg !== undefined && xdg !== "" ? xdg : `${homedir()}/.config`
  return `${base}/agent-comms/link-token`
}

export const DEFAULT_OPTIONS: Options = {
  enabled: true,
  excludeAgents: [],
  failMode: "ask",
  host: "127.0.0.1",
  port: 6667,
  tls: false,
  tlsCaPath: null,
  tokenPath: defaultTokenPath(),
  serverName: "irc.agent-comms.local",
  requireServerProof: true,
  hopLimit: 4,
  wakeBudget: 10,
  wakeWindowMs: 3_600_000,
  askTimeoutMs: 300_000,
  maxMessageBytes: 16384,
  previewChars: 300,
  joinContextLines: 10,
  nickSlugLength: 24,
  graceMs: 10_000,
  backoffMaxMs: 30_000,
  claimEditTools: ["edit", "write", "patch", "apply_patch", "multiedit"],
  editActions: ["edit", "write", "patch"],
}

const FAIL_MODES: readonly FailMode[] = ["ask", "deny", "open"]

type IntKey =
  | "port"
  | "hopLimit"
  | "wakeBudget"
  | "wakeWindowMs"
  | "askTimeoutMs"
  | "maxMessageBytes"
  | "previewChars"
  | "joinContextLines"
  | "nickSlugLength"
  | "graceMs"
  | "backoffMaxMs"

const INT_RANGES: Record<IntKey, [number, number]> = {
  port: [1, 65535],
  hopLimit: [0, 100],
  wakeBudget: [0, 100_000],
  wakeWindowMs: [1, 86_400_000],
  askTimeoutMs: [1, 86_400_000],
  maxMessageBytes: [1, 16384],
  previewChars: [1, 16384],
  joinContextLines: [0, 1000],
  nickSlugLength: [1, 64],
  graceMs: [0, 3_600_000],
  backoffMaxMs: [1, 3_600_000],
}

const INT_KEYS = Object.keys(INT_RANGES) as IntKey[]

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
}

export function parseOptions(raw: unknown): { options: Options; warnings: string[] } {
  const warnings: string[] = []
  const options: Options = {
    ...DEFAULT_OPTIONS,
    excludeAgents: [...DEFAULT_OPTIONS.excludeAgents],
    claimEditTools: [...DEFAULT_OPTIONS.claimEditTools],
    editActions: [...DEFAULT_OPTIONS.editActions],
  }

  if (raw === undefined || raw === null) return { options, warnings }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("options must be an object; using defaults")
    return { options, warnings }
  }
  const src = raw as Record<string, unknown>

  const known = new Set<string>([
    "enabled",
    "excludeAgents",
    "failMode",
    "host",
    "tls",
    "tlsCaPath",
    "tokenPath",
    "serverName",
    "requireServerProof",
    "claimEditTools",
    "editActions",
    ...INT_KEYS,
  ])
  for (const key of Object.keys(src)) {
    if (!known.has(key)) warnings.push(`unknown option "${key}" ignored`)
  }

  const bad = (key: string, expected: string): void => {
    warnings.push(`option "${key}" must be ${expected}; using default`)
  }

  for (const key of ["enabled", "tls", "requireServerProof"] as const) {
    const v = src[key]
    if (v === undefined) continue
    if (typeof v === "boolean") options[key] = v
    else bad(key, "a boolean")
  }

  for (const key of ["excludeAgents", "claimEditTools", "editActions"] as const) {
    const v = src[key]
    if (v === undefined) continue
    if (isStringArray(v)) options[key] = [...v]
    else bad(key, "an array of strings")
  }

  if (src["failMode"] !== undefined) {
    const v = src["failMode"]
    if (typeof v === "string" && (FAIL_MODES as readonly string[]).includes(v)) {
      options.failMode = v as FailMode
    } else bad("failMode", 'one of "ask", "deny", "open"')
  }

  for (const key of ["host", "tokenPath", "serverName"] as const) {
    const v = src[key]
    if (v === undefined) continue
    if (typeof v === "string" && v.trim() !== "") options[key] = v
    else bad(key, "a non-empty string")
  }

  if (src["tlsCaPath"] !== undefined) {
    const v = src["tlsCaPath"]
    if (v === null) options.tlsCaPath = null
    else if (typeof v === "string" && v.trim() !== "") options.tlsCaPath = v
    else bad("tlsCaPath", "a non-empty string or null")
  }

  for (const key of INT_KEYS) {
    const v = src[key]
    if (v === undefined) continue
    const [lo, hi] = INT_RANGES[key]
    if (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi) {
      options[key] = v
    } else bad(key, `an integer from ${lo} to ${hi}`)
  }

  return { options, warnings }
}

export async function readToken(path: string): Promise<string> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    const why = code === "ENOENT" ? "file not found" : (e as Error).message
    throw new Error(`agent-comms link token unreadable at ${path} (${why}). Run \`agent-comms install\` to create it.`)
  }
  const token = text.trim()
  if (token === "") {
    throw new Error(`agent-comms link token file ${path} is empty. Run \`agent-comms install\` to create it.`)
  }
  return token
}
