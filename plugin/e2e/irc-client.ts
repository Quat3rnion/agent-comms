/**
 * Minimal operator IRC client for e2e tests.
 *
 * It connects over plain TCP, negotiates capabilities, logs in with SASL PLAIN
 * as the operator account, and records every line it receives. Tests use
 * `waitFor` to wait for a line and `privmsg`/`quote` to send lines.
 */
import { connect } from "node:net"
import type { Socket } from "node:net"
import { LINK_LIMITS, LineSplitter, getTag, msg, parseLine, serializeLine, sourceNick } from "../src/proto.ts"
import type { IrcMessage, Tags } from "../src/proto.ts"

export const OPERATOR_CAPS = [
  "message-tags",
  "server-time",
  "echo-message",
  "batch",
  "labeled-response",
  "away-notify",
] as const

export interface IrcClientOptions {
  host: string
  port: number
  /** SASL account name. Default: `operator`. */
  account?: string
  password: string
  /** IRC nick. Default: `operator`. */
  nick?: string
  /** Capabilities to request. Only the ones that the server offers are requested. */
  caps?: readonly string[]
  /** Time limit for the whole login. Default: 10000 ms. */
  timeoutMs?: number
}

export type LinePredicate = (line: IrcMessage) => boolean

export interface WaitOptions {
  /** Only look at lines with an index at or after this value (see `mark()`). Default: 0. */
  since?: number
}

