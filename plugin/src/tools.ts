/**
 * Agent-facing IRC tools: send, ask, wait, read, join, part, names, list, release.
 * `buildTools` is pure. `registerTools` adapts the tools to the opencode plugin API.
 */
import { resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { ClaimTracker } from "./claims.ts"
import { releaseLine } from "./claims.ts"
import type { HopTracker } from "./delivery.ts"
import type { AskHandle, Inbox, WaitResult } from "./inbox.ts"
import type { LinkClient, SendResult } from "./link.ts"
import type { IrcMessage, Tags } from "./proto.ts"
import { getTag, msg, sourceNick, vendorTag } from "./proto.ts"
import type { InboundMessage, LinkApi, Options, RegistryApi, SessionRecord } from "./types.ts"
import { LinkDownError } from "./types.ts"

export interface ToolDeps {
  link: LinkApi & Pick<LinkClient, "sendAs" | "sendMultiline">
  inbox: Inbox
  registry: RegistryApi
  hop: HopTracker
  claims: ClaimTracker
  options: Options
  /** Called after a tool changed membership so the caller can refresh the session's channels. */
  onChannelsChanged?: (sessionID: string) => void
  /**
   * Deliver messages that an ask window held but did not use, as if they had just arrived.
   * Without it, the messages are marked unread.
   */
  redeliver?: (sessionID: string, messages: InboundMessage[]) => void
}

export interface ToolDef {
  name: string
  description: string
  /** JSON schema of the input. */
  input: Record<string, unknown>
  execute: (
    input: unknown,
    context: { sessionID: string; signal?: AbortSignal },
  ) => Promise<{ content: string }>
}

const NAMESPACE = "irc"
const MAX_TIMEOUT_SEC = 3600
const DEFAULT_READ_LIMIT = 20
const MAX_READ_LIMIT = 100
/** At most this many channels get a WHO query for awake counts in irc_list. */
const LIST_WHO_LIMIT = 30

const OFF = "IRC is off for this session (use /irc on)."
const UNREACHABLE = "Error: IRC server unreachable."
const UNREACHABLE_SEND = "Error: IRC server unreachable. The message was NOT sent."
const TIMED_OUT = "Error: the IRC server did not answer in time."
const TIMED_OUT_SEND = "Error: the IRC server did not answer in time. The message may not have been sent."

const SEND_FAIL_TEXT: Record<string, string> = {
  NOSUCHNICK: "no such nick/agent",
  NOSUCHCHANNEL: "no such channel (use irc_join first)",
  CANNOTSEND: "you cannot send to this target (join the channel first)",
  TOOLONG: "the message is too long",
  BROADCASTDENIED: "@all is reserved for the operator",
  FLOOD: "you sent too many messages; slow down",
  INVALID: "the server rejected the message as invalid",
}

/** An error whose message is the tool result. */
class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolError"
  }
}

interface ToolCtx {
  sessionID: string
  signal?: AbortSignal
}

type Args = Record<string, unknown>

type Handler = (args: Args, ctx: ToolCtx, rec: SessionRecord) => Promise<string>

const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

function toArgs(input: unknown): Args {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) return input as Args
  throw new ToolError("Error: the input must be an object.")
}

function optString(a: Args, key: string): string | undefined {
  const v = a[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "string") throw new ToolError(`Error: ${key} must be a string.`)
  return v
}

function reqString(a: Args, key: string): string {
  const v = optString(a, key)
  if (v === undefined || v.trim() === "") throw new ToolError(`Error: ${key} is required.`)
  return v
}

function optNumber(a: Args, key: string): number | undefined {
  const v = a[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolError(`Error: ${key} must be a number.`)
  return v
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false }
}

function validateTarget(target: string): string {
  const t = target.trim()
  if (t === "" || t.length > 200 || /[\s,\0-\x1f\x7f]/.test(t)) {
    throw new ToolError(`Error: "${target}" is not a valid nick or channel name.`)
  }
  return t
}

function validateChannel(channel: string): string {
  const c = validateTarget(channel)
  if (!c.startsWith("#") || c.length < 2) {
    throw new ToolError(`Error: "${channel}" is not a channel name. A channel name starts with "#".`)
  }
  return c
}

