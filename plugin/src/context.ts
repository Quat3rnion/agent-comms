/** Builds the compact per-session system text. Pure. */
import type { FailMode } from "./types.ts"

export const CONTEXT_CHAR_CAP = 1600

/** Always-on working rules. The `agent-comms` skill has the full etiquette. */
export const PROTOCOL =
  "Other agents cannot see your conversation: IRC is the only way to reach them. " +
  "Whenever you need to tell, ask, hand off or report something to another agent or the operator, use the IRC tools " +
  "(irc_send to inform, irc_ask to get an answer, irc_list/irc_names to find who to address). " +
  "At the start of a task post one line in your project channel saying what you work on; " +
  "before you edit files other agents may touch, run irc_read; when you finish, post a one-line result; " +
  "subagents report to their parent by nick. Load the agent-comms skill for details."
const MAX_UNREAD_TARGETS = 5

/** Why a message for this session was not pushed. */
export type HeldReason = "hop limit" | "wake budget" | "delivery failed" | "subagent post without your nick"

/** A message that the session should know about but did not get as a push. */
export interface HeldMessage {
  sender: string
  /** Channel name, or "DM". */
  target: string
  msgid: string
  reason: HeldReason
}

const MAX_HELD = 5

export interface ContextInput {
  nick: string | null
  optedOut: boolean
  channels: string[]
  unread: Array<{ target: string; count: number }>
  budget: { used: number; limit: number; resetsInMs: number }
  linkState: "up" | "down" | "never"
  failMode: FailMode
  held: HeldMessage[]
  joinContext: string | null
}

function cap(text: string): string {
  if (text.length <= CONTEXT_CHAR_CAP) return text
  let cut = text.slice(0, CONTEXT_CHAR_CAP - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut + "…"
}

function offlineText(failMode: FailMode): string {
  return (
    "IRC offline: messages cannot be sent; file claims" +
    (failMode === "open"
      ? " are not enforced; check with the user before editing shared files."
      : " are enforced from cache; other edits need operator approval.")
  )
}

function unreadText(unread: Array<{ target: string; count: number }>): string | null {
  const shown = unread.filter((u) => u.count > 0)
  if (shown.length === 0) return null
  const parts = shown
    .slice(0, MAX_UNREAD_TARGETS)
    .map((u) => `${u.target.startsWith("#") ? u.target : `DM ${u.target}`} ${u.count}`)
  const more = shown.length - MAX_UNREAD_TARGETS
  if (more > 0) parts.push(`+${more} more`)
  return `Unread: ${parts.join(", ")} (use irc_read).`
}

function heldText(held: HeldMessage[]): string | null {
  if (held.length === 0) return null
  const parts = held
    .slice(0, MAX_HELD)
    .map((h) => `${h.sender} in ${h.target} (msgid ${h.msgid}; ${h.reason})`)
  const more = held.length - MAX_HELD
  if (more > 0) parts.push(`+${more} more`)
  return `Not pushed to you (read with irc_read): ${parts.join(", ")}.`
}

export function buildContext(input: ContextInput): string {
  const parts: string[] = []
  const offline = input.linkState !== "up"

  if (input.optedOut) {
    parts.push(
      "IRC (agent-comms) is off for this session (use /irc on to enable). Claims by other agents still apply.",
    )
    if (offline) parts.push(offlineText(input.failMode))
    return cap(parts.join(" ")) + (input.joinContext ? `\n${input.joinContext}` : "")
  }

  let head = "IRC (agent-comms):"
  if (input.nick === null) head += " nick not assigned yet."
  else {
    head += ` you are "${input.nick}"`
    head += input.channels.length > 0 ? ` in ${input.channels.join(", ")}.` : "."
  }
  parts.push(head)

  const held = heldText(input.held)
  if (held) parts.push(held)

  const unread = unreadText(input.unread)
  if (unread) parts.push(unread)

  const { used, limit, resetsInMs } = input.budget
  parts.push(`Wake budget ${used}/${limit} used.`)
  if (used >= limit) {
    const minutes = Math.max(1, Math.ceil(resetsInMs / 60000))
    parts.push(`Wake budget used up: agent messages wait as unread until ${minutes} min.`)
  }
  if (offline) parts.push(offlineText(input.failMode))
  parts.push(
    "Tools: irc_send (announce/reply; no acknowledgement-only messages), irc_ask (blocking question), irc_wait, irc_read, irc_join, irc_part, irc_names, irc_list, irc_release.",
  )
  parts.push(PROTOCOL)

  return cap(parts.join(" ")) + (input.joinContext ? `\n${input.joinContext}` : "")
}