interface Waiter {
  predicate: LinePredicate
  since: number
  resolve: (line: IrcMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class IrcClient {
  /** Every parsed line received, in order. */
  readonly lines: IrcMessage[] = []
  /** Raw text of every received line, same order as `lines` (parse errors are not included). */
  readonly raw: string[] = []
  readonly parseErrors: string[] = []
  readonly nick: string
  /** Capabilities that the server acknowledged. */
  readonly caps: string[] = []

  private readonly socket: Socket
  private readonly splitter = new LineSplitter()
  private readonly waiters: Waiter[] = []
  private closed = false

  private constructor(socket: Socket, nick: string) {
    this.socket = socket
    this.nick = nick
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      for (const text of this.splitter.push(chunk)) this.receive(text)
    })
    const onClose = (): void => {
      this.closed = true
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer)
        w.reject(new Error(`connection closed while waiting. Last lines:\n${this.tail()}`))
      }
    }
    socket.on("close", onClose)
    socket.on("error", () => {
      // The close event follows. Waiters reject there.
    })
  }

  /** Connect, negotiate capabilities, log in with SASL PLAIN, and wait for RPL_WELCOME (001). */
  static async connect(options: IrcClientOptions): Promise<IrcClient> {
    const socket = connect({ host: options.host, port: options.port })
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve())
      socket.once("error", reject)
    })
    const nick = options.nick ?? "operator"
    const client = new IrcClient(socket, nick)
    const timeoutMs = options.timeoutMs ?? 10_000
    const account = options.account ?? "operator"
    const wanted = options.caps ?? OPERATOR_CAPS

    client.send(msg("CAP", ["LS", "302"]))
    client.send(msg("NICK", [nick]))
    client.send(msg("USER", [account, "0", "*", "e2e operator"]))

    // CAP LS can span several lines. A `*` in params[2] means "more lines follow".
    const offered = new Set<string>()
    let seen = 0
    for (;;) {
      const line = await client.waitFor((l) => l.command === "CAP" && l.params[1] === "LS", timeoutMs, { since: seen })
      seen = client.lines.indexOf(line) + 1
      const more = line.params[2] === "*"
      const list = line.params[more ? 3 : 2] ?? ""
      for (const item of list.split(" ")) {
        if (item !== "") offered.add(item.split("=")[0] ?? item)
      }
      if (!more) break
    }
    if (!offered.has("sasl")) throw new Error("server does not offer the sasl capability")
    const request = [...wanted.filter((c) => offered.has(c)), "sasl"]
    client.send(msg("CAP", ["REQ", request.join(" ")]))
    const ack = await client.waitFor(
      (l) => l.command === "CAP" && (l.params[1] === "ACK" || l.params[1] === "NAK"),
      timeoutMs,
    )
    if (ack.params[1] === "NAK") throw new Error(`CAP REQ rejected: ${ack.params[2] ?? ""}`)
    client.caps.push(...(ack.params[2] ?? "").split(" ").filter((c) => c !== ""))

    client.send(msg("AUTHENTICATE", ["PLAIN"]))
    await client.waitFor((l) => l.command === "AUTHENTICATE" && l.params[0] === "+", timeoutMs)
    const payload = Buffer.from(`\0${account}\0${options.password}`, "utf8").toString("base64")
    for (let i = 0; i < payload.length; i += 400) client.send(msg("AUTHENTICATE", [payload.slice(i, i + 400)]))
    if (payload.length % 400 === 0) client.send(msg("AUTHENTICATE", ["+"]))
    const result = await client.waitFor((l) => l.command === "903" || l.command === "904" || l.command === "905", timeoutMs)
    if (result.command !== "903") throw new Error(`SASL failed: ${serializeLine(result)}`)

    client.send(msg("CAP", ["END"]))
    await client.waitFor((l) => l.command === "001", timeoutMs)
    return client
  }

  private receive(text: string): void {
    let line: IrcMessage
    try {
      line = parseLine(text, LINK_LIMITS)
    } catch (e) {
      this.parseErrors.push(`${text}: ${(e as Error).message}`)
      return
    }
    if (line.command === "PING") {
      this.send(msg("PONG", line.params))
    }
    this.lines.push(line)
    this.raw.push(text)
    const index = this.lines.length - 1
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]
      if (w !== undefined && index >= w.since && w.predicate(line)) {
        this.waiters.splice(i, 1)
        clearTimeout(w.timer)
        w.resolve(line)
      }
    }
  }

  private tail(count = 25): string {
    return this.raw.slice(-count).join("\n")
  }

  /** Index for `WaitOptions.since`: the number of lines received so far. */
  mark(): number {
    return this.lines.length
  }

  send(line: IrcMessage): void {
    if (this.closed) throw new Error("connection is closed")
    this.socket.write(`${serializeLine(line)}\r\n`)
  }

  /** Send a raw line, for example `quote("WHOIS bob")`. */
  quote(rawLine: string): void {
    if (this.closed) throw new Error("connection is closed")
    this.socket.write(`${rawLine}\r\n`)
  }

  join(channel: string): void {
    this.send(msg("JOIN", [channel]))
  }

  part(channel: string, reason?: string): void {
    this.send(msg("PART", reason === undefined ? [channel] : [channel, reason]))
  }

  privmsg(target: string, text: string, tags?: Tags): void {
    this.send(msg("PRIVMSG", [target, text], tags === undefined ? {} : { tags }))
  }

  /** Wait for a received line. Lines that arrived earlier count too, unless `since` is set. */
  waitFor(predicate: LinePredicate, timeoutMs = 10_000, options: WaitOptions = {}): Promise<IrcMessage> {
    const since = options.since ?? 0
    for (let i = since; i < this.lines.length; i++) {
      const line = this.lines[i]
      if (line !== undefined && predicate(line)) return Promise.resolve(line)
    }
    if (this.closed) return Promise.reject(new Error(`connection closed. Last lines:\n${this.tail()}`))
    return new Promise<IrcMessage>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        since,
        resolve,
        reject,
        timer: setTimeout(() => {
          const at = this.waiters.indexOf(waiter)
          if (at !== -1) this.waiters.splice(at, 1)
          reject(new Error(`timeout after ${timeoutMs} ms. Last lines:\n${this.tail()}`))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  /** Wait for a PRIVMSG or NOTICE to `target` whose text satisfies `match`. */
  waitForMessage(
    match: string | RegExp | ((text: string, line: IrcMessage) => boolean),
    timeoutMs = 10_000,
    options: WaitOptions & { target?: string; from?: string } = {},
  ): Promise<IrcMessage> {
    const test = (text: string, line: IrcMessage): boolean =>
      typeof match === "string" ? text.includes(match) : match instanceof RegExp ? match.test(text) : match(text, line)
    return this.waitFor(
      (l) =>
        (l.command === "PRIVMSG" || l.command === "NOTICE") &&
        (options.target === undefined || l.params[0] === options.target) &&
        (options.from === undefined || sourceNick(l) === options.from) &&
        test(l.params[1] ?? "", l),
      timeoutMs,
      options,
    )
  }

  /**
   * Wait until a nick that satisfies `match` is in `channel`. It looks at JOIN lines and
   * at NAMES replies (353). Returns the nick.
   */
  async waitForMember(
    channel: string,
    match: string | RegExp | ((nick: string) => boolean),
    timeoutMs = 10_000,
    options: WaitOptions = {},
  ): Promise<string> {
    const test = (nick: string): boolean =>
      typeof match === "string" ? nick === match : match instanceof RegExp ? match.test(nick) : match(nick)
    const found: { nick: string | null } = { nick: null }
    await this.waitFor(
      (l) => {
        if (l.command === "JOIN" && l.params[0]?.toLowerCase() === channel.toLowerCase()) {
          const n = sourceNick(l)
          if (n !== null && test(n)) {
            found.nick = n
            return true
          }
        }
        if (l.command === "353" && l.params[2]?.toLowerCase() === channel.toLowerCase()) {
          for (const raw of (l.params[3] ?? "").split(" ")) {
            const n = raw.replace(/^[~&@%+]+/, "")
            if (n !== "" && test(n)) {
              found.nick = n
              return true
            }
          }
        }
        return false
      },
      timeoutMs,
      options,
    )
    return found.nick ?? ""
  }

  /** Send NAMES for `channel` and return the nicks (without prefixes). */
  async names(channel: string, timeoutMs = 10_000): Promise<string[]> {
    const since = this.mark()
    this.send(msg("NAMES", [channel]))
    await this.waitFor((l) => l.command === "366" && l.params[1]?.toLowerCase() === channel.toLowerCase(), timeoutMs, {
      since,
    })
    return this.lines
      .slice(since)
      .filter((l) => l.command === "353" && l.params[2]?.toLowerCase() === channel.toLowerCase())
      .flatMap((l) => (l.params[3] ?? "").split(" "))
      .map((n) => n.replace(/^[~&@%+]+/, ""))
      .filter((n) => n !== "")
  }

  /** Read a message tag from a received line. */
  tag(line: IrcMessage, key: string): string | undefined {
    return getTag(line, key)
  }

  async close(): Promise<void> {
    if (this.closed) return
    try {
      this.socket.write("QUIT :bye\r\n")
    } catch {
      // ignore: the socket may be gone
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.destroy()
        resolve()
      }, 500)
      this.socket.once("close", () => {
        clearTimeout(timer)
        resolve()
      })
      this.socket.end()
    })
  }
}
