import { readFile } from "node:fs/promises"
import { createConnection, isIP } from "node:net"
import type { Socket } from "node:net"
import { connect as tlsConnect } from "node:tls"
import type { IrcMessage, Tags } from "./proto.ts"
import { LINK_LIMITS, LineSplitter, getTag, msg, parseLine, serializeLine, setTag } from "./proto.ts"
import type { LinkApi, LinkState } from "./types.ts"
import { LinkDownError } from "./types.ts"

/** Minimal duplex transport. Tests inject an in-memory implementation. */
export interface LinkConn {
  write(s: string): void
  end(): void
  onData(cb: (chunk: string) => void): void
  onClose(cb: (err?: Error) => void): void
}

export type ConnectFn = (host: string, port: number, tls: boolean) => Promise<LinkConn>

export type LogLevel = "debug" | "info" | "warn" | "error"

export type SendResult = { ok: true; msgid: string } | { ok: false; code: string; reason: string }

export interface LinkClientOptions {
  host: string
  port: number
  tls: boolean
  tlsCaPath: string | null
  linkName: string
  token: () => Promise<string>
  backoffMaxMs: number
  requestTimeoutMs?: number
  burst: () => IrcMessage[] | Promise<IrcMessage[]>
  log?: (level: LogLevel, msg: string, extra?: object) => void
  connect?: ConnectFn
  /** Send our own PING after this much silence. Default 60000. */
  pingAfterMs?: number
  /** Drop the connection after this much silence. Default 120000. */
  deadAfterMs?: number
}

export interface LinkEvents {
  line: (m: IrcMessage) => void
  deliver: (account: string, inner: IrcMessage, outer: IrcMessage) => void
  established: () => void
  down: () => void
  linked: () => void
}

const PROTOCOL_VERSION = "1"
const CONNECT_TIMEOUT_MS = 10_000
const MAX_PENDING_BYTES = 1_048_576

/** Backoff delay: 500ms * 2^attempt, capped at maxMs, with +-20% jitter. */
export function backoffDelay(attempt: number, maxMs: number, rand: () => number = Math.random): number {
  const base = Math.min(500 * 2 ** Math.min(attempt, 30), maxMs)
  return Math.max(1, Math.round(base * (0.8 + rand() * 0.4)))
}

function defaultConnect(tlsCaPath: string | null): ConnectFn {
  return async (host, port, useTls) => {
    const ca = useTls && tlsCaPath !== null ? await readFile(tlsCaPath) : undefined
    return new Promise<LinkConn>((resolve, reject) => {
      const socket: Socket = useTls
        ? tlsConnect({ host, port, ...(ca !== undefined ? { ca } : {}), ...(isIP(host) === 0 ? { servername: host } : {}) })
        : createConnection({ host, port })
      let ready = false
      const timer = setTimeout(() => socket.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS)
      const fail = (e: Error): void => {
        if (ready) return
        clearTimeout(timer)
        reject(e)
      }
      socket.once("error", fail)
      socket.once("close", () => fail(new Error("connection closed")))
      socket.setEncoding("utf8")
      socket.setNoDelay(true)
      socket.once(useTls ? "secureConnect" : "connect", () => {
        ready = true
        clearTimeout(timer)
        let dataCb: ((chunk: string) => void) | null = null
        let closeCb: ((err?: Error) => void) | null = null
        let closed = false
        let closeErr: Error | undefined
        const backlog: string[] = []
        const fireClose = (err?: Error): void => {
          if (closed) return
          closed = true
          closeErr = err
          closeCb?.(err)
        }
        socket.on("error", (e: Error) => fireClose(e))
        socket.on("close", () => fireClose())
        socket.on("data", (d: string | Buffer) => {
          const s = typeof d === "string" ? d : d.toString("utf8")
          if (dataCb) dataCb(s)
          else backlog.push(s)
        })
        resolve({
          write: (s) => {
            socket.write(s)
          },
          end: () => {
            socket.destroy()
          },
          onData: (cb) => {
            dataCb = cb
            for (const s of backlog.splice(0)) cb(s)
          },
          onClose: (cb) => {
            closeCb = cb
            if (closed) cb(closeErr)
          },
        })
      })
    })
  }
}

