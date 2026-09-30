import { afterEach, describe, expect, test } from "bun:test"
import { LinkClient, backoffDelay } from "../src/link.ts"
import type { ConnectFn, LinkConn, LinkClientOptions, LogLevel } from "../src/link.ts"
import type { IrcMessage } from "../src/proto.ts"
import { getTag, msg, parseLine } from "../src/proto.ts"
import { LinkDownError } from "../src/types.ts"

const TOKEN = "s3cr3t-token-value"

class FakeConn implements LinkConn {
  closed = false
  private dataCb: ((c: string) => void) | null = null
  private closeCb: ((err?: Error) => void) | null = null

  constructor(private readonly server: FakeServer) {}

  write(s: string): void {
    if (this.closed) return
    this.server.receive(this, s)
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    this.closeCb?.()
  }

  onData(cb: (chunk: string) => void): void {
    this.dataCb = cb
  }

  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb
  }

  /** Server sends one line. */
  push(line: string): void {
    if (this.closed) return
    this.dataCb?.(line + "\r\n")
  }

  /** Server closes the connection. */
  drop(err?: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeCb?.(err)
  }
}

type Handler = (m: IrcMessage, raw: string, conn: FakeConn) => void

class FakeServer {
  conns: FakeConn[] = []
  lines: string[] = []
  attempts = 0
  refuse = 0
  handlers: Handler[] = []

  connect: ConnectFn = async () => {
    this.attempts += 1
    if (this.refuse > 0) {
      this.refuse -= 1
      throw new Error("connection refused")
    }
    const c = new FakeConn(this)
    this.conns.push(c)
    return c
  }

  constructor(opts: { autoLink?: boolean; autoBurst?: boolean } = {}) {
    if (opts.autoLink !== false) {
      this.on("LINK", (_m, _raw, conn) => conn.push("LINKED 1 irc.test"))
    }
    if (opts.autoBurst !== false) {
      this.on("ENDBURST", (_m, _raw, conn) => {
        conn.push("BURST")
        conn.push("ENDBURST")
      })
    }
  }

  on(command: string, fn: Handler): void {
    this.handlers.push((m, raw, conn) => {
      if (m.command === command) fn(m, raw, conn)
    })
  }

  receive(conn: FakeConn, data: string): void {
    for (const raw of data.split("\r\n")) {
      if (raw === "") continue
      this.lines.push(raw)
      const m = parseLine(raw)
      for (const h of this.handlers) h(m, raw, conn)
    }
  }

  get last(): FakeConn {
    const c = this.conns[this.conns.length - 1]
    if (!c) throw new Error("no connection")
    return c
  }
}

interface LogEntry {
  level: LogLevel
  msg: string
  extra?: object
}

const clients: LinkClient[] = []

function makeClient(
  server: FakeServer,
  over: Partial<LinkClientOptions> = {},
): { link: LinkClient; logs: LogEntry[] } {
  const logs: LogEntry[] = []
  const link = new LinkClient({
    host: "h",
    port: 1,
    tls: false,
    tlsCaPath: null,
    linkName: "svc-a.prj-b",
    token: async () => TOKEN,
    backoffMaxMs: 20,
    requestTimeoutMs: 500,
    burst: () => [msg("INTRODUCE", ["ses_1", "nick", "*", "operator", "agent", "proj", "Fix auth bug"])],
    log: (level, m, extra) => {
      logs.push(extra === undefined ? { level, msg: m } : { level, msg: m, extra })
    },
    connect: server.connect,
    ...over,
  })
  clients.push(link)
  return { link, logs }
}

async function establish(link: LinkClient): Promise<void> {
  await link.start()
  expect(await link.waitConnected(1000)).toBe(true)
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 2))
  }
}

afterEach(() => {
  for (const c of clients.splice(0)) c.stop()
})

/** Reply helper: parse a received SEND line into outer label, account and inner message. */
function parseSend(m: IrcMessage): { label: string; account: string; inner: IrcMessage } {
  return {
    label: getTag(m, "label") ?? "",
    account: m.params[0] ?? "",
    inner: parseLine(m.params[1] ?? ""),
  }
}

