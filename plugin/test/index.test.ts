import { afterEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createRuntime, normalizeEvent } from "../src/index.ts"
import type { LinkLike, Runtime } from "../src/index.ts"
import type { IrcMessage, Tags } from "../src/proto.ts"
import { msg, vendorTag } from "../src/proto.ts"
import type { LinkState } from "../src/types.ts"
import { LinkDownError } from "../src/types.ts"

const DIR = "/work/webapp"
const NOW = 1_800_000_000_000
const TIME = "2026-09-29T10:00:00.000Z"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeLink {
  state: LinkState = "down"
  claimFail = false
  started = false
  stopped = false
  readonly sent: IrcMessage[] = []
  readonly requests: IrcMessage[] = []
  private readonly handlers = new Map<string, Set<(...a: unknown[]) => void>>()

  get connected(): boolean {
    return this.state === "established"
  }

  on(event: string, cb: (...a: never[]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set<(...a: unknown[]) => void>()
    this.handlers.set(event, set)
    const fn = cb as unknown as (...a: unknown[]) => void
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.handlers.get(event) ?? [])]) cb(...args)
  }

  async start(): Promise<void> {
    this.started = true
  }

  stop(): void {
    this.stopped = true
    this.state = "down"
  }

  send(m: IrcMessage): void {
    if (!this.connected) throw new LinkDownError()
    this.sent.push(m)
  }

  async request(m: IrcMessage): Promise<IrcMessage> {
    if (!this.connected) throw new LinkDownError()
    this.requests.push(m)
    const account = m.params[0] ?? ""
    switch (m.command) {
      case "INTRODUCE":
        return msg("INTRODUCED", [account, m.params[1] ?? ""])
      case "RENAME":
        return msg("RENAMED", [account, m.params[1] ?? ""])
      case "RETIRE":
        return msg("RETIRED", [account])
      case "CLAIM": {
        const path = m.params[1] ?? ""
        return this.claimFail
          ? msg("CLAIMFAIL", [account, "holder", "1", path])
          : msg("CLAIMSET", [account, "claimant", "1", "9999999999", path])
      }
      default:
        return msg("FAIL", [m.command, "UNKNOWN"])
    }
  }

  waitConnected(ms: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true)
    return new Promise((resolve) => setTimeout(() => resolve(this.connected), ms))
  }

  async query(): Promise<IrcMessage[]> {
    throw new Error("not implemented")
  }

  async sendAs(): Promise<never> {
    throw new Error("not implemented")
  }

  async sendMultiline(): Promise<never> {
    throw new Error("not implemented")
  }

  /** The server delivers an inner line to an account. */
  deliver(account: string, inner: IrcMessage, batch?: string): void {
    const tags: Tags = batch === undefined ? [] : [["batch", batch]]
    this.emit("deliver", account, inner, msg("DELIVER", [account, "raw"], { tags }))
  }

  establish(): void {
    this.state = "established"
    this.emit("established")
  }
}

class EventFeed {
  private items: Array<{ ev: unknown; done: () => void }> = []
  private waiting: ((r: IteratorResult<unknown>) => void) | null = null
  private current: (() => void) | null = null
  private closed = false

  /** Resolves when the runtime finished handling the event. */
  push(ev: unknown): Promise<void> {
    return new Promise<void>((done) => {
      const w = this.waiting
      if (w) {
        this.waiting = null
        this.current = done
        w({ done: false, value: ev })
      } else {
        this.items.push({ ev, done })
      }
    })
  }

  stream(signal?: AbortSignal): AsyncIterable<unknown> {
    signal?.addEventListener(
      "abort",
      () => {
        this.closed = true
        const w = this.waiting
        this.waiting = null
        w?.({ done: true, value: undefined })
      },
      { once: true },
    )
    const next = (): Promise<IteratorResult<unknown>> => {
      this.current?.()
      this.current = null
      if (this.closed) return Promise.resolve({ done: true, value: undefined })
      const item = this.items.shift()
      if (item) {
        this.current = item.done
        return Promise.resolve({ done: false, value: item.ev })
      }
      return new Promise((resolve) => {
        this.waiting = resolve
      })
    }
    return { [Symbol.asyncIterator]: () => ({ next }) }
  }
}

type Hook = (ev: unknown) => unknown
type Command = { execute: (input: unknown) => Promise<void> }

interface Harness {
  ctx: Plugin.Context
  events: EventFeed
  prompts: Array<Record<string, unknown>>
  synthetics: Array<Record<string, unknown>>
  interrupts: Array<Record<string, unknown>>
  storage: Map<string, unknown>
  sessions: Record<string, unknown>
  commands: Map<string, Command>
  hooks: { context: Hook[]; prompt: Hook[]; evaluate: Hook[]; toolAfter: Hook[] }
}

function info(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, agent: "build", location: { directory: DIR }, time: { created: 0, updated: 0 }, ...over }
}

