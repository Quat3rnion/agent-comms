/**
 * Handling of the server `AGENT <id> <STATUS|INTERRUPT|RESUME> <account>` request.
 * `handleAgentRequest` returns the lines to send back. It sends nothing itself.
 */
import type { ClaimTracker } from "./claims.ts"
import type { WakeBudget } from "./delivery.ts"
import type { Inbox } from "./inbox.ts"
import type { IrcMessage } from "./proto.ts"
import { msg } from "./proto.ts"
import type { RegistryApi } from "./types.ts"

/** The server cuts AGENTREPLY text to 400 bytes. */
export const AGENT_TEXT_MAX_BYTES = 400

export interface AgentDeps {
  registry: RegistryApi
  inbox: Pick<Inbox, "totalUnread">
  claims: Pick<ClaimTracker, "held">
  budget(sessionID: string): WakeBudget
  hopBlocked: { get(sessionID: string): number; reset(sessionID: string): void }
  interrupt(sessionID: string): Promise<void>
  now(): number
}

/** One line of at most `max` bytes. CR and LF become spaces. Never cuts a UTF-8 sequence. */
export function agentText(text: string, max: number = AGENT_TEXT_MAX_BYTES): string {
  const flat = text.replace(/[\r\n\0]+/g, " ")
  const bytes = new TextEncoder().encode(flat)
  if (bytes.length <= max) return flat
  let end = max
  // Step back over continuation bytes so the cut is on a character boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return new TextDecoder().decode(bytes.slice(0, end))
}

function reply(id: string, account: string, text: string): IrcMessage {
  return msg("AGENTREPLY", [id, account, agentText(text)])
}

export async function handleAgentRequest(line: IrcMessage, deps: AgentDeps): Promise<IrcMessage[]> {
  const [id, verbRaw, account] = line.params
  if (id === undefined || id === "") return []
  const end = msg("AGENTEND", [id])
  if (verbRaw === undefined || account === undefined) {
    return [msg("FAIL", ["AGENT", "INVALID_PARAMS", "missing parameters"]), end]
  }
  const rec = deps.registry.get(account)
  if (!rec) {
    return [msg("FAIL", ["AGENT", "UNKNOWN_ACCOUNT", account, "unknown"]), end]
  }
  const sessionID = rec.sessionID

  switch (verbRaw.toUpperCase()) {
    case "STATUS": {
      const state = rec.optedOut ? "opted-out" : rec.busy ? "busy" : "idle"
      const b = deps.budget(sessionID).snapshot(deps.now())
      const text =
        `${state}; wake budget ${b.used}/${b.limit}; unread ${deps.inbox.totalUnread(sessionID)}; ` +
        `claims ${deps.claims.held(account).length}; hop-blocked ${deps.hopBlocked.get(sessionID)}`
      return [reply(id, account, text), end]
    }
    case "INTERRUPT": {
      try {
        await deps.interrupt(sessionID)
        return [reply(id, account, "interrupted"), end]
      } catch (e) {
        return [reply(id, account, `interrupt failed: ${e instanceof Error ? e.message : String(e)}`), end]
      }
    }
    case "RESUME": {
      deps.budget(sessionID).reset()
      deps.hopBlocked.reset(sessionID)
      return [reply(id, account, "budget and hop limit reset"), end]
    }
    default:
      return [reply(id, account, `unsupported request ${verbRaw}`), end]
  }
}
