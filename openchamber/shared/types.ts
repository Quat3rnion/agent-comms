// Types shared by the service and the panel. Plain JSON on the wire.

export type Away = 'idle' | 'dormant' | null;

export type MessageKind =
  | 'privmsg'
  | 'notice'
  | 'join'
  | 'part'
  | 'quit'
  | 'nick'
  | 'away'
  | 'topic';

export type Role = 'operator' | 'agent' | '';

export type Broadcast = 'here' | 'all' | '';

export interface ChatMessage {
  seq: number;
  msgid: string;
  /** Milliseconds since the Unix epoch. */
  time: number;
  /** Channel name, or the nick of the other side of a direct message. */
  target: string;
  from: string;
  text: string;
  kind: MessageKind;
  role: Role;
  broadcast: Broadcast;
  /** True when the operator account sent the message. */
  self: boolean;
  /** True when the message mentions the operator, is a broadcast, or is a direct message to the operator. */
  mention: boolean;
  /** True for backlog messages. Backlog never counts as unread. */
  history: boolean;
}

export interface Member {
  nick: string;
  away: Away;
  op: boolean;
  /** True for an IRC operator (the human). */
  operator: boolean;
}

export interface ChannelInfo {
  name: string;
  topic: string;
  members: Member[];
}

export interface UnreadInfo {
  unread: number;
  mentions: number;
}

export interface StateResponse {
  epoch: string;
  connected: boolean;
  needsLogin: boolean;
  nick: string;
  error: string | null;
  channels: ChannelInfo[];
  dms: string[];
  unread: Record<string, UnreadInfo>;
  /** Time of the last message for each target (milliseconds). */
  last: Record<string, number>;
  seq: number;
}

export interface MessagesResponse {
  epoch: string;
  target: string;
  messages: ChatMessage[];
  /** True when older messages may exist. */
  hasMore: boolean;
  seq: number;
}

export type ServiceEvent =
  | { seq: number; type: 'message'; message: ChatMessage }
  | { seq: number; type: 'members'; channel: string; members: Member[] }
  | { seq: number; type: 'channels' }
  | { seq: number; type: 'topic'; channel: string; topic: string }
  | { seq: number; type: 'history'; target: string }
  | { seq: number; type: 'connection'; connected: boolean; needsLogin: boolean; error: string | null };

export interface EventsResponse {
  epoch: string;
  seq: number;
  events: ServiceEvent[];
  reset?: true;
}

export interface SendResponse {
  ok: boolean;
  msgid?: string;
  error?: string;
}

export type AgentVerb = 'STATUS' | 'INTERRUPT' | 'RESUME';

export interface AgentResponse {
  ok: boolean;
  lines: string[];
  timedOut?: boolean;
  error?: string;
}

export interface Claim {
  nick: string;
  path: string;
  /** Unix seconds. */
  since: number;
  /** Unix seconds. */
  until: number;
}

export interface ClaimsResponse {
  ok: boolean;
  claims: Claim[];
  error?: string;
}

export interface LoginResponse {
  ok: boolean;
  error?: string;
}