function validateMsgid(msgid: string): string {
  const id = msgid.trim()
  if (id === "" || /[\s\0-\x1f\x7f]/.test(id)) throw new ToolError(`Error: "${msgid}" is not a valid msgid.`)
  return id
}

function prepareText(raw: string, maxBytes: number): string {
  const text = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "")
  if (/[\r\0]/.test(text)) throw new ToolError("Error: the text contains a CR or NUL character. Remove it.")
  if (text.trim() === "") throw new ToolError("Error: the text is empty.")
  const bytes = encoder.encode(text).length
  if (bytes > maxBytes) {
    throw new ToolError(
      `Error: message is ${bytes} bytes; the limit is ${maxBytes}. Write the content to a file and send the path instead.`,
    )
  }
  return text
}

function timeoutSeconds(a: Args, options: Options): number {
  const v = optNumber(a, "timeoutSec")
  if (v === undefined) return Math.min(options.askTimeoutMs / 1000, MAX_TIMEOUT_SEC)
  if (v <= 0) throw new ToolError("Error: timeoutSec must be greater than 0.")
  return Math.min(v, MAX_TIMEOUT_SEC)
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

function sendFailText(r: Extract<SendResult, { ok: false }>): string {
  const mapped = SEND_FAIL_TEXT[r.code]
  if (mapped === undefined) return `Error: ${r.code}: ${r.reason !== "" ? r.reason : "the server refused the message"}`
  return `Error: ${r.code}: ${mapped}${r.reason !== "" && r.reason !== mapped ? ` (${r.reason})` : ""}`
}

/** Text of the first error line in a query reply, or null. */
function findError(lines: IrcMessage[]): string | null {
  for (const l of lines) {
    if (l.command === "FAIL") {
      const code = l.params[1] ?? "FAIL"
      return `Error: ${code}: ${l.params[l.params.length - 1] ?? ""}`.trimEnd()
    }
    if (/^[45]\d\d$/.test(l.command)) {
      return `Error: ${l.command}: ${l.params.slice(1).join(" ")}`.trimEnd()
    }
  }
  return null
}

function previewOf(text: string, max: number): { preview: string; truncated: boolean } {
  const points = Array.from(text)
  if (points.length <= max) return { preview: text, truncated: false }
  return { preview: points.slice(0, Math.max(0, max)).join("") + "…", truncated: true }
}

function formatEntry(
  time: string,
  target: string,
  nick: string,
  preview: string,
  truncated: boolean,
  msgid: string,
): string {
  const suffix = truncated
    ? ` (msgid ${msgid}; truncated, use irc_read with msgid for full text)`
    : ` (msgid ${msgid})`
  return `[${time}] ${target} <${nick}> ${preview}${suffix}`
}

/** Format the PRIVMSG lines of a CHATHISTORY reply. */
function formatHistory(lines: IrcMessage[], target: string, previewChars: number): string[] {
  const out: string[] = []
  for (const l of lines) {
    if (l.command !== "PRIVMSG") continue
    const p = previewOf(l.params[1] ?? "", previewChars)
    out.push(
      formatEntry(
        getTag(l, "time") ?? "",
        target,
        sourceNick(l) ?? "?",
        p.preview,
        p.truncated,
        getTag(l, "msgid") ?? "",
      ),
    )
  }
  return out
}

function formatWait(r: WaitResult, askMsgid: string, timeoutSec: number): string {
  switch (r.kind) {
    case "reply":
      return `Answer from ${r.message.senderNick} (msgid ${r.message.msgid}):\n${r.message.text}`
    case "interrupted": {
      const m = r.message
      const where = m.isChannel ? m.target : "DM"
      return (
        `No answer yet. A directed message arrived first from ${m.senderNick} in ${where} (msgid ${m.msgid}):\n${m.text}\n` +
        `Handle it, then call irc_wait with msgid "${askMsgid}" to keep waiting for the answer.`
      )
    }
    case "timeout":
      return `No answer within ${timeoutSec}s. A late answer will arrive as a normal message. (question msgid ${askMsgid})`
    case "aborted":
      return "Cancelled."
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function buildTools(deps: ToolDeps): ToolDef[] {
  const { link, inbox, registry, hop, claims, options } = deps

  function define(
    name: string,
    description: string,
    input: Record<string, unknown>,
    sends: boolean,
    handler: Handler,
  ): ToolDef {
    return {
      name,
      description,
      input,
      execute: async (raw, context) => {
        const rec = registry.get(context.sessionID)
        if (!rec || rec.optedOut) return { content: OFF }
        try {
          return { content: await handler(toArgs(raw), context, rec) }
        } catch (e) {
          if (e instanceof ToolError) return { content: e.message }
          if (e instanceof LinkDownError) return { content: sends ? UNREACHABLE_SEND : UNREACHABLE }
          if (e instanceof Error && e.message === "timeout") return { content: sends ? TIMED_OUT_SEND : TIMED_OUT }
          return { content: `Error: ${e instanceof Error ? e.message : String(e)}` }
        }
      },
    }
  }

  /** Send a PRIVMSG (or multiline batch) as the session. Returns the msgid. */
  async function transmit(
    rec: SessionRecord,
    sessionID: string,
    targetRaw: string,
    textRaw: string,
    replyToRaw: string | undefined,
  ): Promise<string> {
    const target = validateTarget(targetRaw)
    const text = prepareText(textRaw, options.maxMessageBytes)
    const replyTo = replyToRaw === undefined || replyToRaw.trim() === "" ? undefined : validateMsgid(replyToRaw)
    if (!link.connected) throw new ToolError(UNREACHABLE_SEND)
    const tags: Tags = [[`+${vendorTag("hop")}`, String(hop.outgoingHop(sessionID))]]
    if (replyTo !== undefined) tags.push(["+draft/reply", replyTo])
    const result = text.includes("\n")
      ? await link.sendMultiline(rec.account, target, text.split("\n"), tags)
      : await link.sendAs(rec.account, msg("PRIVMSG", [target, text], { tags }))
    if (!result.ok) throw new ToolError(sendFailText(result))
    return result.msgid
  }

  async function awaitReply(ctx: ToolCtx, askMsgid: string, timeoutSec: number, handle?: AskHandle): Promise<string> {
    const r = await inbox.waitFor(ctx.sessionID, {
      replyTo: askMsgid,
      timeoutMs: timeoutSec * 1000,
      signal: ctx.signal,
      handle,
    })
    return formatWait(r, askMsgid, timeoutSec)
  }

  /** Close an ask window and hand the unused buffered messages back for normal delivery. */
  function closeAsk(sessionID: string, handle: AskHandle): void {
    const released = inbox.endAsk(handle)
    if (released.length === 0) return
    if (deps.redeliver) {
      deps.redeliver(sessionID, released)
      return
    }
    for (const m of released) {
      inbox.add(sessionID, m, true)
      inbox.markUnread(sessionID, m.msgid)
    }
  }

  function requireLink(): void {
    if (!link.connected) throw new ToolError(UNREACHABLE)
  }

  /** Run a query and turn an error reply into a ToolError. */
  async function queryChecked(rec: SessionRecord, inner: IrcMessage): Promise<IrcMessage[]> {
    const lines = await link.query(rec.account, inner)
    const err = findError(lines)
    if (err !== null) throw new ToolError(err)
    return lines
  }

  // ---- send

  const send = define(
    "send",
    [
      "Send a message to another agent (nick) or to a channel (#name) on the local IRC server.",
      "Use it for announcements, answers and status updates.",
      "Do NOT send acknowledgement-only messages (thanks, ok, will do). Reply only when you add information.",
      "Put a nick in the text to address that agent in a channel. Use @here to address the agents that are awake.",
      "Set replyTo to the msgid of the message that you answer.",
      "A message can have several lines. The limit is the option maxMessageBytes; for larger content write a file and send its path.",
    ].join(" "),
    schema(
      {
        target: { type: "string", description: 'Nick of an agent, or a channel such as "#project".' },
        text: { type: "string", description: "Message text." },
        replyTo: { type: "string", description: "msgid of the message that you answer." },
      },
      ["target", "text"],
    ),
    true,
    async (a, ctx, rec) => {
      const target = reqString(a, "target")
      const msgid = await transmit(rec, ctx.sessionID, target, reqString(a, "text"), optString(a, "replyTo"))
      return `Sent to ${target.trim()} (msgid ${msgid}).`
    },
  )

  // ---- ask

  const ask = define(
    "ask",
    [
      "Ask another agent a question and wait for the answer. This call blocks.",
      "It returns the answer, or returns early when another directed message arrives first, or when the time runs out.",
      "After an early return, call irc_wait with the question msgid to keep waiting.",
      "Use it only when you need the answer to continue.",
    ].join(" "),
    schema(
      {
        target: { type: "string", description: "Nick of the agent (or a channel) to ask." },
        question: { type: "string", description: "The question." },
        timeoutSec: {
          type: "number",
          description: `Seconds to wait. Default ${options.askTimeoutMs / 1000}. Maximum ${MAX_TIMEOUT_SEC}.`,
        },
      },
      ["target", "question"],
    ),
    true,
    async (a, ctx, rec) => {
      const timeoutSec = timeoutSeconds(a, options)
      const target = reqString(a, "target")
      const question = reqString(a, "question")
      // Open the window before the send: a message can arrive before the msgid is known.
      const handle = inbox.beginAsk(ctx.sessionID)
      try {
        const msgid = await transmit(rec, ctx.sessionID, target, question, undefined)
        return await awaitReply(ctx, msgid, timeoutSec, handle)
      } finally {
        closeAsk(ctx.sessionID, handle)
      }
    },
  )

  // ---- wait

  const wait = define(
    "wait",
    "Keep waiting for the answer to an earlier irc_ask question. Give the question msgid. This call blocks until the answer, another directed message, or the time limit.",
    schema(
      {
        msgid: { type: "string", description: "msgid of the question." },
        timeoutSec: {
          type: "number",
          description: `Seconds to wait. Default ${options.askTimeoutMs / 1000}. Maximum ${MAX_TIMEOUT_SEC}.`,
        },
      },
      ["msgid"],
    ),
    false,
    async (a, ctx) => {
      const timeoutSec = timeoutSeconds(a, options)
      return awaitReply(ctx, validateMsgid(reqString(a, "msgid")), timeoutSec)
    },
  )

  // ---- read

  const read = define(
    "read",
    [
      "Read unread IRC messages as short previews, oldest first. This marks them as read.",
      "Give target (channel or nick) to read one place only. Without unread messages, a target shows the recent history.",
      "Give msgid to get the full text of one message.",
    ].join(" "),
    schema(
      {
        target: { type: "string", description: "Channel or nick to read." },
        msgid: { type: "string", description: "msgid of one message to show in full." },
        limit: {
          type: "number",
          description: `Maximum number of messages. Default ${DEFAULT_READ_LIMIT}. Maximum ${MAX_READ_LIMIT}.`,
        },
      },
      [],
    ),
    false,
    async (a, ctx, rec) => {
      const msgid = optString(a, "msgid")
      const target = optString(a, "target")?.trim()
      const limitIn = optNumber(a, "limit")
      const limit = Math.max(1, Math.min(MAX_READ_LIMIT, Math.floor(limitIn ?? DEFAULT_READ_LIMIT)))

      if (msgid !== undefined && msgid.trim() !== "") {
        const m = inbox.get(ctx.sessionID, msgid.trim())
        if (!m) return `Unknown msgid "${msgid.trim()}".`
        return `[${m.time}] ${m.target} <${m.senderNick}> (msgid ${m.msgid})\n${m.text}`
      }

      const entries = inbox.read(ctx.sessionID, target !== undefined && target !== "" ? { target, limit } : { limit })
      if (entries.length > 0) {
        const seen = new Set(entries.map((e) => e.target))
        for (const [t, time] of inbox.lastReadTimes(ctx.sessionID)) {
          if (!seen.has(t)) continue
          if (link.connected) {
            try {
              await link.query(rec.account, msg("MARKREAD", [t, `timestamp=${time}`]))
            } catch {
              // The server may refuse MARKREAD. The local state is still correct.
            }
          }
          inbox.markRead(ctx.sessionID, t, time)
        }
        return entries
          .map((e) => formatEntry(e.time, e.target, e.senderNick, e.preview, e.truncated, e.msgid))
          .join("\n")
      }

      if (target === undefined || target === "") return "No unread messages."
      if (!link.connected) return "No unread messages. (IRC server unreachable: no history available.)"
      const lines = await queryChecked(rec, msg("CHATHISTORY", ["LATEST", target, "*", String(limit)]))
      const history = formatHistory(lines, target, options.previewChars)
      if (history.length === 0) return "No unread messages."
      return `No unread messages in ${target}. Recent history:\n${history.join("\n")}`
    },
  )

  // ---- join

  const join = define(
    "join",
    "Join an IRC channel. The result shows the topic and the last messages of the channel.",
    schema({ channel: { type: "string", description: 'Channel name, for example "#project".' } }, ["channel"]),
    false,
    async (a, ctx, rec) => {
      const channel = validateChannel(reqString(a, "channel"))
      requireLink()
      await queryChecked(rec, msg("JOIN", [channel]))
      deps.onChannelsChanged?.(ctx.sessionID)

      let topic: string | null = null
      try {
        const lines = await link.query(rec.account, msg("TOPIC", [channel]))
        const t = lines.find((l) => l.command === "332")
        topic = t?.params[2] ?? null
      } catch {
        // No topic information. Continue.
      }

      let history: string[] = []
      if (options.joinContextLines > 0) {
        try {
          const lines = await link.query(
            rec.account,
            msg("CHATHISTORY", ["LATEST", channel, "*", String(options.joinContextLines)]),
          )
          history = formatHistory(lines, channel, options.previewChars)
        } catch {
          // History is optional.
        }
      }
      const recent = history.length > 0 ? history.join("\n") : "(no recent messages)"
      return `Joined ${channel}. Topic: ${topic ?? "(none)"}. Recent messages:\n${recent}`
    },
  )

  // ---- part

  const part = define(
    "part",
    "Leave an IRC channel.",
    schema(
      {
        channel: { type: "string", description: "Channel name." },
        reason: { type: "string", description: "Optional reason." },
      },
      ["channel"],
    ),
    false,
    async (a, ctx, rec) => {
      const channel = validateChannel(reqString(a, "channel"))
      const reason = optString(a, "reason")?.replace(/[\r\n\0]+/g, " ").trim()
      requireLink()
      await queryChecked(rec, msg("PART", reason !== undefined && reason !== "" ? [channel, reason] : [channel]))
      deps.onChannelsChanged?.(ctx.sessionID)
      return `Left ${channel}.`
    },
  )

  // ---- names

  const names = define(
    "names",
    "List the members of a channel. A member marked (away) is idle or dormant. A message that addresses a dormant agent wakes it.",
    schema({ channel: { type: "string", description: "Channel name." } }, ["channel"]),
    false,
    async (a, _ctx, rec) => {
      const channel = validateChannel(reqString(a, "channel"))
      requireLink()
      const lines = await queryChecked(rec, msg("NAMES", [channel]))
      const members: string[] = []
      for (const l of lines) {
        if (l.command !== "353") continue
        for (const raw of (l.params[l.params.length - 1] ?? "").split(" ")) {
          const nick = raw.replace(/^[@+%&~!]+/, "").split("!")[0] ?? ""
          if (nick !== "" && !members.includes(nick)) members.push(nick)
        }
      }
      if (members.length === 0) return `No members visible in ${channel}.`

      const away = new Set<string>()
      try {
        const who = await link.query(rec.account, msg("WHO", [channel]))
        for (const l of who) {
          if (l.command !== "352") continue
          const nick = l.params[5]
          if (nick !== undefined && (l.params[6] ?? "").startsWith("G")) away.add(nick)
        }
      } catch {
        // Away flags are optional.
      }
      const list = members.map((n) => (away.has(n) ? `${n} (away)` : n)).join(", ")
      return `Members of ${channel} (${members.length}): ${list}\nAWAY members are idle or dormant.`
    },
  )

  // ---- list

  const list = define(
    "list",
    "List channels on the IRC server: #lobby, project channels (#<project>), family channels (#<parent-nick>) and ad-hoc channels, with member counts and topics. A channel is active when at least one member is awake (not AWAY).",
    schema(
      {
        activeOnly: { type: "boolean", description: "Show only channels with at least one awake member. Default false." },
      },
      [],
    ),
    false,
    async (a, _ctx, rec) => {
      const activeOnly = typeof a === "object" && a !== null && (a as Record<string, unknown>)["activeOnly"] === true
      requireLink()
      const lines = await queryChecked(rec, msg("LIST", []))
      const channels: Array<{ name: string; members: number; topic: string }> = []
      for (const l of lines) {
        if (l.command !== "322") continue
        const name = l.params[1]
        if (name === undefined) continue
        channels.push({ name, members: Number(l.params[2] ?? "0") || 0, topic: l.params[3] ?? "" })
      }
      if (channels.length === 0) return "No channels."

      const rows: Array<{ name: string; kind: string; members: number; awake: number | null; topic: string }> = []
      for (const c of channels.slice(0, LIST_WHO_LIMIT)) {
        let awake: number | null = null
        let family = false
        try {
          const who = await link.query(rec.account, msg("WHO", [c.name]))
          const nicks = new Set<string>()
          awake = 0
          for (const w of who) {
            if (w.command !== "352") continue
            const nick = w.params[5] ?? ""
            nicks.add(nick.toLowerCase())
            if ((w.params[6] ?? "").startsWith("H")) awake++
          }
          family = nicks.has(c.name.slice(1).toLowerCase())
        } catch {
          // Awake counts are optional.
        }
        const kind = c.name.toLowerCase() === "#lobby" ? "lobby" : family ? "family" : "project/ad-hoc"
        rows.push({ name: c.name, kind, members: c.members, awake, topic: c.topic })
      }
      for (const c of channels.slice(LIST_WHO_LIMIT)) {
        rows.push({ name: c.name, kind: "?", members: c.members, awake: null, topic: c.topic })
      }

      const shown = activeOnly ? rows.filter((r) => r.awake !== null && r.awake > 0) : rows
      if (shown.length === 0) return "No active channels (no channel has an awake member)."
      shown.sort((x, y) => (y.awake ?? -1) - (x.awake ?? -1) || y.members - x.members || x.name.localeCompare(y.name))
      const out = shown.map((r) => {
        const awake = r.awake === null ? "" : `, ${r.awake} awake`
        const topic = r.topic !== "" ? ` — ${r.topic.slice(0, options.previewChars)}` : ""
        return `${r.name} [${r.kind}] ${r.members} member(s)${awake}${topic}`
      })
      return `Channels (${shown.length}${activeOnly ? " active" : ""}):\n${out.join("\n")}\nUse irc_join to join a channel, irc_names to see its members.`
    },
  )

  // ---- release

  const release = define(
    "release",
    "Release file claims that you hold. Give path to release one file. Without path, release all your claims.",
    schema({ path: { type: "string", description: "File path to release." } }, []),
    false,
    async (a, _ctx, rec) => {
      const pathIn = optString(a, "path")
      const paths =
        pathIn !== undefined && pathIn.trim() !== "" ? [resolve(process.cwd(), pathIn.trim())] : claims.held(rec.account)
      if (paths.length === 0) return "You hold no claims."
      requireLink()

      const released: string[] = []
      const failed: string[] = []
      for (const p of paths) {
        const reply = await link.request(releaseLine(rec.account, p))
        if (reply.command === "FAIL") {
          if (reply.params[1] === "NOT_HELD") {
            claims.release(rec.account, p)
            failed.push(`${p}: you do not hold this claim`)
          } else {
            failed.push(`${p}: ${reply.params[reply.params.length - 1] ?? reply.params[1] ?? "failed"}`)
          }
          continue
        }
        claims.release(rec.account, p)
        released.push(p)
      }
      const parts: string[] = []
      if (released.length > 0) parts.push(`Released ${released.length} claim(s): ${released.join(", ")}.`)
      if (failed.length > 0) parts.push(`Not released:\n${failed.join("\n")}`)
      return parts.join("\n")
    },
  )

  return [send, ask, wait, read, join, part, names, list, release]
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerTools(
  ctx: Pick<Plugin.Context, "tool">,
  deps: ToolDeps,
): Promise<{ dispose(): Promise<void> }> {
  const tools = buildTools(deps)
  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({ name: NAMESPACE, description: "Tools for messaging other agents over local IRC." })
    for (const tool of tools) {
      editor.add<Record<string, unknown>, undefined>({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        options: { namespace: NAMESPACE, codemode: false },
        execute: async (input, context) => {
          const result = await tool.execute(input, { sessionID: context.sessionID, signal: context.signal })
          return { content: result.content }
        },
      })
    }
  })
  return { dispose: () => registration.dispose() }
}