describe("handshake and burst", () => {
  test("sends LINK, BURST, burst lines, ENDBURST in order; established after server ENDBURST", async () => {
    const server = new FakeServer({ autoBurst: false })
    const { link } = makeClient(server)
    const events: string[] = []
    link.on("linked", () => events.push("linked"))
    link.on("established", () => events.push("established"))
    await link.start()
    await waitFor(() => server.lines.includes("ENDBURST"))
    expect(server.lines).toEqual([
      `LINK 1 svc-a.prj-b ${TOKEN}`,
      "BURST",
      "INTRODUCE ses_1 nick * operator agent proj :Fix auth bug",
      "ENDBURST",
    ])
    expect(link.state).toBe("linked")
    expect(link.connected).toBe(false)
    server.last.push("BURST")
    expect(link.state).toBe("linked")
    server.last.push("ENDBURST")
    expect(link.state).toBe("established")
    expect(link.connected).toBe(true)
    expect(events).toEqual(["linked", "established"])
  })

  test("server burst lines are emitted like live lines before established", async () => {
    const server = new FakeServer({ autoBurst: false })
    server.on("ENDBURST", (_m, _raw, conn) => {
      conn.push("BURST")
      conn.push("CLAIMSET ses_9 docs-bot 1790676200 1790676800 :/a b.md")
      conn.push("BATCH +r1 agent-comms.local/replay")
      conn.push(
        "@batch=r1 DELIVER ses_1 :@msgid=m1;time=2026-09-29T10:00:00.000Z :bob!ses_9@agent-comms.local PRIVMSG nick :hello there",
      )
      conn.push("BATCH -r1")
      conn.push("ENDBURST")
    })
    const { link } = makeClient(server)
    const seen: string[] = []
    const delivered: Array<{ account: string; inner: IrcMessage; outer: IrcMessage }> = []
    link.on("line", (m) => seen.push(m.command))
    link.on("deliver", (account, inner, outer) => delivered.push({ account, inner, outer }))
    link.on("established", () => seen.push("<established>"))
    await establish(link)
    expect(seen.slice(0, 5)).toEqual(["BURST", "CLAIMSET", "BATCH", "DELIVER", "BATCH"])
    expect(seen.indexOf("<established>")).toBeGreaterThan(seen.indexOf("DELIVER"))
    expect(delivered.length).toBe(1)
    const d = delivered[0]
    expect(d?.account).toBe("ses_1")
    expect(d?.inner.command).toBe("PRIVMSG")
    expect(d?.inner.params).toEqual(["nick", "hello there"])
    expect(getTag(d?.outer as IrcMessage, "batch")).toBe("r1")
  })

  test("token never reaches the log, also on a rejected handshake", async () => {
    const server = new FakeServer()
    server.handlers = []
    server.on("LINK", (_m, _raw, conn) => {
      conn.push("ERROR :bad credential")
    })
    const { link, logs } = makeClient(server)
    await link.start()
    await waitFor(() => server.attempts >= 2)
    expect(link.connected).toBe(false)
    expect(logs.some((l) => l.msg.includes("bad credential"))).toBe(true)
    expect(JSON.stringify(logs)).not.toContain(TOKEN)
  })

  test("token never reaches the log on a successful run", async () => {
    const server = new FakeServer()
    const { link, logs } = makeClient(server)
    await establish(link)
    link.stop()
    expect(logs.length).toBeGreaterThan(0)
    expect(JSON.stringify(logs)).not.toContain(TOKEN)
  })

  test("unparseable server lines are logged and ignored", async () => {
    const server = new FakeServer()
    const { link, logs } = makeClient(server)
    await establish(link)
    server.last.push("!!! not a command")
    expect(link.connected).toBe(true)
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("unparseable"))).toBe(true)
  })

  test("DISOWN is emitted as a normal line and listeners can unsubscribe", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server)
    await establish(link)
    const seen: string[] = []
    const off = link.on("line", (m) => seen.push(`${m.command} ${m.params[0] ?? ""}`))
    server.last.push("DISOWN ses_1")
    off()
    server.last.push("DISOWN ses_2")
    expect(seen).toEqual(["DISOWN ses_1"])
  })
})

