/**
 * agent-comms opencode plugin: session registry, link wiring, inbound delivery,
 * context text, claims, and the /irc command.
 */
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { hostname } from "node:os"
import { resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import { handleAgentRequest } from "./agent.ts"
import type { AgentDeps } from "./agent.ts"
import {
  ClaimCache,
  ClaimTracker,
  FamilyIndex,
  canonicalPath,
  claimLine,
  compileGlob,
  decideEdit,
  extractEditPaths,
  extractPermissionPaths,
} from "./claims.ts"
import type { EditDecision } from "./claims.ts"
import { buildContext } from "./context.ts"
import {
  HopTracker,
  MultilineAssembler,
  WakeBudget,
  addressedDirectly,
  casefold,
  classify,
  decide,
  decodeInbound,
  wrap,
} from "./delivery.ts"
import { Inbox } from "./inbox.ts"
import { LinkClient } from "./link.ts"
import type { LogLevel } from "./link.ts"
import { childBase, childNick, linkName, projectSlug, provisionalNick, slugify } from "./nick.ts"
import { parseOptions, readToken } from "./options.ts"
import type { IrcMessage } from "./proto.ts"
import { getTag, msg, sourceNick } from "./proto.ts"
import { Registry } from "./registry.ts"
import { registerTools } from "./tools.ts"
import type { ToolDeps } from "./tools.ts"
import type { InboundMessage, Options, SessionRecord } from "./types.ts"
import { LinkDownError } from "./types.ts"

type Ctx = Plugin.Context

/** The part of LinkClient that the runtime uses. Tests pass a fake with this shape. */
export type LinkLike = Pick<
  LinkClient,
  "state" | "connected" | "waitConnected" | "send" | "request" | "query" | "on" | "start" | "stop" | "sendAs" | "sendMultiline"
>

export interface RuntimeDeps {
  link?: LinkLike
  now?: () => number
  log?: (level: LogLevel, message: string) => void
  registerTools?: typeof registerTools
  realpath?: (p: string) => string | null
}

export interface Runtime {
  readonly options: Options
  readonly registry: Registry
  readonly inbox: Inbox
  readonly hop: HopTracker
  readonly claims: ClaimTracker
  readonly cache: ClaimCache
  readonly link: LinkLike
  budgetFor(sessionID: string): WakeBudget
  hopBlockedCount(sessionID: string): number
  /** The lines that the link sends between BURST and ENDBURST. */
  burstLines(): IrcMessage[]
  /** Resolves when all background work (link requests, deliveries) is done. */
  settle(): Promise<void>
  dispose(): Promise<void>
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const PREFIX = "[agent-comms]"

function defaultLog(level: LogLevel, message: string): void {
  if (level === "warn") console.warn(`${PREFIX} ${message}`)
  else if (level === "error") console.error(`${PREFIX} ${message}`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** Part of a child nick after the last "|". */
export function baseOf(nick: string): string {
  const i = nick.lastIndexOf("|")
  return i === -1 ? nick : nick.slice(i + 1)
}

function cleanRealname(title: string): string {
  return title.replace(/[\r\n\0]+/g, " ").trim()
}

// ---------------------------------------------------------------------------
// Event normalisation. The opencode event union is wide, so read it with runtime checks.
// ---------------------------------------------------------------------------

type SessionEvent =
  | { kind: "created"; sessionID: string; parentID: string | null; title: string; agent: string; directory: string }
  | { kind: "renamed"; sessionID: string; title: string }
  | { kind: "moved"; sessionID: string; directory: string }
  | { kind: "deleted"; sessionID: string }
  | { kind: "status"; sessionID: string; busy: boolean }
  | { kind: "idle"; sessionID: string }

function directoryOf(v: unknown): string | null {
  return isRecord(v) ? str(v["directory"]) : null
}

export function normalizeEvent(ev: unknown): SessionEvent | null {
  if (!isRecord(ev)) return null
  const type = ev["type"]
  const data = ev["data"]
  if (typeof type !== "string" || !isRecord(data)) return null
  const sessionID = str(data["sessionID"])
  if (sessionID === null) return null
  switch (type) {
    case "session.created": {
      const directory = directoryOf(data["location"]) ?? directoryOf(ev["location"])
      if (directory === null) return null
      return {
        kind: "created",
        sessionID,
        parentID: str(data["parentID"]),
        title: typeof data["title"] === "string" ? data["title"] : "",
        agent: str(data["agent"]) ?? "build",
        directory,
      }
    }
    case "session.renamed": {
      const title = data["title"]
      return typeof title === "string" ? { kind: "renamed", sessionID, title } : null
    }
    case "session.moved": {
      const directory = directoryOf(data["location"])
      return directory === null ? null : { kind: "moved", sessionID, directory }
    }
    case "session.deleted":
      return { kind: "deleted", sessionID }
    case "session.status": {
      const status = data["status"]
      const t = isRecord(status) ? status["type"] : undefined
      if (t === "idle") return { kind: "status", sessionID, busy: false }
      if (t === "busy" || t === "retry") return { kind: "status", sessionID, busy: true }
      return null
    }
    case "session.execution.started":
      return { kind: "status", sessionID, busy: true }
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return { kind: "status", sessionID, busy: false }
    case "session.idle":
      return { kind: "idle", sessionID }
    default:
      return null
  }
}

interface SessionInfoLite {
  parentID: string | null
  title: string
  agent: string
  directory: string
  archived: boolean
}

function readInfo(v: unknown): SessionInfoLite | null {
  if (!isRecord(v)) return null
  const directory = directoryOf(v["location"])
  if (directory === null) return null
  const time = v["time"]
  const archived = isRecord(time) && typeof time["archived"] === "number" && time["archived"] > 0
  return {
    parentID: str(v["parentID"]),
    title: typeof v["title"] === "string" ? v["title"] : "",
    agent: str(v["agent"]) ?? "build",
    directory,
    archived,
  }
}

interface NewSession {
  sessionID: string
  parentID: string | null
  title: string
  agent: string
  directory: string
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export async function createRuntime(ctx: Ctx, deps: RuntimeDeps = {}): Promise<Runtime | null> {
  const log = deps.log ?? defaultLog
  const parsed = parseOptions(ctx.options)
  const options = parsed.options
  for (const w of parsed.warnings) log("warn", w)
  if (!options.enabled) return null

  const clock = deps.now ?? Date.now
  const realpath = deps.realpath ?? realpathOrNull
  const ourDir: string = ctx.location.directory
  const canonicalDir: string = ctx.location.project.canonical
  const project = projectSlug(canonicalDir !== "" ? canonicalDir : ourDir)

  const registry = new Registry(ctx.storage, ourDir, (level, message) => log(level, message))
  const inbox = new Inbox({ previewChars: options.previewChars })
  const hop = new HopTracker()
  const cache = new ClaimCache()
  const claims = new ClaimTracker()
  const family = new FamilyIndex()
  const budgets = new Map<string, WakeBudget>()
  const hopBlocked = new Map<string, number>()
  let assembler = new MultilineAssembler()

  const introducedOnLink = new Set<string>()
  const pendingRetires = new Map<string, string>()
  const injected = new Set<string>()
  const inflight = new Set<string>()
  const rejected = new Set<string>()
  const adopting = new Map<string, Promise<SessionRecord | undefined>>()
  const chains = new Map<string, Promise<void>>()
  const pending = new Set<Promise<void>>()
  const registrations: Array<{ dispose(): Promise<void> }> = []
  const unsubscribe: Array<() => void> = []
  const abort = new AbortController()
  let everEstablished = false
  let disposed = false

  function budgetFor(sessionID: string): WakeBudget {
    let b = budgets.get(sessionID)
    if (!b) {
      b = new WakeBudget(options.wakeBudget, options.wakeWindowMs)
      budgets.set(sessionID, b)
    }
    return b
  }

  // ------------------------------------------------------------- link setup

  const burst = (): IrcMessage[] => {
    introducedOnLink.clear()
    const owned = registry.ownedBy(ourDir).filter((r) => !r.optedOut)
    const lines: IrcMessage[] = []
    for (const r of owned) {
      lines.push(introduceLine(r))
      introducedOnLink.add(r.sessionID)
    }
    for (const r of owned) lines.push(stateLine(r))
    lines.push(...claims.burstLines())
    return lines
  }

  const link: LinkLike =
    deps.link ??
    new LinkClient({
      host: options.host,
      port: options.port,
      tls: options.tls,
      tlsCaPath: options.tlsCaPath,
      // Several opencode servers can run at the same time (for example the shared
      // service and an app-embedded server). Each process needs its own link name,
      // or the links replace each other forever.
      linkName: linkName(
        `${hostname()}-p${process.pid}`,
        `${ctx.location.project.id}.${createHash("sha256").update(ourDir).digest("hex").slice(0, 8)}`,
      ),
      token: () => readToken(options.tokenPath),
      backoffMaxMs: options.backoffMaxMs,
      serverName: options.serverName,
      requireServerProof: options.requireServerProof,
      burst,
      log: (level, message) => log(level, message),
    })

  // ---------------------------------------------------------- task plumbing

  function track(p: Promise<unknown>): void {
    const q: Promise<void> = p.then(
      () => undefined,
      (e: unknown) => {
        if (!(e instanceof LinkDownError)) log("error", `background task failed: ${errText(e)}`)
      },
    )
    pending.add(q)
    void q.then(() => pending.delete(q))
  }

  /** Run `fn` after all earlier work for the same session. */
  function enqueue(sessionID: string, fn: () => Promise<void>): Promise<void> {
    const prev = chains.get(sessionID) ?? Promise.resolve()
    const next: Promise<void> = prev.then(fn).catch((e: unknown) => {
      if (!(e instanceof LinkDownError)) log("warn", `session ${sessionID}: ${errText(e)}`)
    })
    chains.set(sessionID, next)
    pending.add(next)
    void next.then(() => {
      pending.delete(next)
      if (chains.get(sessionID) === next) chains.delete(sessionID)
    })
    return next
  }

  async function settle(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending])
  }

  // ---------------------------------------------------------- wire building

  function liveParent(rec: SessionRecord): SessionRecord | undefined {
    if (rec.parentID === null) return undefined
    const p = registry.get(rec.parentID)
    return p && !p.optedOut ? p : undefined
  }

  function introduceLine(rec: SessionRecord): IrcMessage {
    const parent = liveParent(rec)
    return msg("INTRODUCE", [
      rec.account,
      rec.nick,
      parent ? parent.account : "*",
      "operator",
      "agent",
      rec.project,
      cleanRealname(rec.title),
    ])
  }

  function stateLine(rec: SessionRecord): IrcMessage {
    return msg("STATE", [rec.account, rec.busy ? "busy" : "idle"])
  }

  // ------------------------------------------------------ reply application

  function applyAssigned(account: string, nick: string): void {
    const rec = registry.get(account)
    if (!rec || rec.nick === nick) return
    const old = rec.nick
    registry.setNick(account, nick, { alias: false })
    if (old !== "") registry.replaceChannel(`#${old}`, `#${nick}`)
  }

  function applyReply(reply: IrcMessage, fromLine = false): void {
    switch (reply.command) {
      case "INTRODUCED":
      case "RENAMED": {
        const account = reply.params[0]
        const nick = reply.params[1]
        if (account === undefined || nick === undefined) return
        applyAssigned(account, nick)
        if (reply.command === "INTRODUCED") introducedOnLink.add(account)
        return
      }
      case "FAIL":
        if (fromLine && getTag(reply, "label") !== undefined) return
        log("warn", `server refused ${reply.params.join(" ")}`)
        return
      default:
        return
    }
  }

  // ------------------------------------------------------ session lifecycle

  function initialNick(
    agent: string,
    sessionID: string,
    title: string,
    live: SessionRecord | undefined,
  ): { nick: string; provisional: boolean } {
    if (live) {
      const idx = registry.nextChildIndex(live.sessionID)
      return { nick: childNick(live.nick, childBase(agent, idx)), provisional: live.provisional }
    }
    if (title.trim() !== "") return { nick: slugify(title, options.nickSlugLength), provisional: false }
    return { nick: provisionalNick(agent, sessionID), provisional: true }
  }

  function defaultChannels(live: SessionRecord | undefined): string[] {
    const out = ["#lobby", `#${project}`]
    if (live) out.push(`#${live.nick}`)
    return out
  }

  function cleanupLocal(sessionID: string): void {
    claims.releaseAll(sessionID)
    family.delete(sessionID)
    budgets.delete(sessionID)
    hopBlocked.delete(sessionID)
    hop.endTurn(sessionID)
    inbox.clear(sessionID)
    introducedOnLink.delete(sessionID)
    assembler.clear(sessionID)
  }

  async function register(info: NewSession): Promise<SessionRecord | undefined> {
    if (info.directory !== ourDir) return undefined
    const existing = registry.get(info.sessionID)
    if (existing) return existing
    let parent = info.parentID !== null ? registry.get(info.parentID) : undefined
    if (info.parentID !== null && !parent) parent = await adopt(info.parentID)
    const again = registry.get(info.sessionID)
    if (again) return again

    const optedOut = options.excludeAgents.includes(info.agent) || parent?.optedOut === true
    const live = parent && !parent.optedOut ? parent : undefined
    const { nick, provisional } = optedOut
      ? { nick: "", provisional: false }
      : initialNick(info.agent, info.sessionID, info.title, live)

    const rec: SessionRecord = {
      sessionID: info.sessionID,
      account: info.sessionID,
      nick,
      provisional,
      parentID: info.parentID,
      agent: info.agent,
      title: info.title,
      project,
      optedOut,
      busy: false,
      channels: optedOut ? [] : defaultChannels(live),
    }
    registry.put(rec, info.directory)
    family.set(rec.sessionID, rec.parentID)
    if (live && !optedOut) registry.addChannel(live.sessionID, `#${live.nick}`)
    if (!optedOut) introduce(rec.sessionID)
    return rec
  }

  function adopt(sessionID: string): Promise<SessionRecord | undefined> {
    const known = registry.get(sessionID)
    if (known) return Promise.resolve(known)
    if (rejected.has(sessionID)) return Promise.resolve(undefined)
    const running = adopting.get(sessionID)
    if (running) return running
    const p = (async (): Promise<SessionRecord | undefined> => {
      let info: SessionInfoLite | null
      try {
        info = readInfo(await ctx.session.get({ sessionID }))
      } catch {
        return undefined
      }
      if (info === null || info.directory !== ourDir || info.archived) {
        rejected.add(sessionID)
        return undefined
      }
      return register({
        sessionID,
        parentID: info.parentID,
        title: info.title,
        agent: info.agent,
        directory: info.directory,
      })
    })().finally(() => adopting.delete(sessionID))
    adopting.set(sessionID, p)
    return p
  }

  /** Send INTRODUCE (after the parent is introduced) and adopt the assigned nick. */
  function introduce(sessionID: string): void {
    void enqueue(sessionID, async () => {
      const rec = registry.get(sessionID)
      if (!rec || rec.optedOut) return
      const parent = liveParent(rec)
      if (parent) {
        await chains.get(parent.sessionID)
        const want = childNick(parent.nick, baseOf(rec.nick))
        if (want !== rec.nick) registry.setNick(sessionID, want, { alias: false })
      }
      if (!link.connected) return
      applyReply(await link.request(introduceLine(rec)))
    })
  }

  function queueState(sessionID: string): void {
    void enqueue(sessionID, async () => {
      const rec = registry.get(sessionID)
      if (!rec || rec.optedOut || !link.connected || !introducedOnLink.has(sessionID)) return
      link.send(stateLine(rec))
    })
  }

  function clearProvisional(sessionID: string): void {
    registry.update(sessionID, { provisional: false })
    for (const c of registry.children(sessionID)) clearProvisional(c.sessionID)
  }

  async function renameTo(sessionID: string, want: string): Promise<void> {
    const rec = registry.get(sessionID)
    if (!rec || rec.optedOut) return
    const old = rec.nick
    if (old !== want) {
      registry.setNick(sessionID, want)
      registry.replaceChannel(`#${old}`, `#${want}`)
      if (link.connected && introducedOnLink.has(sessionID)) {
        try {
          applyReply(await link.request(msg("RENAME", [sessionID, want])))
        } catch (e) {
          if (!(e instanceof LinkDownError)) log("warn", `rename failed: ${errText(e)}`)
        }
      }
    }
    const parentNick = registry.get(sessionID)?.nick ?? want
    for (const child of registry.children(sessionID)) {
      if (child.optedOut) continue
      await renameTo(child.sessionID, childNick(parentNick, baseOf(child.nick)))
    }
  }

  async function onTitle(sessionID: string, title: string): Promise<void> {
    const rec = registry.get(sessionID) ?? (await adopt(sessionID))
    if (!rec || title.trim() === "" || title === rec.title) return
    registry.update(sessionID, { title })
    if (rec.optedOut) return
    if (rec.provisional && liveParent(rec) === undefined) {
      const want = slugify(title, options.nickSlugLength)
      clearProvisional(sessionID)
      void enqueue(sessionID, () => renameTo(sessionID, want))
    }
  }

  async function onBusy(sessionID: string, busy: boolean): Promise<void> {
    const rec = registry.get(sessionID) ?? (await adopt(sessionID))
    if (!rec) return
    if (!busy) track(checkArchived(sessionID))
    if (rec.busy === busy) return
    registry.setBusy(sessionID, busy)
    if (!busy) hop.endTurn(sessionID)
    if (!rec.optedOut) queueState(sessionID)
  }

  async function checkArchived(sessionID: string): Promise<void> {
    let info: SessionInfoLite | null
    try {
      info = readInfo(await ctx.session.get({ sessionID }))
    } catch {
      return
    }
    if (info?.archived) retire(sessionID, "session archived")
  }

  function retire(sessionID: string, reason: string): void {
    const rec = registry.get(sessionID)
    if (!rec) return
    cleanupLocal(sessionID)
    registry.remove(sessionID)
    if (rec.optedOut) return
    void enqueue(sessionID, async () => {
      try {
        await link.request(msg("RETIRE", [sessionID, reason]))
      } catch (e) {
        if (e instanceof LinkDownError) pendingRetires.set(sessionID, reason)
        else throw e
      }
    })
  }

  /** The session left this location. Drop it locally without a RETIRE. */
  function forget(sessionID: string): void {
    const rec = registry.get(sessionID)
    if (!rec) return
    cleanupLocal(sessionID)
    pendingRetires.delete(sessionID)
    registry.remove(sessionID)
  }

  async function handleEvent(ev: unknown): Promise<void> {
    const n = normalizeEvent(ev)
    if (!n) return
    switch (n.kind) {
      case "created":
        await register(n)
        return
      case "renamed":
        await onTitle(n.sessionID, n.title)
        return
      case "moved":
        if (n.directory === ourDir) {
          rejected.delete(n.sessionID)
          await adopt(n.sessionID)
        } else {
          forget(n.sessionID)
          rejected.add(n.sessionID)
        }
        return
      case "deleted":
        retire(n.sessionID, "session deleted")
        return
      case "status":
        await onBusy(n.sessionID, n.busy)
        return
      case "idle":
        await onBusy(n.sessionID, false)
        return
    }
  }

  // ------------------------------------------------------- inbound delivery

  async function inject(sessionID: string, text: string, delivery?: "steer" | "queue"): Promise<boolean> {
    injected.add(text)
    try {
      await ctx.session.prompt({
        sessionID,
        text,
        metadata: { agentComms: true },
        ...(delivery !== undefined ? { delivery } : {}),
      })
      return true
    } catch (e) {
      log("warn", `cannot deliver message to session ${sessionID}: ${errText(e)}`)
      return false
    } finally {
      injected.delete(text)
    }
  }

  async function onInbound(sessionID: string, m: InboundMessage): Promise<void> {
    const rec = registry.get(sessionID)
    if (!rec) return
    if (m.senderAccount !== null && m.senderAccount === rec.account) return
    if (m.msgid !== "") {
      if (inbox.get(sessionID, m.msgid) !== undefined || inflight.has(m.msgid)) return
    }
    const me = { nick: rec.nick, aliases: registry.aliases(sessionID) }
    const directedness = classify(m, me)
    // "buffered": an ask window holds the message. Store it as read; the window either
    // uses it or hands it back through redeliver.
    const offer = inbox.offer(sessionID, m, directedness === "directed")
    if (offer !== "none") {
      inbox.add(sessionID, m, false)
      return
    }
    await dispatch(sessionID, rec, m)
  }

  /** Deliver messages that an ask window did not use, as if they had just arrived. */
  function redeliver(sessionID: string, messages: InboundMessage[]): void {
    track(
      (async () => {
        for (const m of messages) {
          const rec = registry.get(sessionID)
          if (!rec) return
          await dispatch(sessionID, rec, m)
        }
      })(),
    )
  }

  /** Store a message. It can already be stored as read by an ask window. */
  function store(sessionID: string, m: InboundMessage, unread: boolean): void {
    inbox.add(sessionID, m, unread)
    if (unread) inbox.markUnread(sessionID, m.msgid)
  }

  /** Decide how to deliver an inbound message, then push it or keep it unread. */
  async function dispatch(sessionID: string, rec: SessionRecord, m: InboundMessage): Promise<void> {
    const me = { nick: rec.nick, aliases: registry.aliases(sessionID) }
    const directedness = classify(m, me)
    const now = clock()
    const budget = budgetFor(sessionID)
    const decision = decide({
      m,
      directedness,
      busy: rec.busy,
      optedOut: rec.optedOut,
      hopLimit: options.hopLimit,
      budget,
      now,
      addressed: addressedDirectly(m, me),
    })

    if (decision.kind === "unread") {
      if (decision.reason === "hop-limit") hopBlocked.set(sessionID, (hopBlocked.get(sessionID) ?? 0) + 1)
      store(sessionID, m, true)
      return
    }

    const fromOperator = m.rel === "operator" || m.role === "operator"
    const text = wrap(m, rec.nick)
    if (m.msgid !== "") inflight.add(m.msgid)
    try {
      if (decision.mode === "steer") {
        hop.steerTurn(sessionID, m.hop, fromOperator)
        const ok = await inject(sessionID, text, "steer")
        store(sessionID, m, !ok)
        return
      }
      if (decision.countsAgainstBudget) budget.consume(now)
      hop.startTurn(sessionID, m.hop, fromOperator)
      registry.setBusy(sessionID, true)
      queueState(sessionID)
      const ok = await inject(sessionID, text)
      if (!ok) {
        registry.setBusy(sessionID, false)
        hop.endTurn(sessionID)
        queueState(sessionID)
      }
      store(sessionID, m, !ok)
    } finally {
      if (m.msgid !== "") inflight.delete(m.msgid)
    }
  }

  function onDeliver(account: string, inner: IrcMessage, outer: IrcMessage): void {
    const rec = registry.get(account)
    if (!rec) return

    if (inner.command === "JOIN" || inner.command === "PART") {
      const who = sourceNick(inner)
      const channel = inner.params[0]
      if (who !== null && channel !== undefined && casefold(who) === casefold(rec.nick)) {
        if (inner.command === "JOIN") registry.addChannel(account, channel)
        else registry.removeChannel(account, channel)
      }
      return
    }

    const assembled = assembler.push(account, inner)
    if (assembled === null) return
    const m = decodeInbound(account, assembled, getTag(outer, "batch") !== undefined)
    if (m === null) return
    track(onInbound(account, m))
  }

  // ------------------------------------------------------------ server lines

  const agentDeps: AgentDeps = {
    registry,
    inbox,
    claims,
    budget: budgetFor,
    hopBlocked: {
      get: (id) => hopBlocked.get(id) ?? 0,
      reset: (id) => {
        hopBlocked.delete(id)
      },
    },
    interrupt: async (sessionID) => {
      await ctx.session.interrupt({ sessionID, resume: false })
    },
    now: clock,
  }

  function onLine(m: IrcMessage): void {
    switch (m.command) {
      case "INTRODUCED":
      case "RENAMED":
      case "FAIL":
        applyReply(m, true)
        return
      case "CLAIMSET":
      case "CLAIMDEL":
        cache.apply(m)
        claims.applyServer(m)
        return
      case "CLAIMFAIL":
        log("warn", `claim refused: ${m.params.join(" ")}`)
        return
      case "BURST":
        cache.serverBurstStarted()
        return
      case "ENDBURST":
        cache.serverBurstEnded()
        return
      case "DISOWN": {
        const account = m.params[0]
        if (account !== undefined) {
          forget(account)
          rejected.add(account)
        }
        return
      }
      case "RETIRED": {
        // The server retired an account that is still live here (for example after 30 idle days).
        const account = m.params[0]
        const rec = account === undefined ? undefined : registry.get(account)
        if (account !== undefined && rec && !rec.optedOut && getTag(m, "label") === undefined) {
          introducedOnLink.delete(account)
          introduce(account)
          queueState(account)
        }
        return
      }
      case "AGENT":
        track(
          handleAgentRequest(m, agentDeps).then((lines) => {
            for (const l of lines) {
              try {
                link.send(l)
              } catch {
                return
              }
            }
          }),
        )
        return
      default:
        return
    }
  }

  async function afterEstablished(): Promise<void> {
    for (const [id, reason] of [...pendingRetires]) {
      try {
        await link.request(msg("RETIRE", [id, reason]))
        pendingRetires.delete(id)
      } catch (e) {
        if (e instanceof LinkDownError) return
        pendingRetires.delete(id)
      }
    }
    for (const rec of registry.ownedBy(ourDir)) {
      if (rec.optedOut || introducedOnLink.has(rec.sessionID)) continue
      introduce(rec.sessionID)
      queueState(rec.sessionID)
    }
  }

  unsubscribe.push(link.on("deliver", onDeliver))
  unsubscribe.push(link.on("line", onLine))
  unsubscribe.push(
    link.on("established", () => {
      everEstablished = true
      track(afterEstablished())
    }),
  )
  unsubscribe.push(
    link.on("down", () => {
      introducedOnLink.clear()
      assembler = new MultilineAssembler()
    }),
  )

  // ------------------------------------------------------------------ claims

  function canonicalize(sessionID: string, paths: string[]): string[] {
    const dir = registry.directoryOf(sessionID) ?? ourDir
    return [...new Set(paths.map((p) => canonicalPath(p, dir, realpath)))]
  }

  async function claimPaths(sessionID: string, rawPaths: string[]): Promise<void> {
    const rec = registry.get(sessionID)
    if (!rec || rec.optedOut) return
    const paths = canonicalize(sessionID, rawPaths)
    for (const p of paths) claims.record(rec.account, p)
    for (const p of paths) {
      if (!link.connected) return
      try {
        const reply = await link.request(claimLine(rec.account, p))
        if (reply.command === "CLAIMFAIL") {
          claims.release(rec.account, p)
          log("warn", `claim refused: ${reply.params.join(" ")}`)
        } else if (reply.command === "CLAIMSET") {
          cache.apply(reply)
        } else if (reply.command === "FAIL") {
          log("warn", `claim failed: ${reply.params.join(" ")}`)
        }
      } catch (e) {
        if (e instanceof LinkDownError) return
        log("warn", `claim failed: ${errText(e)}`)
      }
    }
  }

  async function parentOf(sessionID: string): Promise<string | null> {
    try {
      return readInfo(await ctx.session.get({ sessionID }))?.parentID ?? null
    } catch {
      return null
    }
  }

  async function nearestRegisteredAncestor(sessionID: string): Promise<string | null> {
    const own = registry.get(sessionID)
    let cur: string | null = own ? own.parentID : await parentOf(sessionID)
    for (let i = 0; cur !== null && i < 16; i++) {
      const r = registry.get(cur)
      if (r && !r.optedOut) return r.account
      cur = r ? r.parentID : await parentOf(cur)
    }
    return null
  }

  async function evaluateEdit(
    sessionID: string,
    ev: { action: string; resources: readonly string[]; metadata?: Record<string, unknown> | undefined },
  ): Promise<EditDecision> {
    const dir = registry.directoryOf(sessionID) ?? ourDir
    const exists = (p: string): boolean => realpath(resolve(dir, p)) !== null
    const extracted = extractPermissionPaths(ev, options.editActions, exists)
    if (extracted === null) return { effect: "allow" }
    const canon = canonicalize(sessionID, extracted.paths)
    const globs = extracted.unresolved.map((g) => compileGlob(g, dir, realpath))
    if (!link.connected) await link.waitConnected(options.graceMs)
    const rec = registry.get(sessionID) ?? (await adopt(sessionID))
    const account = rec && !rec.optedOut ? rec.account : null
    const familyAccount = account === null ? await nearestRegisteredAncestor(sessionID) : null
    return decideEdit({
      account,
      sessionFamilyAccount: familyAccount,
      paths: canon,
      unresolved: globs,
      cache,
      family,
      linkState: link.state,
      failMode: options.failMode,
      nowSec: Math.floor(clock() / 1000),
    })
  }

  // ----------------------------------------------------------------- context

  function linkStateText(): "up" | "down" | "never" {
    if (link.connected) return "up"
    return everEstablished ? "down" : "never"
  }

  function contextText(rec: SessionRecord): string {
    return buildContext({
      nick: rec.optedOut || rec.nick === "" ? null : rec.nick,
      optedOut: rec.optedOut,
      channels: rec.channels,
      unread: inbox.unreadCounts(rec.sessionID),
      budget: budgetFor(rec.sessionID).snapshot(clock()),
      linkState: linkStateText(),
      failMode: options.failMode,
      hopBlocked: hopBlocked.get(rec.sessionID) ?? 0,
      joinContext: inbox.takeJoinContext(rec.sessionID),
    })
  }

  // ------------------------------------------------------------ /irc command

  async function say(sessionID: string, text: string): Promise<void> {
    try {
      await ctx.session.synthetic({ sessionID, text, resume: false })
    } catch (e) {
      log("warn", `cannot post /irc reply: ${errText(e)}`)
    }
  }

  function statusText(rec: SessionRecord): string {
    const b = budgetFor(rec.sessionID).snapshot(clock())
    const head = rec.optedOut ? "IRC is off for this session" : `IRC nick "${rec.nick}"`
    const channels = rec.channels.length > 0 ? rec.channels.join(", ") : "none"
    return (
      `${head}; channels: ${channels}; link: ${linkStateText()}; wake budget ${b.used}/${b.limit}; ` +
      `unread ${inbox.totalUnread(rec.sessionID)}; claims ${claims.held(rec.account).length}; ` +
      `hop-blocked ${hopBlocked.get(rec.sessionID) ?? 0}.`
    )
  }

  async function onIrcCommand(sessionID: string, raw: string): Promise<void> {
    const arg = raw.trim().replace(/^\/?irc\b/i, "").trim().split(/\s+/)[0]?.toLowerCase() ?? ""
    const rec = registry.get(sessionID) ?? (await adopt(sessionID))
    if (!rec) {
      await say(sessionID, "IRC: this session is not managed by agent-comms.")
      return
    }
    switch (arg) {
      case "off": {
        if (rec.optedOut) {
          await say(sessionID, "IRC is already off for this session.")
          return
        }
        registry.setOptedOut(sessionID, true)
        claims.releaseAll(sessionID)
        introducedOnLink.delete(sessionID)
        void enqueue(sessionID, async () => {
          try {
            await link.request(msg("RETIRE", [sessionID, "opted out"]))
          } catch (e) {
            if (e instanceof LinkDownError) pendingRetires.set(sessionID, "opted out")
            else throw e
          }
        })
        await say(sessionID, "IRC is off for this session. Your nick is hidden. Use /irc on to enable it again.")
        return
      }
      case "on": {
        if (!rec.optedOut) {
          await say(sessionID, "IRC is already on for this session.")
          return
        }
        pendingRetires.delete(sessionID)
        registry.setOptedOut(sessionID, false)
        const live = liveParent(rec)
        const { nick, provisional } = initialNick(rec.agent, sessionID, rec.title, live)
        registry.setNick(sessionID, nick, { alias: false })
        registry.update(sessionID, { provisional, channels: defaultChannels(live) })
        if (live) registry.addChannel(live.sessionID, `#${live.nick}`)
        introduce(sessionID)
        queueState(sessionID)
        await say(sessionID, `IRC is on for this session. Your nick is "${nick}".`)
        return
      }
      default:
        await say(sessionID, statusText(rec))
    }
  }

  // ------------------------------------------------------------- registration

  await registry.load()
  for (const r of registry.all()) family.set(r.sessionID, r.parentID)

  registrations.push(
    await ctx.session.hook("context", async (ev) => {
      const rec = registry.get(ev.sessionID) ?? (await adopt(ev.sessionID))
      if (!rec) return
      ev.system.push({ type: "text", text: contextText(rec) })
    }),
  )

  registrations.push(
    await ctx.session.hook("prompt", (ev) => {
      if (ev.metadata?.["agentComms"] === true) return
      if (injected.has(ev.prompt.text)) return
      if (!registry.get(ev.sessionID)) return
      // A prompt that the user typed starts a turn at hop 0.
      hop.startTurn(ev.sessionID, 0, true)
    }),
  )

  registrations.push(
    await ctx.permission.hook("evaluate", async (ev) => {
      const decision = await evaluateEdit(ev.sessionID, ev)
      if (decision.effect === "allow") return
      if (decision.effect === "ask" && ev.effect === "deny") return
      ev.effect = decision.effect
      ev.message = decision.message
    }),
  )

  registrations.push(
    await ctx.tool.hook("execute.after", (ev) => {
      if (ev.status !== "completed") return
      if (!options.claimEditTools.includes(ev.tool)) return
      const paths = extractEditPaths(ev.tool, ev.input, options.claimEditTools)
      if (paths.length === 0) return
      track(claimPaths(ev.sessionID, paths))
    }),
  )

  registrations.push(
    await ctx.command.transform((editor) => {
      editor.add({
        name: "irc",
        description: "Control IRC for this session: /irc on, /irc off, /irc status",
        execute: async (input) => {
          await onIrcCommand(input.sessionID, input.prompt.text)
        },
      })
    }),
  )

  const toolDeps: ToolDeps = {
    link: link as ToolDeps["link"],
    inbox,
    registry,
    hop,
    claims,
    options,
    onChannelsChanged: (sessionID: string) => registry.persist(sessionID),
    redeliver,
  }
  registrations.push(await (deps.registerTools ?? registerTools)(ctx, toolDeps))

  // Event subscription. It restarts after a failure until cleanup aborts it.
  void (async () => {
    while (!abort.signal.aborted) {
      try {
        for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
          try {
            await handleEvent(ev)
          } catch (e) {
            log("error", `event handling failed: ${errText(e)}`)
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) log("warn", `event stream failed: ${errText(e)}`)
      }
      if (abort.signal.aborted) return
      await sleep(1000, abort.signal)
    }
  })()

  link.start().catch((e: unknown) => log("warn", `link start failed: ${errText(e)}`))

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    abort.abort()
    for (const off of unsubscribe) off()
    link.stop()
    for (const r of registrations) {
      try {
        await r.dispose()
      } catch (e) {
        log("warn", `cleanup failed: ${errText(e)}`)
      }
    }
    for (const r of registry.all()) inbox.clear(r.sessionID)
    await registry.flush()
  }

  return {
    options,
    registry,
    inbox,
    hop,
    claims,
    cache,
    link,
    budgetFor,
    hopBlockedCount: (id) => hopBlocked.get(id) ?? 0,
    burstLines: burst,
    settle,
    dispose,
  }
}

export default Plugin.define({
  id: "agent-comms",
  async setup(ctx) {
    const rt = await createRuntime(ctx)
    if (rt === null) return
    return () => rt.dispose()
  },
})