interface Pending {
  onOuter?: (m: IrcMessage) => void
  onInner?: (account: string, inner: IrcMessage) => void
  fail: (e: Error) => void
}

function cloneMsg(m: IrcMessage): IrcMessage {
  return {
    tags: m.tags.map(([k, v]) => [k, v] as [string, string | null]),
    source: m.source,
    command: m.command,
    params: [...m.params],
  }
}

function describeFail(m: IrcMessage): string {
  return `${m.command} ${m.params.join(" ")}`.trim()
}

function mapSendReply(m: IrcMessage): SendResult {
  switch (m.command) {
    case "SENT":
      return { ok: true, msgid: m.params[1] ?? "" }
    case "SENDFAIL":
      return { ok: false, code: m.params[1] ?? "UNKNOWN", reason: m.params[2] ?? "" }
    case "FAIL":
      return { ok: false, code: m.params[1] ?? "UNKNOWN", reason: m.params[m.params.length - 1] ?? "" }
    default:
      return { ok: false, code: "UNEXPECTED", reason: `unexpected reply ${m.command}` }
  }
}

type Phase = "idle" | "handshake" | "linked"

export class LinkClient implements LinkApi {
  private readonly opts: LinkClientOptions
  private readonly connectFn: ConnectFn
  private readonly requestTimeoutMs: number
  private readonly pingAfterMs: number
  private readonly deadAfterMs: number

  private _state: LinkState = "down"
  private phase: Phase = "idle"
  private running = false
  private stopped = false
  private gen = 0
  private attempt = 0
  private conn: LinkConn | null = null
  private splitter = new LineSplitter()
  private serverBurstSeen = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private lastRx = 0
  private lastPing = 0
  private pingSeq = 0
  private labelSeq = 0
  private readonly pending = new Map<string, Pending>()
  private readonly waiters = new Set<(ok: boolean) => void>()
  private readonly listeners = new Map<keyof LinkEvents, Set<(...a: never[]) => void>>()

  constructor(opts: LinkClientOptions) {
    this.opts = opts
    this.connectFn = opts.connect ?? defaultConnect(opts.tlsCaPath)
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000
    this.pingAfterMs = opts.pingAfterMs ?? 60_000
    this.deadAfterMs = opts.deadAfterMs ?? 120_000
  }

  get state(): LinkState {
    return this._state
  }

  get connected(): boolean {
    return this._state === "established"
  }

  // ---------------------------------------------------------------- events

  on<E extends keyof LinkEvents>(event: E, cb: LinkEvents[E]): () => void {
    const existing = this.listeners.get(event)
    const set: Set<(...a: never[]) => void> = existing ?? new Set()
    if (!existing) this.listeners.set(event, set)
    const fn = cb as unknown as (...a: never[]) => void
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  }