describe("requests", () => {
  test("send throws LinkDownError unless established", async () => {
    const server = new FakeServer({ autoBurst: false })
    const { link } = makeClient(server)
    expect(() => link.send(msg("STATE", ["ses_1", "busy"]))).toThrow(LinkDownError)
    await link.start()
    await waitFor(() => link.state === "linked")
    expect(() => link.send(msg("STATE", ["ses_1", "busy"]))).toThrow(LinkDownError)
    await expect(link.request(msg("STATE", ["ses_1", "busy"]))).rejects.toBeInstanceOf(LinkDownError)
    server.last.push("BURST")
    server.last.push("ENDBURST")
    link.send(msg("STATE", ["ses_1", "busy"]))
    expect(server.lines[server.lines.length - 1]).toBe("STATE ses_1 busy")
  })

  test("send rejects lines with control characters", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server)
    await establish(link)
    expect(() => link.send(msg("PRIVMSG", ["x", "a\nb"]))).toThrow()
    expect(server.lines.some((l) => l.includes("PRIVMSG"))).toBe(false)
  })

  test("request correlates by label, also out of order", async () => {
    const server = new FakeServer()
    const held: Array<{ label: string; account: string }> = []
    server.on("STATE", (m) => held.push({ label: getTag(m, "label") ?? "", account: m.params[0] ?? "" }))
    const { link } = makeClient(server)
    await establish(link)
    const p1 = link.request(msg("STATE", ["ses_1", "busy"]))
    const p2 = link.request(msg("STATE", ["ses_2", "busy"]))
    expect(held.length).toBe(2)
    const [h1, h2] = held
    expect(h1?.label).not.toBe(h2?.label)
    expect(/^[A-Za-z0-9]+$/.test(h1?.label ?? "")).toBe(true)
    server.last.push(`@label=${h2?.label} FAIL STATE UNKNOWN_ACCOUNT ses_2 :No such account`)
    server.last.push(`@label=${h1?.label} CLAIMSET ses_1 nick 1 2 /p`)
    const r2 = await p2
    const r1 = await p1
    expect(r2.command).toBe("FAIL")
    expect(r1.command).toBe("CLAIMSET")
  })

  test("request does not mutate the caller's message", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server)
    await establish(link)
    const m = msg("STATE", ["ses_1", "busy"])
    const p = link.request(m, 20)
    await expect(p).rejects.toThrow("timeout")
    expect(m.tags).toEqual([])
  })

  test("request times out", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server)
    await establish(link)
    let err: unknown
    try {
      await link.request(msg("STATE", ["ses_1", "busy"]), 30)
    } catch (e) {
      err = e
    }
    expect((err as Error).message).toBe("timeout")
    expect(err).not.toBeInstanceOf(LinkDownError)
  })

  test("pending requests and queries are rejected with LinkDownError on disconnect", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server, { backoffMaxMs: 1000 })
    await establish(link)
    let downs = 0
    link.on("down", () => (downs += 1))
    const p1 = link.request(msg("STATE", ["ses_1", "busy"]), 5000)
    const p2 = link.query("ses_1", msg("NAMES", ["#c"]), 5000)
    const p3 = link.sendAs("ses_1", msg("PRIVMSG", ["#c", "hi"]), { timeoutMs: 5000 })
    const c = server.last
    c.drop(new Error("reset"))
    const results = await Promise.allSettled([p1, p2, p3])
    for (const r of results) {
      expect(r.status).toBe("rejected")
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(LinkDownError)
    }
    expect(link.state).toBe("down")
    expect(link.connected).toBe(false)
    expect(downs).toBe(1)
  })
})

