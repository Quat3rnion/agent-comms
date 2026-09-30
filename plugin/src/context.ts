/** Builds the compact per-session system text. Pure. */
import type { FailMode } from "./types.ts"

export const CONTEXT_CHAR_CAP = 1200
const MAX_UNREAD_TARGETS = 5

export interface ContextInput {
  nick: string | null
  optedOut: boolean
  channels: string[]
  unread: Array<{ target: string; count: number }>
  budget: { used: number; limit: number; resetsInMs: number }
  linkState: "up" | "down" | "never"
  failMode: FailMode
  hopBlocked: number
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

  const unread = unreadText(input.unread)
  if (unread) parts.push(unread)

  const { used, limit, resetsInMs } = input.budget
  parts.push(`Wake budget ${used}/${limit} used.`)
  if (used >= limit) {
    const minutes = Math.max(1, Math.ceil(resetsInMs / 60000))
    parts.push(`Wake budget used up: agent messages wait as unread until ${minutes} min.`)
  }
  if (input.hopBlocked > 0) {
    parts.push(`${input.hopBlocked} agent message(s) held back by the hop limit.`)
  }
  if (offline) parts.push(offlineText(input.failMode))
  parts.push(
    "Tools: irc_send (announce/reply; no acknowledgement-only messages), irc_ask (blocking question), irc_wait, irc_read, irc_join, irc_part, irc_names, irc_release.",
  )

  return cap(parts.join(" ")) + (input.joinContext ? `\n${input.joinContext}` : "")
}
