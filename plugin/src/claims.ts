/**
 * Pure claim logic: cached server claims, path canonicalisation, family checks,
 * the edit decision, the claim tracker, and path extraction from tool inputs.
 * No sockets and no context. Time and filesystem access are injected.
 */
import { basename, dirname, join, resolve } from "node:path"
import type { IrcMessage } from "./proto.ts"
import { msg } from "./proto.ts"
import type { Claim, FailMode, LinkState } from "./types.ts"

// ---------------------------------------------------------------------------
// ClaimCache
// ---------------------------------------------------------------------------

function sameClaim(a: Claim, b: Claim): boolean {
  return (
    a.path === b.path &&
    a.holderAccount === b.holderAccount &&
    a.holderNick === b.holderNick &&
    a.since === b.since &&
    a.deadline === b.deadline
  )
}

export class ClaimCache {
  private claims = new Map<string, Claim>()
  private stale = new Set<string>()

  /** Handle CLAIMSET and CLAIMDEL. Returns true when the cache changed. Ignores other lines. */
  apply(line: IrcMessage): boolean {
    if (line.command === "CLAIMSET") {
      const [holderAccount, holderNick, sinceRaw, deadlineRaw, path] = line.params
      if (
        holderAccount === undefined ||
        holderNick === undefined ||
        sinceRaw === undefined ||
        deadlineRaw === undefined ||
        path === undefined ||
        path === ""
      ) {
        return false
      }
      const since = Number(sinceRaw)
      const deadline = Number(deadlineRaw)
      if (!Number.isFinite(since) || !Number.isFinite(deadline)) return false
      const claim: Claim = { path, holderAccount, holderNick, since, deadline }
      this.stale.delete(path)
      const old = this.claims.get(path)
      if (old && sameClaim(old, claim)) return false
      this.claims.set(path, claim)
      return true
    }
    if (line.command === "CLAIMDEL") {
      const path = line.params[0]
      if (path === undefined) return false
      this.stale.delete(path)
      return this.claims.delete(path)
    }
    return false
  }

  get(path: string): Claim | undefined {
    return this.claims.get(path)
  }

  all(): Claim[] {
    return [...this.claims.values()]
  }

  ofAccount(account: string): Claim[] {
    return this.all().filter((c) => c.holderAccount === account)
  }

  clear(): void {
    this.claims.clear()
    this.stale.clear()
  }

  replaceAll(claims: Claim[]): void {
    this.claims.clear()
    this.stale.clear()
    for (const c of claims) this.claims.set(c.path, { ...c })
  }

  /** Drop claims whose deadline is at or before nowSec. Returns the number dropped. */
  pruneExpired(nowSec: number): number {
    let n = 0
    for (const [path, c] of this.claims) {
      if (c.deadline <= nowSec) {
        this.claims.delete(path)
        this.stale.delete(path)
        n += 1
      }
    }
    return n
  }

  /** A new server burst starts: mark every entry stale. */
  serverBurstStarted(): void {
    this.stale = new Set(this.claims.keys())
  }

  /** The server burst ended: drop entries that the burst did not set again. */
  serverBurstEnded(): void {
    for (const path of this.stale) this.claims.delete(path)
    this.stale.clear()
  }
}

// ---------------------------------------------------------------------------
// canonicalPath
// ---------------------------------------------------------------------------

/**
 * Resolve `p` against `cwd`, normalise it, then apply `realpath` to the longest
 * existing ancestor and append the remaining segments. Case is kept as realpath returns it.
 */
export function canonicalPath(
  p: string,
  cwd: string,
  realpath: (p: string) => string | null,
): string {
  const resolved = resolve(cwd, p)
  const rest: string[] = []
  let cur = resolved
  for (;;) {
    let real: string | null = null
    try {
      real = realpath(cur)
    } catch {
      real = null
    }
    if (real !== null) return rest.length === 0 ? real : join(real, ...rest)
    const parent = dirname(cur)
    if (parent === cur) return resolved
    rest.unshift(basename(cur))
    cur = parent
  }
}

// ---------------------------------------------------------------------------
// Family
// ---------------------------------------------------------------------------

