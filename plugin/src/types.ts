/**
 * Shared types for the agent-comms plugin modules. This file is a contract:
 * link.ts, delivery.ts, inbox.ts, claims.ts, tools.ts, registry.ts and index.ts use it.
 */
import type { IrcMessage } from "./proto.ts"

export type FailMode = "ask" | "deny" | "open"

export interface Options {
  /** Master switch for this location. */
  enabled: boolean
  /** Agent names (for example "plan") whose sessions do not register. */
  excludeAgents: string[]
  failMode: FailMode
  host: string
  port: number
  tls: boolean
  /** Optional PEM CA file for a self-signed server certificate. */
  tlsCaPath: string | null
  /** File with the link token. Default ~/.config/agent-comms/link-token. */
  tokenPath: string
  /**
   * Server name that the server proof must match (the server `server_name`).
   * Default "irc.agent-comms.local".
   */
  serverName: string
  /**
   * Send CHALLENGE and verify the server PROOF before the link token goes out.
   * Set false only for servers without CHALLENGE support. Default true.
   */
  requireServerProof: boolean
  hopLimit: number
  wakeBudget: number
  /** Wakes by parent/subagent DMs for one session in one window. Separate from wakeBudget. */
  familyWakeBudget: number
  wakeWindowMs: number
  askTimeoutMs: number
  maxMessageBytes: number
  previewChars: number
  joinContextLines: number
  nickSlugLength: number
  graceMs: number
  backoffMaxMs: number
  /** Tool IDs whose successful execution claims the edited file. */
  claimEditTools: string[]
  /** Permission actions that are file edits (checked against claims). */
  editActions: string[]
}

export type Rel = "operator" | "ancestor" | "descendant" | "peer"
export type Role = "operator" | "agent"
export type Broadcast = "here" | "all"

/** A PRIVMSG or NOTICE that the server delivered to one of our accounts. */
export interface InboundMessage {
  /** Recipient account (opencode session ID). */
  account: string
  msgid: string
  /** Server time, ISO 8601. */
  time: string
  /** Sender account, or null when unknown. */
  senderAccount: string | null
  senderNick: string
  /** Channel name, or the recipient nick for a DM. */
  target: string
  isChannel: boolean
  command: "PRIVMSG" | "NOTICE"
  /** Full text. Multiline messages are joined with "\n". */
  text: string
  role: Role
  rel: Rel
  broadcast: Broadcast | null
  /** Value of +agent-comms.local/hop, 0 when absent. */
  hop: number
  /** Value of +draft/reply, or null. */
  replyTo: string | null
  /** Sender's parent nick (agent-comms.local/parent), or null. */
  parentNick: string | null
  /** True when the message came in a replay batch. */
  replay: boolean
}

/** One opencode session that this link owns. */
export interface SessionRecord {
  sessionID: string
  /** Server account ID. Equal to sessionID. */
  account: string
  /** Current nick as assigned by the server. */
  nick: string
  /** True until the one-time rename after the title arrives. */
  provisional: boolean
  parentID: string | null
  /** opencode agent name, for example "build". */
  agent: string
  title: string
  /** Project slug for the #<project> channel. */
  project: string
  /** Session opted out with /irc off or options. It has no nick. */
  optedOut: boolean
  busy: boolean
  channels: string[]
}

export interface Claim {
  path: string
  holderAccount: string
  holderNick: string
  /** Unix seconds. */
  since: number
  /** Unix seconds. */
  deadline: number
}

export type LinkState = "down" | "connecting" | "linked" | "established"

/** Error thrown by link operations when the server cannot be reached. */
export class LinkDownError extends Error {
  constructor(message = "IRC server unreachable") {
    super(message)
    this.name = "LinkDownError"
  }
}

/** The subset of the link client that other modules use. Implemented by LinkClient in link.ts. */
export interface LinkApi {
  readonly state: LinkState
  /** True when state is "established". */
  readonly connected: boolean
  /** Resolves true when established within timeoutMs, false otherwise. */
  waitConnected(timeoutMs: number, signal?: AbortSignal): Promise<boolean>
  /** Send one link line. Throws LinkDownError when not connected. */
  send(msg: IrcMessage): void
  /**
   * Send a link line with a fresh `label` tag and resolve with the first reply line that
   * carries the same label (SENT, SENDFAIL, FAIL, INTRODUCED, RENAMED, RETIRED, CLAIMSET,
   * CLAIMFAIL, CLAIMDEL). Rejects with LinkDownError on disconnect, Error on timeout.
   */
  request(msg: IrcMessage, timeoutMs?: number): Promise<IrcMessage>
  /**
   * Send an inner client line as `account` (wrapped in SEND) with an inner labeled-response
   * label, and resolve with all inner reply lines (unwrapped from DELIVER, batch lines removed).
   */
  query(account: string, inner: IrcMessage, timeoutMs?: number): Promise<IrcMessage[]>
}

/** Read access to the sessions that this link owns. Implemented by Registry in registry.ts. */
export interface RegistryApi {
  get(sessionID: string): SessionRecord | undefined
  /** Lookup by current nick (rfc1459 case-insensitive). */
  byNick(nick: string): SessionRecord | undefined
  all(): SessionRecord[]
  /** Aliases (old nicks) of a session, for mention matching. */
  aliases(sessionID: string): string[]
}