describe("query", () => {
  test("collects a labeled-response batch without the BATCH lines", async () => {
    const server = new FakeServer()
    let outerLabel = ""
    let innerLabel = ""
    server.on("SEND", (m, _raw, conn) => {
      const s = parseSend(m)
      outerLabel = s.label
      innerLabel = getTag(s.inner, "label") ?? ""
      const d = (line: string): void => conn.push(`DELIVER ${s.account} :${line}`)
      d(`@label=${innerLabel} BATCH +x1 labeled-response`)
      d("@batch=x1 :srv 353 nick = #c :a b")
      d(":other!ses_9@agent-comms.local PRIVMSG nick :interleaved")
      d("@batch=x1 :srv 366 nick #c :End of NAMES")
      d("BATCH -x1")
    })
    const { link } = makeClient(server)
    await establish(link)
    const seen: string[] = []
    link.on("deliver", (_a, inner) => seen.push(inner.command))
    const res = await link.query("ses_1", msg("NAMES", ["#c"]))
    expect(res.map((r) => r.command)).toEqual(["353", "366"])
    expect(res[0]?.params).toEqual(["nick", "=", "#c", "a b"])
    expect(seen).toEqual(["BATCH", "353", "PRIVMSG", "366", "BATCH"])
    expect(outerLabel).not.toBe("")
    expect(innerLabel).not.toBe("")
    expect(outerLabel).not.toBe(innerLabel)
    const sent = server.lines.find((l) => l.includes("SEND ses_1"))
    expect(sent).toContain("NAMES #c")
  })

  test("a single labeled line resolves with that line, label stripped", async () => {
    const server = new FakeServer()
    server.on("SEND", (m, _raw, conn) => {
      const s = parseSend(m)
      conn.push(`DELIVER ${s.account} :@label=${getTag(s.inner, "label")} :srv 331 nick #c :No topic is set`)
    })
    const { link } = makeClient(server)
    await establish(link)
    const res = await link.query("ses_1", msg("TOPIC", ["#c"]))
    expect(res.length).toBe(1)
    expect(res[0]?.command).toBe("331")
    expect(getTag(res[0] as IrcMessage, "label")).toBeUndefined()
  })

  test("an inner ACK resolves with an empty list", async () => {
    const server = new FakeServer()
    server.on("SEND", (m, _raw, conn) => {
      const s = parseSend(m)
      conn.push(`DELIVER ${s.account} :@label=${getTag(s.inner, "label")} ACK`)
    })
    const { link } = makeClient(server)
    await establish(link)
    expect(await link.query("ses_1", msg("PART", ["#c"]))).toEqual([])
  })

  test("an outer FAIL SEND rejects", async () => {
    const server = new FakeServer()
    server.on("SEND", (m, _raw, conn) => {
      const s = parseSend(m)
      conn.push(`@label=${s.label} FAIL SEND UNKNOWN_ACCOUNT ${s.account} :No such account on this link`)
    })
    const { link } = makeClient(server)
    await establish(link)
    await expect(link.query("ses_x", msg("NAMES", ["#c"]))).rejects.toThrow("UNKNOWN_ACCOUNT")
  })

  test("replies for another account or label are ignored; query times out", async () => {
    const server = new FakeServer()
    server.on("SEND", (m, _raw, conn) => {
      const s = parseSend(m)
      conn.push(`DELIVER ses_other :@label=${getTag(s.inner, "label")} ACK`)
      conn.push(`DELIVER ${s.account} :@label=nomatch ACK`)
    })
    const { link } = makeClient(server)
    await establish(link)
    await expect(link.query("ses_1", msg("PART", ["#c"]), 40)).rejects.toThrow("timeout")
  })
})