export type Family = { isFamily(a: string, b: string): boolean }

export class FamilyIndex implements Family {
  private parents = new Map<string, string | null>()

  constructor(initial?: Map<string, string | null>) {
    if (initial) for (const [a, p] of initial) this.parents.set(a, p)
  }

  set(account: string, parent: string | null): void {
    this.parents.set(account, parent)
  }

  delete(account: string): void {
    this.parents.delete(account)
  }

  private root(account: string): string {
    const path: string[] = []
    const seen = new Set<string>()
    let cur: string = account
    for (;;) {
      if (seen.has(cur)) {
        // Cycle: pick a stable root so every member of the cycle agrees.
        const cycle = path.slice(path.indexOf(cur))
        return cycle.reduce((min, x) => (x < min ? x : min), cur)
      }
      seen.add(cur)
      path.push(cur)
      const parent = this.parents.get(cur)
      if (parent === undefined || parent === null) return cur
      cur = parent
    }
  }

  isFamily(a: string, b: string): boolean {
    if (a === b) return true
    if (!this.parents.has(a) || !this.parents.has(b)) return false
    return this.root(a) === this.root(b)
  }
}

// ---------------------------------------------------------------------------
// decideEdit
// ---------------------------------------------------------------------------

export type EditDecision =
  | { effect: "allow" }
  | { effect: "deny"; message: string }
  | { effect: "ask"; message: string }

export interface DecideEditInput {
  /** null = session opted out or unknown: it is still subject to claims. */
  account: string | null
  /** For opted-out sessions: the nearest registered ancestor account, if any. */
  sessionFamilyAccount: string | null
  /** Canonical paths. */
  paths: string[]
  /**
   * Globs that the edit targets. Every cached claim that matches one is checked.
   * When the link is not established they cannot be checked, so failMode applies.
   * An edit with no paths and no globs is also unchecked: failMode applies offline.
   */
  unresolved?: GlobMatcher[]
  cache: ClaimCache
  family: Family
  linkState: LinkState | "never"
  failMode: FailMode
  nowSec: number
  nickOf?: (account: string) => string
}

function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  return `${Math.floor(s / 3600)} h`
}

export function decideEdit(input: DecideEditInput): EditDecision {
  const { account, sessionFamilyAccount, cache, family, linkState, failMode, nowSec } = input
  const globs = input.unresolved ?? []
  const paths = [...input.paths]
  if (globs.length > 0) {
    for (const claim of cache.all()) {
      if (!paths.includes(claim.path) && globs.some((g) => g.matches(claim.path))) paths.push(claim.path)
    }
  }
  const targets = [...input.paths, ...globs.map((g) => g.pattern)]

  const isOther = (holder: string): boolean => {
    if (account !== null && holder === account) return false
    if (account !== null && family.isFamily(holder, account)) return false
    if (sessionFamilyAccount !== null) {
      if (holder === sessionFamilyAccount) return false
      if (family.isFamily(holder, sessionFamilyAccount)) return false
    }
    return true
  }

  const conflicts = (ignoreExpired: boolean): string[] => {
    const out: string[] = []
    for (const path of paths) {
      const claim = cache.get(path)
      if (!claim) continue
      if (ignoreExpired && claim.deadline <= nowSec) continue
      if (!isOther(claim.holderAccount)) continue
      const nick = input.nickOf?.(claim.holderAccount) ?? claim.holderNick
      out.push(
        `${path} is claimed by ${nick} (for ${formatAge(nowSec - claim.since)}). ` +
          `Use irc_ask ${nick} to coordinate, or ask your user.`,
      )
    }
    return out
  }

  if (linkState === "established") {
    const found = conflicts(false)
    if (found.length > 0) return { effect: "deny", message: found.join("\n") }
    return { effect: "allow" }
  }

  if (failMode === "open") return { effect: "allow" }
  if (failMode === "deny") {
    return {
      effect: "deny",
      message:
        "IRC server unreachable: file claims cannot be checked, so edits are blocked (failMode=deny). Ask your user.",
    }
  }
  const found = conflicts(true)
  if (found.length > 0) {
    return {
      effect: "deny",
      message: found.map((m) => `${m} (cached; IRC server unreachable)`).join("\n"),
    }
  }
  return {
    effect: "ask",
    message:
      targets.length > 0
        ? `IRC server unreachable: claims cannot be checked. Allow this edit of ${targets.join(", ")}?`
        : "IRC server unreachable: claims cannot be checked. Allow this edit?",
  }
}

