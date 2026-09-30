/**
 * Per-session message state: stored messages, unread counts, reply waiters, join context.
 * Pure: no sockets and no opencode context. Waiters use setTimeout for their timeout only.
 */
import type { InboundMessage } from "./types.ts"
import { casefold } from "./delivery.ts"

export interface InboxOptions {
  previewChars: number
  /** Stored messages per session. Default 500. */
  maxStored?: number
}

export interface ReadEntry {
  msgid: string
  time: string
  target: string
  senderNick: string
  preview: string
  truncated: boolean
}

export type WaitResult =
  | { kind: "reply"; message: InboundMessage }
  | { kind: "interrupted"; message: InboundMessage }
  | { kind: "timeout" }
  | { kind: "aborted" }

export interface WaitOptions {
  replyTo: string
  timeoutMs: number
  signal?: AbortSignal
}

export type OfferResult = "consumed-as-reply" | "interrupted-waiter" | "none"

interface Waiter {
  replyTo: string
  resolve: (r: WaitResult) => void
  timer: ReturnType<typeof setTimeout> | undefined
  cleanup: () => void
}

interface JoinContext {
  channel: string
  topic: string | null
  lines: string[]
}

interface SessionState {
  messages: InboundMessage[]
  byId: Map<string, InboundMessage>
  unread: Set<string>
  /** Unread counts from the server for messages that are not stored locally. */
  server: Map<string, number>
  lastRead: Map<string, string>
  waiters: Waiter[]
  join: JoinContext[]
}

function timeValue(t: string): number {
  const n = Date.parse(t)
  return Number.isNaN(n) ? Number.NEGATIVE_INFINITY : n
}

/** True when time `a` is later than time `b`. Falls back to string order. */
function isLater(a: string, b: string): boolean {
  const x = timeValue(a)
  const y = timeValue(b)
  if (x === y) return a > b
  return x > y
}

function preview(text: string, max: number): { preview: string; truncated: boolean } {
  const points = Array.from(text)
  if (points.length <= max) return { preview: text, truncated: false }
  return { preview: points.slice(0, Math.max(0, max)).join("") + "…", truncated: true }
}

export class Inbox {
  private sessions = new Map<string, SessionState>()
  private previewChars: number
  private maxStored: number

  constructor(opts: InboxOptions) {
    this.previewChars = opts.previewChars
    this.maxStored = opts.maxStored ?? 500
  }

  private state(sessionID: string): SessionState {
    let s = this.sessions.get(sessionID)
    if (!s) {
      s = {
        messages: [],
        byId: new Map(),
        unread: new Set(),
        server: new Map(),
        lastRead: new Map(),
        waiters: [],
        join: [],
      }
      this.sessions.set(sessionID, s)
    }
    return s
  }

  add(sessionID: string, m: InboundMessage, unread: boolean): void {
    const s = this.state(sessionID)
    if (s.byId.has(m.msgid)) return
    s.messages.push(m)
    s.byId.set(m.msgid, m)
    if (unread) s.unread.add(m.msgid)
    while (s.messages.length > this.maxStored) {
      const old = s.messages.shift()
      if (!old) break
      s.byId.delete(old.msgid)
      s.unread.delete(old.msgid)
    }
  }

  /** Unread per target, counting local unread messages plus server-seeded counts. */
  unreadCounts(sessionID: string): Array<{ target: string; count: number }> {
    const s = this.sessions.get(sessionID)
    if (!s) return []
    const counts = new Map<string, number>()
    for (const m of s.messages) {
      if (!s.unread.has(m.msgid)) continue
      counts.set(m.target, (counts.get(m.target) ?? 0) + 1)
    }
    for (const [target, n] of s.server) {
      if (n > 0) counts.set(target, (counts.get(target) ?? 0) + n)
    }
    return [...counts.entries()]
      .map(([target, count]) => ({ target, count }))
      .sort((a, b) => b.count - a.count)
  }

  totalUnread(sessionID: string): number {
    return this.unreadCounts(sessionID).reduce((sum, e) => sum + e.count, 0)
  }

  /** Return unread messages (oldest first) and mark them read. */
  read(sessionID: string, opts: { target?: string; limit?: number } = {}): ReadEntry[] {
    const s = this.sessions.get(sessionID)
    if (!s) return []
    const limit = opts.limit ?? 20
    const wanted = opts.target === undefined ? null : casefold(opts.target)
    const out: ReadEntry[] = []
    for (const m of s.messages) {
      if (out.length >= limit) break
      if (!s.unread.has(m.msgid)) continue
      if (wanted !== null && casefold(m.target) !== wanted) continue
      s.unread.delete(m.msgid)
      const p = preview(m.text, this.previewChars)
      out.push({
        msgid: m.msgid,
        time: m.time,
        target: m.target,
        senderNick: m.senderNick,
        preview: p.preview,
        truncated: p.truncated,
      })
      const prev = s.lastRead.get(m.target)
      if (prev === undefined || isLater(m.time, prev)) s.lastRead.set(m.target, m.time)
    }
    return out
  }