  private emit<E extends keyof LinkEvents>(event: E, ...args: Parameters<LinkEvents[E]>): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const cb of [...set]) {
      try {
        ;(cb as unknown as (...a: unknown[]) => void)(...args)
      } catch (e) {
        this.log("error", `listener for "${event}" threw`, { error: String(e) })
      }
    }
  }

  private log(level: LogLevel, message: string, extra?: object): void {
    try {
      this.opts.log?.(level, message, extra)
    } catch {
      // A failing logger must not break the link.
    }
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.stopped = false
    this.attempt = 0
    await this.connectOnce()
  }

  stop(): void {
    this.running = false
    this.stopped = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.handleClose(this.gen)
    for (const w of [...this.waiters]) w(false)
  }

  waitConnected(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.connected) return Promise.resolve(true)
    if (signal?.aborted) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const waiter = (ok: boolean): void => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        this.waiters.delete(waiter)
        resolve(ok)
      }
      const onAbort = (): void => waiter(false)
      const timer = setTimeout(() => waiter(false), timeoutMs)
      signal?.addEventListener("abort", onAbort, { once: true })
      this.waiters.add(waiter)
    })
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped || this._state !== "down") return
    this._state = "connecting"
    const gen = ++this.gen
    let token: string
    try {
      token = await this.opts.token()
    } catch (e) {
      this.log("warn", `cannot read link token: ${(e as Error).message}`)
      this.handleClose(gen)
      return
    }
    if (gen !== this.gen) return
    let conn: LinkConn
    try {
      conn = await this.connectFn(this.opts.host, this.opts.port, this.opts.tls)
    } catch (e) {
      this.log("warn", `connect to ${this.opts.host}:${this.opts.port} failed: ${(e as Error).message}`)
      this.handleClose(gen)
      return
    }
    if (gen !== this.gen) {
      conn.end()
      return
    }
    this.conn = conn
    this.splitter = new LineSplitter()
    this.phase = "handshake"
    this.serverBurstSeen = false
    conn.onData((chunk) => this.onData(gen, chunk))
    conn.onClose((err) => this.handleClose(gen, err))
    this.startKeepalive()
    try {
      // The token appears only in this line. Never log it.
      conn.write(serializeLine(msg("LINK", [PROTOCOL_VERSION, this.opts.linkName, token])) + "\r\n")
    } catch (e) {
      this.log("warn", `write failed: ${(e as Error).message}`)
      this.handleClose(gen)
    }
  }

  private handleClose(gen: number, err?: Error): void {
    if (gen !== this.gen) return
    this.gen++
    const conn = this.conn
    this.conn = null
    this.stopKeepalive()
    const prev = this._state
    this._state = "down"
    this.phase = "idle"
    if (err) this.log("warn", `link closed: ${err.message}`)
    else if (prev !== "down") this.log("info", "link closed")
    if (conn) {
      try {
        conn.end()
      } catch {
        // Already closed.
      }
    }
    this.failPending(new LinkDownError())
    if (prev === "linked" || prev === "established") this.emit("down")
    if (!this.stopped) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return
    const delay = backoffDelay(this.attempt, this.opts.backoffMaxMs)
    this.attempt += 1
    this.log("debug", `reconnect in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connectOnce()
    }, delay)
  }

  private failPending(err: Error): void {
    for (const p of [...this.pending.values()]) p.fail(err)
    this.pending.clear()
  }

  // ------------------------------------------------------------- keepalive

  private startKeepalive(): void {
    this.stopKeepalive()
    this.lastRx = Date.now()
    this.lastPing = 0
    const every = Math.max(10, Math.floor(Math.min(this.pingAfterMs, this.deadAfterMs) / 4))
    this.keepaliveTimer = setInterval(() => this.keepaliveTick(), every)
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  private keepaliveTick(): void {
    const now = Date.now()
    const idle = now - this.lastRx
    if (idle >= this.deadAfterMs) {
      this.log("warn", "link silent too long; dropping connection")
      this.handleClose(this.gen, new Error("keepalive timeout"))
      return
    }
    if (idle >= this.pingAfterMs && now - this.lastPing >= this.pingAfterMs) {
      this.lastPing = now
      this.pingSeq += 1
      try {
        this.writeMsg(msg("PING", [`ka${this.pingSeq}`]))
      } catch (e) {
        this.log("warn", `ping failed: ${(e as Error).message}`)
      }
    }
  }

  // --------------------------------------------------------------- inbound

  private onData(gen: number, chunk: string): void {
    if (gen !== this.gen) return
    this.lastRx = Date.now()
    const lines = this.splitter.push(chunk)
    for (const line of lines) {
      if (gen !== this.gen) return
      let m: IrcMessage
      try {
        m = parseLine(line, LINK_LIMITS)
      } catch (e) {
        this.log("warn", `ignoring unparseable server line: ${(e as Error).message}`)
        continue
      }
      this.handleLine(gen, m)
    }
    if (gen === this.gen && this.splitter.pending.length > MAX_PENDING_BYTES) {
      this.log("error", "server line too long; dropping connection")
      this.handleClose(gen, new Error("line too long"))
    }
  }

  private handleLine(gen: number, m: IrcMessage): void {
    if (m.command === "PING") {
      try {
        this.writeMsg(msg("PONG", [m.params[0] ?? ""]))
      } catch (e) {
        this.log("warn", `pong failed: ${(e as Error).message}`)
      }
    }
    if (m.command === "ERROR") {
      this.log("warn", `server sent ERROR: ${m.params[0] ?? ""}`)
      this.handleClose(gen, new Error(`server error: ${m.params[0] ?? ""}`))
      return
    }
    if (this.phase === "handshake") {
      if (m.command === "LINKED") {
        this.phase = "linked"
        this._state = "linked"
        this.log("info", `linked to ${m.params[1] ?? "server"}`)
        this.emit("linked")
        void this.sendBurst(gen)
      } else if (m.command !== "PING" && m.command !== "PONG") {
        this.log("warn", `unexpected line before LINKED: ${m.command}`)
      }
      return
    }

    const label = getTag(m, "label")
    if (label !== undefined) this.pending.get(label)?.onOuter?.(m)
    if (m.command === "DELIVER") this.handleDeliver(m)
    if (gen !== this.gen) return

    if (m.command === "BURST") {
      this.serverBurstSeen = true
    } else if (m.command === "ENDBURST" && this._state === "linked" && this.serverBurstSeen) {
      this.establish()
    }
    this.emit("line", m)
  }

  private handleDeliver(outer: IrcMessage): void {
    const account = outer.params[0]
    const raw = outer.params[1]
    if (account === undefined || raw === undefined) {
      this.log("warn", "ignoring malformed DELIVER")
      return
    }
    let inner: IrcMessage
    try {
      inner = parseLine(raw, LINK_LIMITS)
    } catch (e) {
      this.log("warn", `ignoring unparseable inner line: ${(e as Error).message}`)
      return
    }
    for (const p of [...this.pending.values()]) p.onInner?.(account, inner)
    this.emit("deliver", account, inner, outer)
  }

  private establish(): void {
    this._state = "established"
    this.attempt = 0
    this.log("info", "link established")
    for (const w of [...this.waiters]) w(true)
    this.emit("established")
  }

  private async sendBurst(gen: number): Promise<void> {
    try {
      const lines = await this.opts.burst()
      if (gen !== this.gen) return
      this.writeMsg(msg("BURST"))
      for (const l of lines) this.writeMsg(l)
      this.writeMsg(msg("ENDBURST"))
    } catch (e) {
      this.log("error", `burst failed: ${(e as Error).message}`)
      this.handleClose(gen, e instanceof Error ? e : new Error(String(e)))
    }
  }

  // -------------------------------------------------------------- outbound

  private writeMsg(m: IrcMessage): void {
    if (!this.conn) throw new LinkDownError()
    const line = serializeLine(m)
    if (/[\r\n\0]/.test(line)) throw new Error("line contains a control character")
    this.conn.write(line + "\r\n")
  }

  send(m: IrcMessage): void {
    if (this._state !== "established") throw new LinkDownError()
    this.writeMsg(m)
  }

  private newLabel(prefix: string): string {
    this.labelSeq += 1
    return `${prefix}${this.labelSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }

  private track<T>(
    label: string,
    timeoutMs: number,
    make: (done: (v: T) => void, fail: (e: Error) => void) => Omit<Pending, "fail">,
    transmit: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer)
        this.pending.delete(label)
      }
      const timer = setTimeout(() => {
        finish()
        reject(new Error("timeout"))
      }, timeoutMs)
      const done = (v: T): void => {
        finish()
        resolve(v)
      }
      const fail = (e: Error): void => {
        finish()
        reject(e)
      }
      this.pending.set(label, { ...make(done, fail), fail })
      try {
        transmit()
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  request(m: IrcMessage, timeoutMs: number = this.requestTimeoutMs): Promise<IrcMessage> {
    const label = this.newLabel("o")
    const out = cloneMsg(m)
    setTag(out, "label", label)
    return this.track<IrcMessage>(
      label,
      timeoutMs,
      (done) => ({ onOuter: (reply) => done(reply) }),
      () => this.send(out),
    )
  }

  query(account: string, inner: IrcMessage, timeoutMs: number = this.requestTimeoutMs): Promise<IrcMessage[]> {
    const outerLabel = this.newLabel("o")
    const innerLabel = this.newLabel("q")
    const innerOut = cloneMsg(inner)
    setTag(innerOut, "label", innerLabel)
    const line = msg("SEND", [account, serializeLine(innerOut)], { tags: [["label", outerLabel]] })
    return this.track<IrcMessage[]>(
      outerLabel,
      timeoutMs,
      (done, fail) => {
        let batchId: string | null = null
        const collected: IrcMessage[] = []
        return {
          onOuter: (m) => {
            if (m.command === "FAIL" || m.command === "SENDFAIL") fail(new Error(describeFail(m)))
          },
          onInner: (acct, m) => {
            if (acct !== account) return
            if (batchId !== null) {
              if (m.command === "BATCH" && m.params[0] === `-${batchId}`) {
                done(collected)
              } else if (getTag(m, "batch") === batchId) {
                collected.push(m)
              }
              return
            }
            if (getTag(m, "label") !== innerLabel) return
            const first = m.params[0] ?? ""
            if (m.command === "BATCH" && first.startsWith("+")) {
              batchId = first.slice(1)
              return
            }
            if (m.command === "ACK") {
              done([])
              return
            }
            m.tags = m.tags.filter((t) => t[0] !== "label")
            done([m])
          },
        }
      },
      () => this.send(line),
    )
  }

  /** Send a PRIVMSG, NOTICE, or TAGMSG as `account`. Rejects with LinkDownError or Error("timeout"). */
  sendAs(account: string, inner: IrcMessage, opts: { timeoutMs?: number } = {}): Promise<SendResult> {
    const label = this.newLabel("o")
    const line = msg("SEND", [account, serializeLine(inner)], { tags: [["label", label]] })
    return this.track<SendResult>(
      label,
      opts.timeoutMs ?? this.requestTimeoutMs,
      (done) => ({ onOuter: (m) => done(mapSendReply(m)) }),
      () => this.send(line),
    )
  }

  /** Send one message with several lines as a draft/multiline batch. One line is a plain PRIVMSG. */
  sendMultiline(account: string, target: string, lines: string[], tags: Tags): Promise<SendResult> {
    const clientTags = (): Tags => tags.map(([k, v]) => [k, v] as [string, string | null])
    if (lines.length <= 1) {
      return this.sendAs(account, msg("PRIVMSG", [target, lines[0] ?? ""], { tags: clientTags() }))
    }
    const id = this.newLabel("b")
    const label = this.newLabel("o")
    const wrap = (inner: IrcMessage, outerTags: Tags = []): IrcMessage =>
      msg("SEND", [account, serializeLine(inner)], { tags: outerTags })
    return this.track<SendResult>(
      label,
      this.requestTimeoutMs,
      (done) => ({ onOuter: (m) => done(mapSendReply(m)) }),
      () => {
        if (this._state !== "established") throw new LinkDownError()
        // Serialize everything first so a bad line writes nothing.
        const out: IrcMessage[] = [wrap(msg("BATCH", [`+${id}`, "draft/multiline", target]))]
        lines.forEach((text, i) => {
          const lineTags: Tags = [["batch", id], ...(i === 0 ? clientTags() : [])]
          out.push(wrap(msg("PRIVMSG", [target, text], { tags: lineTags })))
        })
        out.push(wrap(msg("BATCH", [`-${id}`]), [["label", label]]))
        for (const m of out) {
          if (/[\r\n\0]/.test(serializeLine(m))) throw new Error("line contains a control character")
        }
        for (const m of out) this.writeMsg(m)
      },
    )
  }
}