// ---------------------------------------------------------------------------
// ClaimTracker
// ---------------------------------------------------------------------------

export function claimLine(account: string, path: string): IrcMessage {
  return msg("CLAIM", [account, path])
}

export function releaseLine(account: string, path: string): IrcMessage {
  return msg("RELEASE", [account, path])
}

export class ClaimTracker {
  private byAccount = new Map<string, Set<string>>()

  record(account: string, path: string): void {
    let set = this.byAccount.get(account)
    if (!set) {
      set = new Set()
      this.byAccount.set(account, set)
    }
    set.add(path)
  }

  release(account: string, path: string): boolean {
    const set = this.byAccount.get(account)
    if (!set) return false
    const had = set.delete(path)
    if (set.size === 0) this.byAccount.delete(account)
    return had
  }

  releaseAll(account: string): string[] {
    const set = this.byAccount.get(account)
    this.byAccount.delete(account)
    return set ? [...set] : []
  }

  held(account: string): string[] {
    const set = this.byAccount.get(account)
    return set ? [...set] : []
  }

  /** One CLAIM per held claim. The server may refuse some. */
  burstLines(): IrcMessage[] {
    const out: IrcMessage[] = []
    for (const [account, set] of this.byAccount) {
      for (const path of set) out.push(claimLine(account, path))
    }
    return out
  }

  /** Remove our record on CLAIMDEL, or on CLAIMSET with another holder. Returns true on change. */
  applyServer(line: IrcMessage): boolean {
    if (line.command === "CLAIMDEL") {
      const path = line.params[0]
      if (path === undefined) return false
      let changed = false
      for (const account of [...this.byAccount.keys()]) {
        if (this.release(account, path)) changed = true
      }
      return changed
    }
    if (line.command === "CLAIMSET") {
      const holder = line.params[0]
      const path = line.params[4]
      if (holder === undefined || path === undefined) return false
      let changed = false
      for (const account of [...this.byAccount.keys()]) {
        if (account !== holder && this.release(account, path)) changed = true
      }
      return changed
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

const PATH_KEYS = ["filePath", "file_path", "path", "filename"] as const
const LIST_KEYS = ["files", "edits"] as const
const PATCH_KEYS = ["patch", "patchText", "input", "diff"] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function parsePatchPaths(text: string, out: string[]): void {
  for (const raw of text.split(/\r?\n/)) {
    let m = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/.exec(raw)
    if (!m) m = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(raw)
    if (!m) m = /^\+\+\+ b\/(.+?)(?:\t.*)?$/.exec(raw)
    if (!m) m = /^--- a\/(.+?)(?:\t.*)?$/.exec(raw)
    const p = m?.[1]
    if (p !== undefined && p !== "" && p !== "/dev/null") out.push(p)
  }
}

function collectFromObject(obj: Record<string, unknown>, out: string[], depth: number): void {
  for (const key of PATH_KEYS) {
    const v = obj[key]
    if (typeof v === "string" && v !== "") out.push(v)
  }
  for (const key of PATCH_KEYS) {
    const v = obj[key]
    if (typeof v === "string") parsePatchPaths(v, out)
  }
  if (depth >= 2) return
  for (const key of LIST_KEYS) {
    const v = obj[key]
    if (!Array.isArray(v)) continue
    for (const item of v) {
      if (typeof item === "string") {
        if (item !== "") out.push(item)
      } else if (isRecord(item)) {
        collectFromObject(item, out, depth + 1)
      }
    }
  }
}

export function extractEditPaths(tool: string, input: unknown, editTools: string[]): string[] {
  if (!editTools.includes(tool)) return []
  if (!isRecord(input)) return []
  const out: string[] = []
  collectFromObject(input, out, 0)
  return [...new Set(out)]
}

/** True when `s` has glob syntax: `*`, `?`, a `[...]` class, or a `{a,b}` alternation. */
export function hasGlobSyntax(s: string): boolean {
  return /[*?]/.test(s) || /\[[^\]]+\]/.test(s) || /\{[^}]*,[^}]*\}/.test(s)
}