  /** Latest read time per target, for MARKREAD. */
  lastReadTimes(sessionID: string): Map<string, string> {
    return new Map(this.sessions.get(sessionID)?.lastRead ?? [])
  }

  get(sessionID: string, msgid: string): InboundMessage | undefined {
    return this.sessions.get(sessionID)?.byId.get(msgid)
  }

  /** Mark everything in `target` up to `time` as read, and drop the server count. */
  markRead(sessionID: string, target: string, time: string): void {
    const s = this.sessions.get(sessionID)
    if (!s) return
    const wanted = casefold(target)
    for (const m of s.messages) {
      if (casefold(m.target) !== wanted) continue
      if (!isLater(m.time, time)) s.unread.delete(m.msgid)
    }
    for (const key of [...s.server.keys()]) {
      if (casefold(key) === wanted) s.server.delete(key)
    }
    const prev = s.lastRead.get(target)
    if (prev === undefined || isLater(time, prev)) s.lastRead.set(target, time)
  }

  /** Seed the count of unread messages that are not stored locally. */
  setServerUnread(sessionID: string, target: string, count: number): void {
    const s = this.state(sessionID)
    if (count > 0) s.server.set(target, count)
    else s.server.delete(target)
  }

  clear(sessionID: string): void {
    const s = this.sessions.get(sessionID)
    if (!s) return
    for (const w of [...s.waiters]) {
      w.cleanup()
      w.resolve({ kind: "aborted" })
    }
    this.sessions.delete(sessionID)
  }

  // -------------------------------------------------------------------------
  // Waiters
  // -------------------------------------------------------------------------

  waitFor(sessionID: string, opts: WaitOptions): Promise<WaitResult> {
    const s = this.state(sessionID)
    return new Promise<WaitResult>((resolve) => {
      if (opts.signal?.aborted) {
        resolve({ kind: "aborted" })
        return
      }
      const waiter: Waiter = {
        replyTo: opts.replyTo,
        resolve,
        timer: undefined,
        cleanup: () => {
          if (waiter.timer !== undefined) clearTimeout(waiter.timer)
          opts.signal?.removeEventListener("abort", onAbort)
          const idx = s.waiters.indexOf(waiter)
          if (idx !== -1) s.waiters.splice(idx, 1)
        },
      }
      const finish = (r: WaitResult): void => {
        waiter.cleanup()
        resolve(r)
      }
      const onAbort = (): void => finish({ kind: "aborted" })
      waiter.timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(0, opts.timeoutMs))
      opts.signal?.addEventListener("abort", onAbort, { once: true })
      s.waiters.push(waiter)
    })
  }

  /**
   * Offer an inbound message to the waiters of a session before deciding to push it.
   * A reply is consumed by its waiter. Another directed message interrupts the waiters
   * and is returned in their result. In both cases the caller must not push the message.
   */
  offer(sessionID: string, m: InboundMessage, directed: boolean): OfferResult {
    const s = this.sessions.get(sessionID)
    if (!s || s.waiters.length === 0) return "none"
    if (m.replyTo !== null) {
      const hit = s.waiters.find((w) => w.replyTo === m.replyTo)
      if (hit) {
        hit.cleanup()
        hit.resolve({ kind: "reply", message: m })
        return "consumed-as-reply"
      }
    }
    if (!directed) return "none"
    for (const w of [...s.waiters]) {
      w.cleanup()
      w.resolve({ kind: "interrupted", message: m })
    }
    return "interrupted-waiter"
  }

  hasWaiter(sessionID: string): boolean {
    return (this.sessions.get(sessionID)?.waiters.length ?? 0) > 0
  }

  // -------------------------------------------------------------------------
  // Join context
  // -------------------------------------------------------------------------

  recordJoinContext(
    sessionID: string,
    channel: string,
    topic: string | null,
    lines: string[],
  ): void {
    const s = this.state(sessionID)
    const entry: JoinContext = { channel, topic, lines: [...lines] }
    const idx = s.join.findIndex((j) => casefold(j.channel) === casefold(channel))
    if (idx === -1) s.join.push(entry)
    else s.join[idx] = entry
  }

  /** One-time join text. Returns null when nothing is recorded; clears the record. */
  takeJoinContext(sessionID: string): string | null {
    const s = this.sessions.get(sessionID)
    if (!s || s.join.length === 0) return null
    const text = s.join
      .map(
        (j) =>
          `Joined ${j.channel}. Topic: ${j.topic ?? "(none)"}. Recent messages:\n${j.lines.join("\n")}`,
      )
      .join("\n")
    s.join = []
    return text
  }
}