describe("sendAs and sendMultiline", () => {
  test("maps SENT", async () => {
    const server = new FakeServer()
    let raw = ""
    server.on("SEND", (m, r, conn) => {
      raw = r
      const s = parseSend(m)
      conn.push(`@label=${s.label} SENT ${s.account} msg-0002`)
    })
    const { link } = makeClient(server)
    await establish(link)
    const res = await link.sendAs(
      "ses_1",
      msg("PRIVMSG", ["docs-bot", "Sure, I will"], { tags: [["+agent-comms.local/hop", "1"]] }),
    )
    expect(res).toEqual({ ok: true, msgid: "msg-0002" })
    expect(raw).toContain("SEND ses_1 :@+agent-comms.local/hop=1 PRIVMSG docs-bot :Sure, I will")
  })

  test("maps SENDFAIL", async () => {
    const server = new FakeServer()
    server.on("SEND", (m, _raw, conn) => {
      const s = parseSend(m)
      conn.push(`@label=${s.label} SENDFAIL ${s.account} NOSUCHNICK :No such nick`)
    })
    const { link } = makeClient(server)
    await establish(link)
    const res = await link.sendAs("ses_1", msg("PRIVMSG", ["nobody", "hi"]))
    expect(res).toEqual({ ok: false, code: "NOSUCHNICK", reason: "No such nick" })
  })

  test("maps FAIL SEND", async () => {
    const server = new FakeServer()
    server.on("SEND", (m, _raw, conn) => {
      const s = parseSend(m)
      conn.push(`@label=${s.label} FAIL SEND UNKNOWN_ACCOUNT ${s.account} :No such account`)
    })
    const { link } = makeClient(server)
    await establish(link)
    const res = await link.sendAs("ses_1", msg("PRIVMSG", ["x", "hi"]))
    expect(res).toEqual({ ok: false, code: "UNKNOWN_ACCOUNT", reason: "No such account" })
  })

  test("sendAs times out when the server is silent", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server)
    await establish(link)
    await expect(link.sendAs("ses_1", msg("PRIVMSG", ["x", "hi"]), { timeoutMs: 30 })).rejects.toThrow("timeout")
  })

  test("sendMultiline wraps lines in a batch and labels the closing line", async () => {
    const server = new FakeServer()
    const sends: Array<{ outer: IrcMessage; inner: IrcMessage }> = []
    server.on("SEND", (m, _raw, conn) => {
      const s = parseSend(m)
      sends.push({ outer: m, inner: s.inner })
      if (s.inner.command === "BATCH" && s.inner.params[0]?.startsWith("-")) {
        conn.push(`@label=${s.label} SENT ${s.account} msg-9`)
      }
    })
    const { link } = makeClient(server)
    await establish(link)
    const res = await link.sendMultiline("ses_1", "#proj", ["one", "two", "three"], [["+draft/reply", "m0"]])
    expect(res).toEqual({ ok: true, msgid: "msg-9" })
    expect(sends.length).toBe(5)
    const [open, l1, l2, l3, close] = sends
    const id = open?.inner.params[0]?.slice(1) ?? ""
    expect(id).not.toBe("")
    expect(open?.inner.command).toBe("BATCH")
    expect(open?.inner.params.slice(1)).toEqual(["draft/multiline", "#proj"])
    expect(l1?.inner.params).toEqual(["#proj", "one"])
    expect(getTag(l1?.inner as IrcMessage, "batch")).toBe(id)
    expect(getTag(l1?.inner as IrcMessage, "+draft/reply")).toBe("m0")
    expect(getTag(l2?.inner as IrcMessage, "batch")).toBe(id)
    expect(getTag(l2?.inner as IrcMessage, "+draft/reply")).toBeUndefined()
    expect(getTag(l2?.inner as IrcMessage, "draft/multiline-concat")).toBeUndefined()
    expect(l3?.inner.params).toEqual(["#proj", "three"])
    expect(close?.inner.params).toEqual([`-${id}`])
    expect(getTag(close?.outer as IrcMessage, "label")).toBeDefined()
    expect(getTag(open?.outer as IrcMessage, "label")).toBeUndefined()
  })

  test("sendMultiline with one line is a plain PRIVMSG", async () => {
    const server = new FakeServer()
    const inners: IrcMessage[] = []
    server.on("SEND", (m, _raw, conn) => {
      const s = parseSend(m)
      inners.push(s.inner)
      conn.push(`@label=${s.label} SENT ${s.account} msg-1`)
    })
    const { link } = makeClient(server)
    await establish(link)
    const res = await link.sendMultiline("ses_1", "#proj", ["only"], [])
    expect(res.ok).toBe(true)
    expect(inners.length).toBe(1)
    expect(inners[0]?.command).toBe("PRIVMSG")
    expect(inners[0]?.params).toEqual(["#proj", "only"])
  })
})