function makeCtx(options: Record<string, unknown>, sessions: Record<string, unknown>): Harness {
  const events = new EventFeed()
  const prompts: Array<Record<string, unknown>> = []
  const synthetics: Array<Record<string, unknown>> = []
  const interrupts: Array<Record<string, unknown>> = []
  const storage = new Map<string, unknown>()
  const commands = new Map<string, Command>()
  const hooks = { context: [] as Hook[], prompt: [] as Hook[], evaluate: [] as Hook[], toolAfter: [] as Hook[] }
  const reg = { dispose: async () => {} }

  const ctx = {
    options,
    location: { directory: DIR, project: { id: "prj1", directory: DIR, canonical: DIR } },
    storage: {
      get: async (k: string) => storage.get(k),
      set: async (k: string, v: unknown) => {
        storage.set(k, v)
      },
      remove: async (k: string) => {
        storage.delete(k)
      },
      scan: async (o: { prefix: string }) => ({
        entries: [...storage.entries()].filter(([k]) => k.startsWith(o.prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    event: { subscribe: (o?: { signal?: AbortSignal }) => events.stream(o?.signal) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const s = sessions[sessionID]
        if (s === undefined) throw new Error("no such session")
        return s
      },
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return {}
      },
      synthetic: async (input: Record<string, unknown>) => {
        synthetics.push(input)
        return {}
      },
      interrupt: async (input: Record<string, unknown>) => {
        interrupts.push(input)
        return { interrupted: true }
      },
      hook: async (name: "context" | "prompt", cb: Hook) => {
        hooks[name].push(cb)
        return reg
      },
    },
    permission: {
      hook: async (_name: "evaluate", cb: Hook) => {
        hooks.evaluate.push(cb)
        return reg
      },
    },
    tool: {
      hook: async (_name: "execute.after", cb: Hook) => {
        hooks.toolAfter.push(cb)
        return reg
      },
    },
    command: {
      transform: async (cb: (editor: { add(def: { name: string; execute: Command["execute"] }): void }) => void) => {
        cb({ add: (def) => commands.set(def.name, def) })
        return reg
      },
    },
  } as unknown as Plugin.Context

  return { ctx, events, prompts, synthetics, interrupts, storage, sessions, commands, hooks }
}

const live: Runtime[] = []

afterEach(async () => {
  for (const rt of live.splice(0)) await rt.dispose()
})

async function boot(
  o: {
    options?: Record<string, unknown>
    connected?: boolean
    sessions?: Record<string, unknown>
    realpath?: (p: string) => string | null
  } = {},
) {
  const link = new FakeLink()
  if (o.connected !== false) link.state = "established"
  const h = makeCtx(o.options ?? {}, o.sessions ?? {})
  const rt = await createRuntime(h.ctx, {
    link: link as unknown as LinkLike,
    now: () => NOW,
    log: () => {},
    realpath: o.realpath ?? (() => null),
    registerTools: async () => ({ dispose: async () => {} }),
  })
  if (rt === null) throw new Error("runtime is disabled")
  live.push(rt)
  return { rt, link, h }
}

const created = (id: string, over: Record<string, unknown> = {}) => ({
  type: "session.created",
  data: { sessionID: id, projectID: "prj1", location: { directory: DIR }, slug: "s", version: "1", agent: "build", ...over },
})
const renamed = (id: string, title: string) => ({ type: "session.renamed", data: { sessionID: id, title } })
const status = (id: string, type: "busy" | "idle") => ({
  type: "session.status",
  data: { sessionID: id, status: { type } },
})
const deleted = (id: string) => ({ type: "session.deleted", data: { sessionID: id } })

let seq = 0
function priv(
  o: Partial<{
    text: string
    target: string
    senderNick: string
    senderAccount: string
    role: string
    rel: string
    hop: number
    msgid: string
    replyTo: string | null
  }> = {},
): IrcMessage {
  const p = {
    text: "hello",
    target: "fix-auth",
    senderNick: "bob",
    senderAccount: "ses_x",
    role: "agent",
    rel: "peer",
    hop: 0,
    msgid: `m${++seq}`,
    replyTo: null as string | null,
    ...o,
  }
  const tags: Tags = [
    ["msgid", p.msgid],
    ["time", TIME],
    ["account", p.senderAccount],
    [vendorTag("role"), p.role],
    [vendorTag("rel"), p.rel],
  ]
  if (p.hop > 0) tags.push(["+" + vendorTag("hop"), String(p.hop)])
  if (p.replyTo !== null) tags.push(["+draft/reply", p.replyTo])
  return msg("PRIVMSG", [p.target, p.text], { tags, source: `${p.senderNick}!${p.senderAccount}@agent-comms.local` })
}

const byCommand = (lines: IrcMessage[], command: string): string[][] =>
  lines.filter((m) => m.command === command).map((m) => m.params)

/** A session with a title, so its nick is "fix-auth". */
async function bootWithSession(o: Parameters<typeof boot>[0] = {}) {
  const b = await boot({ sessions: { ses_a: info("ses_a") }, ...o })
  await b.h.events.push(created("ses_a", { title: "Fix auth" }))
  await b.rt.settle()
  return b
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("event normalisation", () => {
  test("reads the fields that the plugin needs", () => {
    expect(normalizeEvent(created("s1", { parentID: "s0", title: "T" }))).toEqual({
      kind: "created",
      sessionID: "s1",
      parentID: "s0",
      title: "T",
      agent: "build",
      directory: DIR,
    })
    expect(normalizeEvent(status("s1", "busy"))).toEqual({ kind: "status", sessionID: "s1", busy: true })
    expect(normalizeEvent({ type: "session.status", data: { sessionID: "s1", status: { type: "retry" } } })).toEqual({
      kind: "status",
      sessionID: "s1",
      busy: true,
    })
    expect(normalizeEvent({ type: "session.idle", data: { sessionID: "s1" } })).toEqual({ kind: "idle", sessionID: "s1" })
    expect(normalizeEvent({ type: "other", data: {} })).toBeNull()
    expect(normalizeEvent("junk")).toBeNull()
  })
})

describe("session lifecycle", () => {
  test("disabled option does nothing", async () => {
    const h = makeCtx({ enabled: false }, {})
    const rt = await createRuntime(h.ctx, { link: new FakeLink() as unknown as LinkLike, log: () => {} })
    expect(rt).toBeNull()
    expect(h.hooks.context).toHaveLength(0)
  })

  test("created session sends INTRODUCE and starts the link", async () => {
    const { rt, link, h } = await boot()
    expect(link.started).toBe(true)
    await h.events.push(created("ses_a"))
    await rt.settle()
    expect(byCommand(link.requests, "INTRODUCE")).toEqual([
      ["ses_a", "build-sesa", "*", "operator", "agent", "webapp", ""],
    ])
    const r = rt.registry.get("ses_a")
    expect(r?.provisional).toBe(true)
    expect(r?.channels).toEqual(["#lobby", "#webapp"])
  })

  test("a title at creation gives a final nick", async () => {
    const { rt, link } = await bootWithSession()
    expect(byCommand(link.requests, "INTRODUCE")[0]?.[1]).toBe("fix-auth")
    expect(rt.registry.get("ses_a")?.provisional).toBe(false)
    await rt.registry.flush()
  })

  test("child sessions get parent|base nicks and the family channel", async () => {
    const { rt, link, h } = await boot()
    await h.events.push(created("ses_a"))
    await h.events.push(created("ses_b", { parentID: "ses_a", agent: "explore" }))
    await h.events.push(created("ses_c", { parentID: "ses_a", agent: "explore" }))
    await rt.settle()
    const intros = byCommand(link.requests, "INTRODUCE")
    expect(intros[1]).toEqual(["ses_b", "build-sesa|explore1", "ses_a", "operator", "agent", "webapp", ""])
    expect(intros[2]?.[1]).toBe("build-sesa|explore2")
    expect(rt.registry.get("ses_b")?.channels).toContain("#build-sesa")
    expect(rt.registry.get("ses_a")?.channels).toContain("#build-sesa")
    expect(rt.registry.get("ses_b")?.provisional).toBe(true)
  })

  test("the title renames a provisional nick once, with the children", async () => {
    const { rt, link, h } = await boot()
    await h.events.push(created("ses_a"))
    await h.events.push(created("ses_b", { parentID: "ses_a", agent: "explore" }))
    await rt.settle()
    await h.events.push(renamed("ses_a", "Fix Auth Bug"))
    await rt.settle()
    expect(byCommand(link.requests, "RENAME")).toEqual([
      ["ses_a", "fix-auth-bug"],
      ["ses_b", "fix-auth-bug|explore1"],
    ])
    const a = rt.registry.get("ses_a")
    expect(a?.nick).toBe("fix-auth-bug")
    expect(a?.provisional).toBe(false)
    expect(rt.registry.aliases("ses_a")).toContain("build-sesa")
    expect(rt.registry.get("ses_b")?.provisional).toBe(false)
    expect(rt.registry.get("ses_a")?.channels).toContain("#fix-auth-bug")

    await h.events.push(renamed("ses_a", "Something else entirely"))
    await rt.settle()
    expect(byCommand(link.requests, "RENAME")).toHaveLength(2)
    expect(rt.registry.get("ses_a")?.nick).toBe("fix-auth-bug")
    expect(rt.registry.get("ses_a")?.title).toBe("Something else entirely")
  })

  test("a title change while the link is down renames locally and the burst carries it", async () => {
    const { rt, link, h } = await boot({ connected: false })
    await h.events.push(created("ses_a"))
    await h.events.push(renamed("ses_a", "Fix auth"))
    await rt.settle()
    expect(link.requests).toHaveLength(0)
    expect(rt.registry.get("ses_a")?.nick).toBe("fix-auth")
    expect(byCommand(rt.burstLines(), "INTRODUCE")[0]?.[1]).toBe("fix-auth")
  })

  test("busy and idle send STATE and end the hop turn", async () => {
    const { rt, link, h } = await bootWithSession()
    await h.events.push(status("ses_a", "busy"))
    await rt.settle()
    expect(rt.registry.get("ses_a")?.busy).toBe(true)
    rt.hop.startTurn("ses_a", 2, false)
    await h.events.push(status("ses_a", "idle"))
    await rt.settle()
    expect(byCommand(link.sent, "STATE")).toEqual([
      ["ses_a", "busy"],
      ["ses_a", "idle"],
    ])
    expect(rt.hop.outgoingHop("ses_a")).toBe(1)
    // A repeated idle event sends nothing new.
    await h.events.push({ type: "session.idle", data: { sessionID: "ses_a" } })
    await rt.settle()
    expect(byCommand(link.sent, "STATE")).toHaveLength(2)
  })

  test("deleted session sends RETIRE and is removed", async () => {
    const { rt, link, h } = await bootWithSession()
    rt.claims.record("ses_a", "/work/webapp/a.ts")
    await h.events.push(deleted("ses_a"))
    await rt.settle()
    expect(byCommand(link.requests, "RETIRE")).toEqual([["ses_a", "session deleted"]])
    expect(rt.registry.get("ses_a")).toBeUndefined()
    expect(rt.claims.held("ses_a")).toEqual([])
  })

  test("an archived session is retired when it goes idle", async () => {
    const { rt, link, h } = await bootWithSession()
    h.sessions["ses_a"] = info("ses_a", { time: { created: 0, updated: 0, archived: 5 } })
    await h.events.push(status("ses_a", "idle"))
    await rt.settle()
    expect(byCommand(link.requests, "RETIRE")).toEqual([["ses_a", "session archived"]])
    expect(rt.registry.get("ses_a")).toBeUndefined()
  })

  test("a RETIRE that cannot be sent is repeated when the link is established", async () => {
    const { rt, link, h } = await boot({ connected: false })
    await h.events.push(created("ses_a"))
    await h.events.push(deleted("ses_a"))
    await rt.settle()
    expect(link.requests).toHaveLength(0)
    link.establish()
    await rt.settle()
    expect(byCommand(link.requests, "RETIRE")).toEqual([["ses_a", "session deleted"]])
  })

  test("sessions that were created while the link was down are introduced when it is established", async () => {
    const { rt, link, h } = await boot({ connected: false })
    await h.events.push(created("ses_a", { title: "Fix auth" }))
    await rt.settle()
    expect(link.requests).toHaveLength(0)
    link.establish()
    await rt.settle()
    expect(byCommand(link.requests, "INTRODUCE")).toHaveLength(1)
  })

  test("a session that moves to another directory is forgotten without RETIRE", async () => {
    const { rt, link, h } = await bootWithSession()
    await h.events.push({
      type: "session.moved",
      data: { sessionID: "ses_a", projectID: "p", location: { directory: "/other" } },
    })
    await rt.settle()
    expect(rt.registry.get("ses_a")).toBeUndefined()
    expect(byCommand(link.requests, "RETIRE")).toHaveLength(0)
  })

  test("DISOWN removes the record", async () => {
    const { rt, link } = await bootWithSession()
    link.emit("line", msg("DISOWN", ["ses_a"]))
    expect(rt.registry.get("ses_a")).toBeUndefined()
  })

  test("a session from another directory is ignored", async () => {
    const { rt, link, h } = await boot()
    await h.events.push({
      type: "session.created",
      data: { sessionID: "ses_o", location: { directory: "/other" }, agent: "build" },
    })
    await rt.settle()
    expect(rt.registry.all()).toHaveLength(0)
    expect(link.requests).toHaveLength(0)
  })

  test("excluded agents and their children are opted out and never introduced", async () => {
    const { rt, link, h } = await boot({ options: { excludeAgents: ["plan"] } })
    await h.events.push(created("ses_p", { agent: "plan" }))
    await h.events.push(created("ses_q", { agent: "build", parentID: "ses_p" }))
    await rt.settle()
    expect(rt.registry.get("ses_p")?.optedOut).toBe(true)
    expect(rt.registry.get("ses_q")?.optedOut).toBe(true)
    expect(link.requests).toHaveLength(0)
    expect(rt.burstLines()).toEqual([])
  })

  test("a session that the runtime has not seen is adopted from its first status event", async () => {
    const { rt, link, h } = await boot({ sessions: { ses_old: info("ses_old", { title: "Old work", agent: "build" }) } })
    await h.events.push(status("ses_old", "busy"))
    await rt.settle()
    expect(rt.registry.get("ses_old")?.nick).toBe("old-work")
    expect(byCommand(link.requests, "INTRODUCE")[0]?.[1]).toBe("old-work")
    expect(byCommand(link.sent, "STATE")).toEqual([["ses_old", "busy"]])
  })

  test("the registry is persisted in storage", async () => {
    const { rt, h } = await bootWithSession()
    await rt.registry.flush()
    expect(h.storage.has("session/ses_a")).toBe(true)
  })

  test("burst lists parents first, then STATE lines, then claims", async () => {
    const { rt, h } = await boot({ connected: false })
    // The child is stored first, so the burst has to reorder.
    rt.registry.put({
      sessionID: "ses_b",
      account: "ses_b",
      nick: "fix-auth|explore1",
      provisional: false,
      parentID: "ses_a",
      agent: "explore",
      title: "",
      project: "webapp",
      optedOut: false,
      busy: false,
      channels: [],
    })
    await h.events.push(created("ses_a", { title: "Fix auth" }))
    await rt.settle()
    await h.hooks.toolAfter[0]?.({
      tool: "edit",
      sessionID: "ses_a",
      status: "completed",
      input: { filePath: "src/a.ts" },
    })
    await rt.settle()
    const lines = rt.burstLines()
    expect(lines.map((l) => `${l.command} ${l.params[0]}`)).toEqual([
      "INTRODUCE ses_a",
      "INTRODUCE ses_b",
      "STATE ses_a",
      "STATE ses_b",
      "CLAIM ses_a",
    ])
    expect(lines[1]?.params[2]).toBe("ses_a")
    expect(lines[4]?.params[1]).toBe("/work/webapp/src/a.ts")
  })

  test("cleanup stops the link", async () => {
    const { rt, link } = await boot()
    await rt.dispose()
    expect(link.stopped).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Inbound delivery
// ---------------------------------------------------------------------------

describe("inbound delivery", () => {
  test("a DM to an idle session wakes it with the peer wrapper", async () => {
    const { rt, link, h } = await bootWithSession()
    link.deliver("ses_a", priv({ text: "Can you review the docs?", msgid: "in1" }))
    await rt.settle()
    expect(h.prompts).toHaveLength(1)
    const p = h.prompts[0]
    expect(p?.["sessionID"]).toBe("ses_a")
    expect(String(p?.["text"])).toContain("[IRC peer request] bob")
    expect(String(p?.["text"])).toContain("Can you review the docs?")
    expect(p?.["delivery"]).toBeUndefined()
    expect(p?.["metadata"]).toEqual({ agentComms: true })
    expect(rt.hop.outgoingHop("ses_a")).toBe(1)
    expect(rt.registry.get("ses_a")?.busy).toBe(true)
    expect(byCommand(link.sent, "STATE")).toContainEqual(["ses_a", "busy"])
    expect(rt.inbox.totalUnread("ses_a")).toBe(0)
    expect(rt.budgetFor("ses_a").snapshot(NOW).used).toBe(1)
  })

  test("chatter in a channel adds to unread and does not prompt", async () => {
    const { rt, link, h } = await bootWithSession()
    link.deliver("ses_a", priv({ target: "#lobby", text: "just talking among ourselves" }))
    await rt.settle()
    expect(h.prompts).toHaveLength(0)
    expect(rt.inbox.totalUnread("ses_a")).toBe(1)
  })

  test("a mention in a channel is directed", async () => {
    const { rt, link, h } = await bootWithSession()
    link.deliver("ses_a", priv({ target: "#lobby", text: "fix-auth: please look" }))
    await rt.settle()
    expect(h.prompts).toHaveLength(1)
  })

  test("a message over the hop limit is held back", async () => {
    const { rt, link, h } = await bootWithSession()
    link.deliver("ses_a", priv({ hop: 5 }))
    await rt.settle()
    expect(h.prompts).toHaveLength(0)
    expect(rt.inbox.totalUnread("ses_a")).toBe(1)
    expect(rt.hopBlockedCount("ses_a")).toBe(1)
  })

  test("the operator bypasses the wake budget", async () => {
    const { rt, link, h } = await bootWithSession({ options: { wakeBudget: 0 } })
    link.deliver("ses_a", priv({ text: "peer ping" }))
    await rt.settle()
    expect(h.prompts).toHaveLength(0)
    expect(rt.inbox.totalUnread("ses_a")).toBe(1)

    link.deliver(
      "ses_a",
      priv({ text: "stop that", role: "operator", rel: "operator", senderNick: "alice", senderAccount: "operator", hop: 3 }),
    )
    await rt.settle()
    expect(h.prompts).toHaveLength(1)
    expect(String(h.prompts[0]?.["text"])).toContain("[IRC] alice (operator)")
    // An operator turn counts as hop 0.
    expect(rt.hop.outgoingHop("ses_a")).toBe(1)
  })

  test("a DM to a busy session steers", async () => {
    const { rt, link, h } = await bootWithSession()
    await h.events.push(status("ses_a", "busy"))
    await rt.settle()
    link.deliver("ses_a", priv({ hop: 2 }))
    await rt.settle()
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.["delivery"]).toBe("steer")
    expect(rt.hop.outgoingHop("ses_a")).toBe(3)
    expect(rt.budgetFor("ses_a").snapshot(NOW).used).toBe(0)
  })

  test("a waiter consumes the reply and nothing is pushed", async () => {
    const { rt, link, h } = await bootWithSession()
    const waiting = rt.inbox.waitFor("ses_a", { replyTo: "out1", timeoutMs: 5000 })
    link.deliver("ses_a", priv({ replyTo: "out1", msgid: "in9", text: "the answer" }))
    await rt.settle()
    const result = await waiting
    expect(result.kind).toBe("reply")
    expect(h.prompts).toHaveLength(0)
    expect(rt.inbox.totalUnread("ses_a")).toBe(0)
    expect(rt.inbox.get("ses_a", "in9")?.text).toBe("the answer")
  })

  test("another directed message interrupts a waiter", async () => {
    const { rt, link, h } = await bootWithSession()
    const waiting = rt.inbox.waitFor("ses_a", { replyTo: "out1", timeoutMs: 5000 })
    link.deliver("ses_a", priv({ text: "urgent" }))
    await rt.settle()
    expect((await waiting).kind).toBe("interrupted")
    expect(h.prompts).toHaveLength(0)
  })

  test("own messages and duplicates are dropped", async () => {
    const { rt, link, h } = await bootWithSession()
    link.deliver("ses_a", priv({ senderAccount: "ses_a", senderNick: "fix-auth" }))
    link.deliver("ses_a", priv({ msgid: "dup", target: "#lobby", text: "chatter" }))
    link.deliver("ses_a", priv({ msgid: "dup", target: "#lobby", text: "chatter" }))
    await rt.settle()
    expect(h.prompts).toHaveLength(0)
    expect(rt.inbox.totalUnread("ses_a")).toBe(1)
  })

  test("multiline batches are assembled", async () => {
    const { rt, link, h } = await bootWithSession()
    const open = msg("BATCH", ["+b1", "draft/multiline", "fix-auth"], {
      tags: [
        ["msgid", "ml1"],
        ["account", "ses_x"],
        [vendorTag("rel"), "peer"],
        [vendorTag("role"), "agent"],
      ],
      source: "bob!ses_x@agent-comms.local",
    })
    link.deliver("ses_a", open)
    link.deliver("ses_a", msg("PRIVMSG", ["fix-auth", "line one"], { tags: [["batch", "b1"]] }))
    link.deliver("ses_a", msg("PRIVMSG", ["fix-auth", "line two"], { tags: [["batch", "b1"]] }))
    link.deliver("ses_a", msg("BATCH", ["-b1"]))
    await rt.settle()
    expect(h.prompts).toHaveLength(1)
    expect(String(h.prompts[0]?.["text"])).toContain("line one\nline two")
  })

  test("JOIN and PART echoes of our own nick update the channel list", async () => {
    const { rt, link } = await bootWithSession()
    const src = "fix-auth!ses_a@agent-comms.local"
    link.deliver("ses_a", msg("JOIN", ["#extra"], { source: src }))
    link.deliver("ses_a", msg("JOIN", ["#other"], { source: "bob!ses_x@agent-comms.local" }))
    expect(rt.registry.get("ses_a")?.channels).toContain("#extra")
    expect(rt.registry.get("ses_a")?.channels).not.toContain("#other")
    link.deliver("ses_a", msg("PART", ["#extra"], { source: src }))
    expect(rt.registry.get("ses_a")?.channels).not.toContain("#extra")
  })

  test("a failed prompt leaves the message unread", async () => {
    const { rt, link, h } = await bootWithSession()
    h.ctx.session.prompt = async () => {
      throw new Error("nope")
    }
    link.deliver("ses_a", priv({ msgid: "in1" }))
    await rt.settle()
    expect(rt.inbox.totalUnread("ses_a")).toBe(1)
    expect(rt.registry.get("ses_a")?.busy).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

describe("prompt hook", () => {
  test("a user prompt starts a turn at hop 0, an injected prompt does not", async () => {
    const { rt, link, h } = await bootWithSession()
    link.deliver("ses_a", priv({ hop: 2 }))
    await rt.settle()
    expect(rt.hop.outgoingHop("ses_a")).toBe(3)

    // The prompt that the plugin injected passes the hook again. It keeps the hop.
    await h.hooks.prompt[0]?.({ sessionID: "ses_a", prompt: { text: "wrapped" }, metadata: { agentComms: true } })
    expect(rt.hop.outgoingHop("ses_a")).toBe(3)

    // The user types a prompt. The turn starts at hop 0, so messages leave with hop 1.
    await h.hooks.prompt[0]?.({ sessionID: "ses_a", prompt: { text: "please continue" } })
    expect(rt.hop.outgoingHop("ses_a")).toBe(1)
  })
})

describe("context hook", () => {
  test("adds the IRC context for a registered session", async () => {
    const { rt, link, h } = await bootWithSession()
    link.deliver("ses_a", priv({ target: "#lobby", text: "chatter" }))
    await rt.settle()
    const ev = { sessionID: "ses_a", system: [] as unknown[] }
    await h.hooks.context[0]?.(ev)
    expect(ev.system).toHaveLength(1)
    const part = ev.system[0] as { type: string; text: string }
    expect(part.type).toBe("text")
    expect(part.text).toContain('you are "fix-auth"')
    expect(part.text).toContain("#lobby")
    expect(part.text).toContain("Unread: #lobby 1")
  })

  test("adds the one-time join context once", async () => {
    const { rt, h } = await bootWithSession()
    rt.inbox.recordJoinContext("ses_a", "#dev", "topic", ["<bob> hi"])
    const first = { sessionID: "ses_a", system: [] as unknown[] }
    const second = { sessionID: "ses_a", system: [] as unknown[] }
    await h.hooks.context[0]?.(first)
    await h.hooks.context[0]?.(second)
    expect((first.system[0] as { text: string }).text).toContain("Joined #dev")
    expect((second.system[0] as { text: string }).text).not.toContain("Joined #dev")
  })

  test("says offline when the link never came up", async () => {
    const { h } = await boot({ connected: false, sessions: { ses_a: info("ses_a") } })
    await h.events.push(created("ses_a", { title: "Fix auth" }))
    const ev = { sessionID: "ses_a", system: [] as unknown[] }
    await h.hooks.context[0]?.(ev)
    expect((ev.system[0] as { text: string }).text).toContain("IRC offline")
  })

  test("opted-out sessions get the opt-out notice, unknown sessions nothing", async () => {
    const { h } = await boot({ options: { excludeAgents: ["plan"] } })
    await h.events.push(created("ses_p", { agent: "plan" }))
    const opted = { sessionID: "ses_p", system: [] as unknown[] }
    await h.hooks.context[0]?.(opted)
    expect((opted.system[0] as { text: string }).text).toContain("off for this session")
    const unknown = { sessionID: "ses_zzz", system: [] as unknown[] }
    await h.hooks.context[0]?.(unknown)
    expect(unknown.system).toHaveLength(0)
  })
})

describe("permission hook", () => {
  const edit = (sessionID: string, path: string) => ({
    sessionID,
    action: "edit",
    resources: [path],
    effect: "allow" as string,
    message: undefined as string | undefined,
  })

  async function withClaims(o: Parameters<typeof boot>[0] = {}) {
    const b = await boot({ sessions: { ses_a: info("ses_a"), ses_b: info("ses_b", { parentID: "ses_a" }) }, ...o })
    await b.h.events.push(created("ses_a", { title: "Fix auth" }))
    await b.h.events.push(created("ses_b", { parentID: "ses_a", agent: "explore" }))
    await b.rt.settle()
    b.link.emit("line", msg("CLAIMSET", ["ses_x", "xnick", "100", "9999999999", "/work/webapp/src/a.ts"]))
    b.link.emit("line", msg("CLAIMSET", ["ses_b", "fix-auth|explore1", "100", "9999999999", "/work/webapp/src/b.ts"]))
    return b
  }

  test("denies a path that another family claims", async () => {
    const { h } = await withClaims()
    const ev = edit("ses_a", "src/a.ts")
    await h.hooks.evaluate[0]?.(ev)
    expect(ev.effect).toBe("deny")
    expect(ev.message).toContain("xnick")
    expect(ev.message).toContain("irc_ask")
  })

  test("allows a path that a family member claims", async () => {
    const { h } = await withClaims()
    const ev = edit("ses_a", "/work/webapp/src/b.ts")
    await h.hooks.evaluate[0]?.(ev)
    expect(ev.effect).toBe("allow")
    expect(ev.message).toBeUndefined()
  })

  test("ignores actions that are not edits and unclaimed paths", async () => {
    const { h } = await withClaims()
    const read = { ...edit("ses_a", "src/a.ts"), action: "read" }
    await h.hooks.evaluate[0]?.(read)
    expect(read.effect).toBe("allow")
    const free = edit("ses_a", "src/free.ts")
    await h.hooks.evaluate[0]?.(free)
    expect(free.effect).toBe("allow")
  })

  test("does not weaken an existing deny to ask", async () => {
    const { h } = await withClaims({ connected: false, options: { graceMs: 1 } })
    const ev = { ...edit("ses_a", "src/free.ts"), effect: "deny" }
    await h.hooks.evaluate[0]?.(ev)
    expect(ev.effect).toBe("deny")
  })

  test("opted-out sessions are still checked, and their ancestor's family is respected", async () => {
    const b = await withClaims({ options: { excludeAgents: ["plan"] } })
    await b.h.events.push(created("ses_p", { agent: "plan" }))
    await b.h.events.push(created("ses_q", { agent: "plan", parentID: "ses_a" }))
    await b.rt.settle()
    expect(b.rt.registry.get("ses_p")?.optedOut).toBe(true)
    expect(b.rt.registry.get("ses_q")?.optedOut).toBe(true)
    const outsider = edit("ses_p", "src/a.ts")
    await b.h.hooks.evaluate[0]?.(outsider)
    expect(outsider.effect).toBe("deny")
    const memberOfFamily = edit("ses_q", "src/b.ts")
    await b.h.hooks.evaluate[0]?.(memberOfFamily)
    expect(memberOfFamily.effect).toBe("allow")
  })

  test("waits for the grace period, then asks when the link is down", async () => {
    const { rt, h } = await boot({ connected: false, options: { graceMs: 20 }, sessions: { ses_a: info("ses_a") } })
    await h.events.push(created("ses_a", { title: "Fix auth" }))
    await rt.settle()
    const ev = edit("ses_a", "src/free.ts")
    const t0 = Date.now()
    await h.hooks.evaluate[0]?.(ev)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15)
    expect(ev.effect).toBe("ask")
    expect(ev.message).toContain("IRC server unreachable")
  })

  test("denies cached claims when the link is down", async () => {
    const { rt, link, h } = await boot({ connected: false, options: { graceMs: 1 }, sessions: { ses_a: info("ses_a") } })
    await h.events.push(created("ses_a", { title: "Fix auth" }))
    await rt.settle()
    link.emit("line", msg("CLAIMSET", ["ses_x", "xnick", "100", "9999999999", "/work/webapp/src/a.ts"]))
    const ev = edit("ses_a", "src/a.ts")
    await h.hooks.evaluate[0]?.(ev)
    expect(ev.effect).toBe("deny")
    expect(ev.message).toContain("cached")
  })

  test("failMode deny and open", async () => {
    const deny = await boot({ connected: false, options: { graceMs: 1, failMode: "deny" } })
    const a = edit("ses_a", "src/free.ts")
    await deny.h.hooks.evaluate[0]?.(a)
    expect(a.effect).toBe("deny")
    const open = await boot({ connected: false, options: { graceMs: 1, failMode: "open" } })
    const b = edit("ses_a", "src/free.ts")
    await open.h.hooks.evaluate[0]?.(b)
    expect(b.effect).toBe("allow")
  })

  test("denies a literal file name with brackets that another agent claims", async () => {
    const file = "/work/webapp/src/routes/[id].ts"
    const b = await withClaims({ realpath: (p) => (p === file ? p : null) })
    b.link.emit("line", msg("CLAIMSET", ["ses_x", "xnick", "100", "9999999999", file]))
    const ev = edit("ses_a", "src/routes/[id].ts")
    await b.h.hooks.evaluate[0]?.(ev)
    expect(ev.effect).toBe("deny")
    expect(ev.message).toContain(file)
  })

  test("denies a glob that matches a claimed path", async () => {
    const { h } = await withClaims()
    const ev = edit("ses_a", "src/**/*.ts")
    await h.hooks.evaluate[0]?.(ev)
    expect(ev.effect).toBe("deny")
    expect(ev.message).toContain("/work/webapp/src/a.ts is claimed by xnick")
  })

  test("allows a glob with no match, and an edit with no paths, while established", async () => {
    const { h } = await withClaims()
    const glob = edit("ses_a", "lib/**/*.ts")
    await h.hooks.evaluate[0]?.(glob)
    expect(glob.effect).toBe("allow")
    const empty = { ...edit("ses_a", ""), resources: [] as string[] }
    await h.hooks.evaluate[0]?.(empty)
    expect(empty.effect).toBe("allow")
  })

  test("offline: globs and edits with no paths follow failMode", async () => {
    const cases = [
      ["deny", "deny"],
      ["ask", "ask"],
      ["open", "allow"],
    ] as const
    for (const [failMode, expected] of cases) {
      const b = await boot({ connected: false, options: { graceMs: 1, failMode } })
      const glob = edit("ses_a", "lib/**/*.ts")
      await b.h.hooks.evaluate[0]?.(glob)
      expect(glob.effect).toBe(expected)
      const empty = { ...edit("ses_a", ""), resources: [] as string[] }
      await b.h.hooks.evaluate[0]?.(empty)
      expect(empty.effect).toBe(expected)
    }
  })
})

describe("claims", () => {
  test("a completed edit claims the canonical path", async () => {
    const { rt, link, h } = await bootWithSession()
    await h.hooks.toolAfter[0]?.({ tool: "edit", sessionID: "ses_a", status: "completed", input: { filePath: "src/x.ts" } })
    await rt.settle()
    expect(byCommand(link.requests, "CLAIM")).toEqual([["ses_a", "/work/webapp/src/x.ts"]])
    expect(rt.claims.held("ses_a")).toEqual(["/work/webapp/src/x.ts"])
    expect(rt.cache.get("/work/webapp/src/x.ts")?.holderAccount).toBe("ses_a")
  })

  test("failed tools and other tools do not claim", async () => {
    const { rt, link, h } = await bootWithSession()
    await h.hooks.toolAfter[0]?.({ tool: "edit", sessionID: "ses_a", status: "error", input: { filePath: "a.ts" } })
    await h.hooks.toolAfter[0]?.({ tool: "read", sessionID: "ses_a", status: "completed", input: { filePath: "a.ts" } })
    await rt.settle()
    expect(link.requests.filter((m) => m.command === "CLAIM")).toHaveLength(0)
  })

  test("CLAIMFAIL drops the tracked claim", async () => {
    const { rt, link, h } = await bootWithSession()
    link.claimFail = true
    await h.hooks.toolAfter[0]?.({ tool: "write", sessionID: "ses_a", status: "completed", input: { filePath: "a.ts" } })
    await rt.settle()
    expect(rt.claims.held("ses_a")).toEqual([])
  })

  test("with the link down the claim is kept for the next burst", async () => {
    const { rt, link, h } = await boot({ connected: false })
    await h.events.push(created("ses_a", { title: "Fix auth" }))
    await h.hooks.toolAfter[0]?.({ tool: "edit", sessionID: "ses_a", status: "completed", input: { filePath: "a.ts" } })
    await rt.settle()
    expect(link.requests).toHaveLength(0)
    expect(rt.claims.held("ses_a")).toEqual(["/work/webapp/a.ts"])
  })

  test("CLAIMSET and CLAIMDEL lines update the cache, server bursts prune it", async () => {
    const { rt, link } = await bootWithSession()
    link.emit("line", msg("CLAIMSET", ["ses_x", "xnick", "1", "9999999999", "/p/one"]))
    link.emit("line", msg("CLAIMSET", ["ses_x", "xnick", "1", "9999999999", "/p/two"]))
    expect(rt.cache.all()).toHaveLength(2)
    link.emit("line", msg("CLAIMDEL", ["/p/one"]))
    expect(rt.cache.get("/p/one")).toBeUndefined()
    link.emit("line", msg("BURST"))
    link.emit("line", msg("CLAIMSET", ["ses_x", "xnick", "1", "9999999999", "/p/three"]))
    link.emit("line", msg("ENDBURST"))
    expect(rt.cache.all().map((c) => c.path)).toEqual(["/p/three"])
  })

  test("a CLAIMSET by another holder drops our tracked claim", async () => {
    const { rt, link } = await bootWithSession()
    rt.claims.record("ses_a", "/p/one")
    link.emit("line", msg("CLAIMSET", ["ses_x", "xnick", "1", "9999999999", "/p/one"]))
    expect(rt.claims.held("ses_a")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Commands and AGENT
// ---------------------------------------------------------------------------

describe("/irc command", () => {
  const run = (h: Harness, text: string) =>
    h.commands.get("irc")?.execute({ sessionID: "ses_a", prompt: { text }, delivery: "queue" })

  test("off retires the account, hides the nick, and on introduces it again", async () => {
    const { rt, link, h } = await bootWithSession()
    await run(h, "off")
    await rt.settle()
    expect(byCommand(link.requests, "RETIRE")).toEqual([["ses_a", "opted out"]])
    expect(rt.registry.get("ses_a")?.optedOut).toBe(true)
    expect(rt.registry.byNick("fix-auth")).toBeUndefined()
    expect(String(h.synthetics[0]?.["text"])).toContain("IRC is off")
    expect(h.synthetics[0]?.["resume"]).toBe(false)
    expect(rt.burstLines()).toEqual([])

    await run(h, "on")
    await rt.settle()
    expect(byCommand(link.requests, "INTRODUCE")).toHaveLength(2)
    expect(rt.registry.get("ses_a")?.optedOut).toBe(false)
    expect(String(h.synthetics[1]?.["text"])).toContain("IRC is on")
  })

  test("off releases tracked claims", async () => {
    const { rt, h } = await bootWithSession()
    rt.claims.record("ses_a", "/p/one")
    await run(h, "/irc off")
    await rt.settle()
    expect(rt.claims.held("ses_a")).toEqual([])
  })

  test("status posts nick, channels, link state, and budget", async () => {
    const { h } = await bootWithSession()
    await run(h, "status")
    const text = String(h.synthetics[0]?.["text"])
    expect(text).toContain('IRC nick "fix-auth"')
    expect(text).toContain("#lobby")
    expect(text).toContain("link: up")
    expect(text).toContain("wake budget 0/10")
  })

  test("no argument shows the status", async () => {
    const { h } = await bootWithSession()
    await run(h, "")
    expect(String(h.synthetics[0]?.["text"])).toContain('IRC nick "fix-auth"')
  })
})

describe("AGENT requests", () => {
  test("STATUS is answered on the link", async () => {
    const { rt, link } = await bootWithSession()
    link.emit("line", msg("AGENT", ["r1", "STATUS", "ses_a"]))
    await rt.settle()
    expect(link.sent.map((m) => `${m.command} ${m.params[0]}`)).toEqual(["AGENTREPLY r1", "AGENTEND r1"])
    expect(link.sent[0]?.params[2]).toStartWith("idle; wake budget 0/10")
  })

  test("INTERRUPT interrupts without resuming", async () => {
    const { rt, link, h } = await bootWithSession()
    link.emit("line", msg("AGENT", ["r2", "INTERRUPT", "ses_a"]))
    await rt.settle()
    expect(h.interrupts).toEqual([{ sessionID: "ses_a", resume: false }])
    expect(link.sent[0]?.params[2]).toBe("interrupted")
  })

  test("RESUME resets budget and hop-blocked", async () => {
    const { rt, link } = await bootWithSession()
    link.deliver("ses_a", priv({ hop: 9 }))
    rt.budgetFor("ses_a").consume(NOW)
    await rt.settle()
    expect(rt.hopBlockedCount("ses_a")).toBe(1)
    link.emit("line", msg("AGENT", ["r3", "RESUME", "ses_a"]))
    await rt.settle()
    expect(rt.hopBlockedCount("ses_a")).toBe(0)
    expect(rt.budgetFor("ses_a").snapshot(NOW).used).toBe(0)
  })

  test("an unknown account gets FAIL and AGENTEND", async () => {
    const { rt, link } = await bootWithSession()
    link.emit("line", msg("AGENT", ["r4", "STATUS", "ses_nope"]))
    await rt.settle()
    expect(link.sent.map((m) => m.command)).toEqual(["FAIL", "AGENTEND"])
  })
})