export interface PermissionPaths {
  /** Literal paths. They are checked against claims directly. */
  paths: string[]
  /** Glob patterns. Every claimed path that matches one is checked. */
  unresolved: string[]
}

/**
 * Paths of an edit permission event. Returns null for actions that are not edits.
 * A resource is a glob only if it has glob syntax and no file of that literal name exists.
 * A glob resource is also kept as a literal path, so a claim on that literal name still matches.
 * Metadata `filePath` and `path` are always literal.
 */
export function extractPermissionPaths(
  ev: { action: string; resources: readonly string[]; metadata?: Record<string, unknown> | undefined },
  editActions: string[],
  exists: (p: string) => boolean,
): PermissionPaths | null {
  if (!editActions.includes(ev.action)) return null
  const paths: string[] = []
  const unresolved: string[] = []
  for (const r of ev.resources) {
    if (r === "") continue
    paths.push(r)
    if (!hasGlobSyntax(r)) continue
    let found = false
    try {
      found = exists(r)
    } catch {
      found = false
    }
    if (!found) unresolved.push(r)
  }
  const meta = ev.metadata
  if (meta) {
    for (const key of ["filePath", "path"] as const) {
      const v = meta[key]
      if (typeof v === "string" && v !== "") paths.push(v)
    }
  }
  return { paths: [...new Set(paths)], unresolved: [...new Set(unresolved)] }
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

export interface GlobMatcher {
  /** The glob as the caller gave it. Used in messages. */
  pattern: string
  matches(path: string): boolean
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
}

function globSource(glob: string): string {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        while (glob.charAt(i + 1) === "*") i++
        if (glob.charAt(i + 1) === "/") {
          re += "(?:.*/)?"
          i++
        } else {
          re += ".*"
        }
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 2)
      if (end === -1) {
        re += "\\["
        continue
      }
      let body = glob.slice(i + 1, end)
      let negate = false
      if (body.startsWith("!") || body.startsWith("^")) {
        negate = true
        body = body.slice(1)
      }
      body = body.replace(/[\\\]^[]/g, "\\$&")
      re += negate ? `[^/${body}]` : `[${body}]`
      i = end
    } else if (c === "{") {
      const end = glob.indexOf("}", i + 1)
      if (end === -1) {
        re += "\\{"
        continue
      }
      const parts = glob.slice(i + 1, end).split(",")
      re += `(?:${parts.map(globSource).join("|")})`
      i = end
    } else {
      re += escapeRegExp(c)
    }
  }
  return re
}

/**
 * Compile a glob that is relative to `cwd`. The literal directory part is
 * canonicalised like a path, so the matcher agrees with canonical claim paths.
 * A glob that cannot be compiled matches every path.
 */
export function compileGlob(
  pattern: string,
  cwd: string,
  realpath: (p: string) => string | null,
): GlobMatcher {
  const segments = resolve(cwd, pattern).split("/")
  const literal: string[] = []
  let i = 0
  for (; i < segments.length; i++) {
    const seg = segments[i] ?? ""
    if (/[*?[\]{}]/.test(seg)) {
      let real: string | null = null
      try {
        real = realpath([...literal, seg].join("/") || "/")
      } catch {
        real = null
      }
      if (real === null) break
    }
    literal.push(seg)
  }
  const prefix = canonicalPath(literal.join("/") || "/", cwd, realpath)
  const rest = segments.slice(i).join("/")
  if (rest === "") return { pattern, matches: (p) => p === prefix }
  const head = prefix.endsWith("/") ? prefix : `${prefix}/`
  let re: RegExp
  try {
    re = new RegExp(`^${escapeRegExp(head)}${globSource(rest)}$`)
  } catch {
    return { pattern, matches: () => true }
  }
  return { pattern, matches: (p) => re.test(p) }
}