describe("reconnect and keepalive", () => {
  test("backoffDelay grows, is capped, and jitters by 20 percent", () => {
    expect(backoffDelay(0, 30_000, () => 0.5)).toBe(500)
    expect(backoffDelay(1, 30_000, () => 0.5)).toBe(1000)
    expect(backoffDelay(2, 30_000, () => 0.5)).toBe(2000)
    expect(backoffDelay(10, 30_000, () => 0.5)).toBe(30_000)
    expect(backoffDelay(10, 30_000, () => 0)).toBe(24_000)
    expect(backoffDelay(10, 30_000, () => 1)).toBe(36_000)
    expect(backoffDelay(500, 30_000, () => 0.5)).toBe(30_000)
  })

  test("reconnects after a drop and re-runs the burst", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server)
    await establish(link)
    let downs = 0
    let ups = 0
    link.on("down", () => (downs += 1))
    link.on("established", () => (ups += 1))
    server.last.drop()
    expect(link.state).toBe("down")
    await waitFor(() => ups === 1)
    expect(downs).toBe(1)
    expect(server.attempts).toBe(2)
    expect(server.lines.filter((l) => l.startsWith("LINK ")).length).toBe(2)
    expect(server.lines.filter((l) => l === "ENDBURST").length).toBe(2)
  })

  test("retries after failed connects until the server is reachable", async () => {
    const server = new FakeServer()
    server.refuse = 2
    const { link } = makeClient(server)
    await link.start()
    expect(await link.waitConnected(2000)).toBe(true)
    expect(server.attempts).toBe(3)
  })

  test("a failing token read is retried", async () => {
    const server = new FakeServer()
    let calls = 0
    const { link, logs } = makeClient(server, {
      token: async () => {
        calls += 1
        if (calls === 1) throw new Error("missing token file; run agent-comms install")
        return TOKEN
      },
    })
    await link.start()
    expect(await link.waitConnected(2000)).toBe(true)
    expect(calls).toBe(2)
    expect(logs.some((l) => l.msg.includes("agent-comms install"))).toBe(true)
  })

  test("ERROR replaced closes and reconnects", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server)
    await establish(link)
    let ups = 0
    link.on("established", () => (ups += 1))
    server.last.push("ERROR replaced")
    expect(link.state).toBe("down")
    await waitFor(() => ups === 1)
    expect(server.attempts).toBe(2)
  })

  test("stop disables reconnect", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server)
    await establish(link)
    link.stop()
    expect(link.state).toBe("down")
    await new Promise((r) => setTimeout(r, 80))
    expect(server.attempts).toBe(1)
    expect(await link.waitConnected(10)).toBe(false)
  })

  test("waitConnected honours abort signals and timeouts", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server)
    expect(await link.waitConnected(20)).toBe(false)
    const ac = new AbortController()
    const p = link.waitConnected(5000, ac.signal)
    ac.abort()
    expect(await p).toBe(false)
  })

  test("answers PING with PONG", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server)
    await establish(link)
    server.last.push("PING abc")
    expect(server.lines[server.lines.length - 1]).toBe("PONG abc")
    server.last.push("PING :two words")
    expect(server.lines[server.lines.length - 1]).toBe("PONG :two words")
  })

  test("sends its own PING after silence", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server, { pingAfterMs: 40, deadAfterMs: 5000 })
    await establish(link)
    await waitFor(() => server.lines.some((l) => l.startsWith("PING ")), 1000)
    expect(link.connected).toBe(true)
  })

  test("drops the connection after a long silence", async () => {
    const server = new FakeServer()
    const { link } = makeClient(server, { pingAfterMs: 20, deadAfterMs: 80 })
    await establish(link)
    let downs = 0
    link.on("down", () => (downs += 1))
    await waitFor(() => downs >= 1, 1000)
    expect(downs).toBeGreaterThanOrEqual(1)
  })
})
