// Pure state machine for the operator view of the IRC network.
// It takes parsed IRC lines and keeps channels, members, messages and an event log.
// It does no I/O. `handleLine` returns the lines that the caller must send to the server.
import { getTag, msg, type IrcMessage } from '../../plugin/src/proto.ts';
import type {
  Away,
  Broadcast,
  ChannelInfo,
  ChatMessage,
  EventsResponse,
  MessageKind,
  Member,
  MessagesResponse,
  Role,
  ServiceEvent,
  StateResponse,
  UnreadInfo,
} from '../shared/types.ts';

const TAG_ROLE = 'agent-comms.local/role';
const TAG_BROADCAST = 'agent-comms.local/broadcast';

export interface StateOptions {
  now?: () => number;
  /** Maximum messages for each target. */
  ringSize?: number;
  /** Maximum system lines (join, away, ...) for each target. */
  systemLimit?: number;
  /** Maximum events in the poll log. */
  eventLogSize?: number;
  /** Number of backlog messages to ask for on join. */
  backlog?: number;
  /** Account name of the operator (SASL account). */
  account?: string;
}

interface Chan {
  name: string;
  topic: string;
  members: Map<string, Member>;
  /** False after a disconnect, until the server confirms our JOIN again. */
  joined: boolean;
  namesOpen: boolean;
  whoDirty: boolean;
}

interface Target {
  name: string;
  messages: ChatMessage[];
  ids: Set<string>;
  systemCount: number;
  exhausted: boolean;
  readSeq: number;
}

interface Batch {
  id: string;
  type: string;
  args: string[];
  parent: string | undefined;
  tags: IrcMessage['tags'];
  source: string | null;
  lines: Array<{ command: string; target: string; text: string; concat: boolean }>;
  count: number;
  items: Array<{ target: string }>;
}

interface Waiter {
  after: number;
  wake: () => void;
}

const RFC1459_MAP: Record<string, string> = { '[': '{', ']': '}', '\\': '|', '~': '^' };

export const fold = (name: string): string =>
  name.toLowerCase().replace(/[[\]\\~]/g, (ch) => RFC1459_MAP[ch] ?? ch);

export const isChannelName = (name: string): boolean => name.startsWith('#') || name.startsWith('&');

const nickOf = (m: IrcMessage): string => {
  const source = m.source ?? '';
  const bang = source.indexOf('!');
  return bang === -1 ? source : source.slice(0, bang);
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toAway = (reason: string | undefined): Away => {
  if (reason === undefined || reason === '') return null;
  return reason.trim().toLowerCase() === 'dormant' ? 'dormant' : 'idle';
};

const joinNames = (list: string[]): string[] => {
  // Split a long list of channels into JOIN lines below 400 bytes.
  const lines: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const name of list) {
    if (size + name.length + 1 > 380 && current.length > 0) {
      lines.push(current.join(','));
      current = [];
      size = 0;
    }
    current.push(name);
    size += name.length + 1;
  }
  if (current.length > 0) lines.push(current.join(','));
  return lines;
};

/** Same rule as the server: the word @all or @here in the text. */
const isBoundary = (c: string): boolean => /\s/.test(c) || (/[!-/:-@[-`{-~]/.test(c) && c !== '@' && c !== '-' && c !== '_');

const hasWord = (text: string, word: string): boolean => {
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
    const end = i + word.length;
    if ((i === 0 || isBoundary(text.charAt(i - 1))) && (end === text.length || isBoundary(text.charAt(end)))) return true;
  }
  return false;
};

export const detectBroadcast = (text: string): Broadcast => {
  if (hasWord(text, '@all')) return 'all';
  if (hasWord(text, '@here')) return 'here';
  return '';
};

const timestampParam = (ms: number): string => `timestamp=${new Date(ms).toISOString()}`;

export class ChamberState {
  readonly epoch = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  seq = 0;
  nick = '';
  serverName = '';
  connected = false;
  needsLogin = false;
  error: string | null = null;
  /** Called when a chathistory batch closes: target and number of stored messages. */
  onHistoryDone: ((target: string, count: number) => void) | null = null;

  private readonly now: () => number;
  private readonly ringSize: number;
  private readonly systemLimit: number;
  private readonly eventLogSize: number;
  private readonly backlog: number;
  private readonly account: string;
  private readonly channels = new Map<string, Chan>();
  private readonly targets = new Map<string, Target>();
  private readonly dms = new Map<string, string>();
  private readonly awayCache = new Map<string, Away>();
  private readonly batches = new Map<string, Batch>();
  private readonly joinAttempts = new Map<string, number>();
  private listed: string[] | null = null;
  private events: ServiceEvent[] = [];
  private droppedThrough = 0;
  private waiters = new Set<Waiter>();
  private mentionRe: RegExp | null = null;

  constructor(options: StateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ringSize = options.ringSize ?? 500;
    this.systemLimit = options.systemLimit ?? 150;
    this.eventLogSize = options.eventLogSize ?? 5000;
    this.backlog = options.backlog ?? 100;
    this.account = (options.account ?? 'operator').toLowerCase();
  }

  // ---- connection state ----

  setStatus(status: { connected?: boolean; needsLogin?: boolean; error?: string | null }): void {
    const before = `${this.connected}|${this.needsLogin}|${this.error}`;
    if (status.connected !== undefined) this.connected = status.connected;
    if (status.needsLogin !== undefined) this.needsLogin = status.needsLogin;
    if (status.error !== undefined) this.error = status.error;
    if (before === `${this.connected}|${this.needsLogin}|${this.error}`) return;
    this.emit({ type: 'connection', connected: this.connected, needsLogin: this.needsLogin, error: this.error });
  }

  /** The socket closed. Keep messages, forget what depends on the connection. */
  onDisconnected(): void {
    this.batches.clear();
    this.listed = null;
    this.joinAttempts.clear();
    for (const chan of this.channels.values()) {
      chan.joined = false;
      chan.namesOpen = false;
    }
    this.setStatus({ connected: false });
  }

  // ---- input ----

  handleLine(m: IrcMessage): IrcMessage[] {
    switch (m.command) {
      case '001':
        return this.onWelcome(m);
      case 'BATCH':
        return this.onBatch(m);
      case 'PRIVMSG':
      case 'NOTICE':
        return this.onChatLine(m);
      case 'CHATHISTORY':
        return this.onChatHistoryLine(m);
      case 'JOIN':
        return this.onJoin(m);
      case 'PART':
        this.onPart(nickOf(m), m.params[0] ?? '', m.params[1], 'part');
        return [];
      case 'KICK':
        this.onPart(m.params[1] ?? '', m.params[0] ?? '', m.params[2], 'part');
        return [];
      case 'QUIT':
        this.onQuit(nickOf(m), m.params[0]);
        return [];
      case 'NICK':
        this.onNick(nickOf(m), m.params[0] ?? '');
        return [];
      case 'AWAY':
        this.onAway(nickOf(m), toAway(m.params[0]));
        return [];
      case 'TOPIC':
        this.onTopic(nickOf(m), m.params[0] ?? '', m.params[1] ?? '');
        return [];
      case '332':
        this.setTopic(m.params[1] ?? '', m.params[2] ?? '');
        return [];
      case '353':
        this.onNames(m);
        return [];
      case '322':
        (this.listed ??= []).push(m.params[1] ?? '');
        return [];
      case '323':
        return this.onListEnd();
      case '352':
        return this.onWhoReply(m);
      case '315':
        this.onWhoEnd(m.params[1] ?? '');
        return [];
      case '301':
        this.onAway(m.params[1] ?? '', toAway(m.params[2]), true);
        return [];
      default:
        return [];
    }
  }

  private onWelcome(m: IrcMessage): IrcMessage[] {
    this.nick = m.params[0] ?? this.nick;
    if (m.source) this.serverName = m.source;
    this.mentionRe = null;
    this.setStatus({ connected: true, needsLogin: false, error: null });
    const now = this.now();
    return [
      msg('LIST'),
      msg('CHATHISTORY', ['TARGETS', timestampParam(now - 7 * 86_400_000), timestampParam(now + 60_000), '50']),
    ];
  }

  // ---- batches ----

  private onBatch(m: IrcMessage): IrcMessage[] {
    const ref = m.params[0] ?? '';
    if (ref.startsWith('+')) {
      const id = ref.slice(1);
      this.batches.set(id, {
        id,
        type: m.params[1] ?? '',
        args: m.params.slice(2),
        parent: getTag(m, 'batch'),
        tags: m.tags,
        source: m.source,
        lines: [],
        count: 0,
        items: [],
      });
      return [];
    }
    if (!ref.startsWith('-')) return [];
    const id = ref.slice(1);
    const batch = this.batches.get(id);
    if (!batch) return [];
    this.batches.delete(id);
    if (batch.type === 'draft/multiline') return this.finishMultiline(batch);
    if (batch.type === 'chathistory') {
      const target = batch.args[0] ?? '';
      const t = this.targets.get(fold(target));
      if (batch.count === 0 && t) t.exhausted = true;
      if (batch.count > 0) this.emit({ type: 'history', target });
      this.onHistoryDone?.(target, batch.count);
      return [];
    }
    if (batch.type === 'draft/chathistory-targets') return this.finishTargets(batch);
    return [];
  }

  private isHistory(batchId: string | undefined): boolean {
    let id = batchId;
    for (let depth = 0; id !== undefined && depth < 8; depth += 1) {
      const b = this.batches.get(id);
      if (!b) return false;
      if (b.type === 'chathistory') return true;
      id = b.parent;
    }
    return false;
  }

  private noteHistory(batchId: string | undefined): void {
    let id = batchId;
    for (let depth = 0; id !== undefined && depth < 8; depth += 1) {
      const b = this.batches.get(id);
      if (!b) return;
      if (b.type === 'chathistory') {
        b.count += 1;
        return;
      }
      id = b.parent;
    }
  }

  private finishMultiline(batch: Batch): IrcMessage[] {
    const first = batch.lines[0];
    if (!first) return [];
    let text = '';
    batch.lines.forEach((line, index) => {
      if (index > 0 && !line.concat) text += '\n';
      text += line.text;
    });
    const open: IrcMessage = { tags: batch.tags, source: batch.source, command: first.command, params: [first.target, text] };
    const history = this.isHistory(batch.parent);
    const out = this.deliverChat(open, history);
    if (history) this.noteHistory(batch.parent);
    return out;
  }

  private finishTargets(batch: Batch): IrcMessage[] {
    const out: IrcMessage[] = [];
    for (const item of batch.items) {
      const name = item.target;
      if (isChannelName(name)) continue;
      if (fold(name) === fold(this.nick) || fold(name) === this.account) continue;
      out.push(...this.ensureDm(name));
    }
    return out;
  }

  private onChatHistoryLine(m: IrcMessage): IrcMessage[] {
    if ((m.params[0] ?? '').toUpperCase() !== 'TARGETS') return [];
    const id = getTag(m, 'batch');
    const batch = id === undefined ? undefined : this.batches.get(id);
    if (batch) batch.items.push({ target: m.params[1] ?? '' });
    return [];
  }

  // ---- chat lines ----

  private onChatLine(m: IrcMessage): IrcMessage[] {
    const source = m.source ?? '';
    // A server notice (answer to AGENT or CLAIMS) has no nick!user@host source.
    if (!source.includes('!')) return [];
    const batchId = getTag(m, 'batch');
    if (batchId !== undefined) {
      const batch = this.batches.get(batchId);
      if (batch?.type === 'draft/multiline') {
        batch.lines.push({
          command: m.command,
          target: m.params[0] ?? '',
          text: m.params[1] ?? '',
          concat: getTag(m, 'draft/multiline-concat') !== undefined,
        });
        return [];
      }
    }
    const history = this.isHistory(batchId);
    const out = this.deliverChat(m, history);
    if (history) this.noteHistory(batchId);
    return out;
  }

  private isSelf(from: string, account: string): boolean {
    if (from !== '' && fold(from) === fold(this.nick)) return true;
    return account !== '' && account.toLowerCase() === this.account;
  }

  private mentions(text: string): boolean {
    if (!this.mentionRe) {
      const names = ['operator', 'chamber\\d*'];
      if (this.nick) names.push(escapeRegExp(this.nick));
      this.mentionRe = new RegExp(`(^|[^\\w-])@?(${names.join('|')})(?![\\w-])`, 'i');
    }
    return this.mentionRe.test(text);
  }

  private deliverChat(m: IrcMessage, history: boolean): IrcMessage[] {
    const from = nickOf(m);
    const account = getTag(m, 'account') ?? '';
    let dest = m.params[0] ?? '';
    const text = m.params[1] ?? '';
    // Status prefix such as @#channel.
    if (/^[@+%&~][#&]/.test(dest)) dest = dest.slice(1);
    const self = this.isSelf(from, account);
    const out: IrcMessage[] = [];
    let target: string;
    let dmIn = false;
    const channelTarget = isChannelName(dest);
    if (channelTarget) {
      target = this.channels.get(fold(dest))?.name ?? dest;
    } else {
      const partner = self ? dest : from;
      if (partner === '' || fold(partner) === fold(this.nick) || fold(partner) === this.account) return out;
      target = this.dms.get(fold(partner)) ?? partner;
      dmIn = !self;
      out.push(...this.ensureDm(target));
    }
    // Backlog from CHATHISTORY has no role or broadcast tag: infer them from the account and the text.
    const roleTag = getTag(m, TAG_ROLE) ?? (history ? (account.toLowerCase() === this.account ? 'operator' : account !== '' ? 'agent' : '') : '');
    const role: Role = roleTag === 'operator' ? 'operator' : roleTag === 'agent' ? 'agent' : '';
    const bc = getTag(m, TAG_BROADCAST) ?? (history && channelTarget ? detectBroadcast(text) : '');
    const broadcast: Broadcast = bc === 'here' || bc === 'all' ? bc : '';
    const timeTag = getTag(m, 'time');
    const parsed = timeTag ? Date.parse(timeTag) : NaN;
    const kind: MessageKind = m.command === 'NOTICE' ? 'notice' : 'privmsg';
    const message: ChatMessage = {
      seq: 0,
      msgid: getTag(m, 'msgid') ?? '',
      time: Number.isNaN(parsed) ? this.now() : parsed,
      target,
      from,
      text,
      kind,
      role,
      broadcast,
      self,
      mention: !self && !history && (dmIn || broadcast !== '' || this.mentions(text)),
      history,
    };
    this.store(message, history);
    return out;
  }

  /** Make sure a DM target exists. Returns the CHATHISTORY request for a new target. */
  private ensureDm(name: string): IrcMessage[] {
    const key = fold(name);
    if (this.dms.has(key)) return [];
    this.dms.set(key, name);
    this.target(name);
    this.emit({ type: 'channels' });
    return [msg('CHATHISTORY', ['LATEST', name, '*', String(Math.min(this.backlog, 50))])];
  }

  private target(name: string): Target {
    const key = fold(name);
    let t = this.targets.get(key);
    if (!t) {
      t = { name, messages: [], ids: new Set(), systemCount: 0, exhausted: false, readSeq: 0 };
      this.targets.set(key, t);
    }
    return t;
  }

  private store(message: ChatMessage, history: boolean): void {
    const t = this.target(message.target);
    if (message.msgid !== '' && t.ids.has(message.msgid)) return;
    message.seq = ++this.seq;
    if (message.msgid !== '') t.ids.add(message.msgid);
    const system = message.kind !== 'privmsg' && message.kind !== 'notice';
    if (system) t.systemCount += 1;
    if (!history || t.messages.length === 0 || t.messages[t.messages.length - 1]!.time <= message.time) {
      t.messages.push(message);
    } else {
      let index = t.messages.length;
      while (index > 0 && t.messages[index - 1]!.time > message.time) index -= 1;
      t.messages.splice(index, 0, message);
    }
    if (system && t.systemCount > this.systemLimit) {
      const at = t.messages.findIndex((x) => x.kind !== 'privmsg' && x.kind !== 'notice');
      if (at !== -1) {
        t.messages.splice(at, 1);
        t.systemCount -= 1;
      }
    }
    while (t.messages.length > this.ringSize) {
      const old = t.messages.shift();
      if (!old) break;
      if (old.msgid !== '') t.ids.delete(old.msgid);
      if (old.kind !== 'privmsg' && old.kind !== 'notice') t.systemCount -= 1;
    }
    if (!history) this.pushEvent({ seq: message.seq, type: 'message', message });
  }

  private system(channel: string, kind: MessageKind, from: string, text: string): void {
    this.store(
      {
        seq: 0,
        msgid: '',
        time: this.now(),
        target: channel,
        from,
        text,
        kind,
        role: '',
        broadcast: '',
        self: false,
        mention: false,
        history: false,
      },
      false,
    );
  }

  // ---- membership ----

  private chan(name: string): Chan | undefined {
    return this.channels.get(fold(name));
  }

  private membersOf(chan: Chan): Member[] {
    return [...chan.members.values()].sort((a, b) => a.nick.localeCompare(b.nick));
  }

  private emitMembers(chan: Chan): void {
    this.emit({ type: 'members', channel: chan.name, members: this.membersOf(chan) });
  }

  private onJoin(m: IrcMessage): IrcMessage[] {
    const nick = nickOf(m);
    const name = m.params[0] ?? '';
    if (!name) return [];
    if (fold(nick) === fold(this.nick)) {
      const previous = this.chan(name);
      const chan: Chan = { name, topic: previous?.topic ?? '', members: new Map(), joined: true, namesOpen: false, whoDirty: false };
      this.channels.set(fold(name), chan);
      this.joinAttempts.delete(fold(name));
      this.target(name);
      this.emit({ type: 'channels' });
      return [
        msg('CHATHISTORY', ['LATEST', name, '*', String(this.backlog)]),
        msg('WHO', [name]),
      ];
    }
    const chan = this.chan(name);
    if (!chan) return [];
    chan.members.set(fold(nick), {
      nick,
      away: this.awayCache.get(fold(nick)) ?? null,
      op: false,
      operator: getTag(m, TAG_ROLE) === 'operator',
    });
    this.system(chan.name, 'join', nick, 'joined');
    this.emitMembers(chan);
    return [];
  }

  private onPart(nick: string, name: string, reason: string | undefined, kind: 'part'): void {
    const chan = this.chan(name);
    if (!chan) return;
    if (fold(nick) === fold(this.nick)) {
      this.channels.delete(fold(name));
      this.targets.delete(fold(name));
      this.emit({ type: 'channels' });
      return;
    }
    if (!chan.members.delete(fold(nick))) return;
    this.system(chan.name, kind, nick, reason ? `left (${reason})` : 'left');
    this.emitMembers(chan);
  }

  private onQuit(nick: string, reason: string | undefined): void {
    if (fold(nick) === fold(this.nick)) return;
    this.awayCache.delete(fold(nick));
    for (const chan of this.channels.values()) {
      if (!chan.members.delete(fold(nick))) continue;
      this.system(chan.name, 'quit', nick, reason ? `quit (${reason})` : 'quit');
      this.emitMembers(chan);
    }
  }

  private onNick(oldNick: string, newNick: string): void {
    if (!newNick) return;
    if (fold(oldNick) === fold(this.nick)) {
      this.nick = newNick;
      this.mentionRe = null;
    }
    const cached = this.awayCache.get(fold(oldNick));
    if (cached !== undefined) {
      this.awayCache.delete(fold(oldNick));
      this.awayCache.set(fold(newNick), cached);
    }
    for (const chan of this.channels.values()) {
      const member = chan.members.get(fold(oldNick));
      if (!member) continue;
      chan.members.delete(fold(oldNick));
      chan.members.set(fold(newNick), { ...member, nick: newNick });
      this.system(chan.name, 'nick', oldNick, `is now known as ${newNick}`);
      this.emitMembers(chan);
    }
  }

  private onAway(nick: string, away: Away, quiet = false): void {
    if (!nick) return;
    if (away === null) this.awayCache.delete(fold(nick));
    else this.awayCache.set(fold(nick), away);
    for (const chan of this.channels.values()) {
      const member = chan.members.get(fold(nick));
      if (!member || member.away === away) continue;
      member.away = away;
      if (!quiet) this.system(chan.name, 'away', nick, away === null ? 'is active' : `is ${away}`);
      this.emitMembers(chan);
    }
  }

  private onTopic(nick: string, name: string, topic: string): void {
    const chan = this.setTopic(name, topic);
    if (chan) this.system(chan.name, 'topic', nick, topic === '' ? 'cleared the topic' : `set the topic: ${topic}`);
  }

  private setTopic(name: string, topic: string): Chan | undefined {
    const chan = this.chan(name);
    if (!chan) return undefined;
    chan.topic = topic;
    this.emit({ type: 'topic', channel: chan.name, topic });
    return chan;
  }

  private onNames(m: IrcMessage): void {
    const chan = this.chan(m.params[2] ?? '');
    if (!chan) return;
    if (!chan.namesOpen) {
      chan.members.clear();
      chan.namesOpen = true;
    }
    for (const raw of (m.params[3] ?? '').split(' ')) {
      if (raw === '') continue;
      const prefix = /^[~&@%+]*/.exec(raw)?.[0] ?? '';
      const nick = raw.slice(prefix.length);
      if (!nick) continue;
      chan.members.set(fold(nick), {
        nick,
        away: this.awayCache.get(fold(nick)) ?? null,
        op: /[~&@]/.test(prefix),
        operator: false,
      });
    }
    this.emitMembers(chan);
  }

  private onWhoReply(m: IrcMessage): IrcMessage[] {
    const chan = this.chan(m.params[1] ?? '');
    if (!chan) return [];
    const nick = m.params[5] ?? '';
    const flags = m.params[6] ?? '';
    const member = chan.members.get(fold(nick));
    if (!member) return [];
    const gone = flags.startsWith('G');
    const operator = flags.includes('*');
    const op = /[~&@]/.test(flags);
    let away: Away = null;
    let ask = false;
    if (gone) {
      const known = this.awayCache.get(fold(nick));
      away = known ?? member.away ?? 'idle';
      // WHO does not tell the reason. Ask WHOIS once for a nick that we do not know.
      ask = known === undefined;
      this.awayCache.set(fold(nick), away);
    } else {
      this.awayCache.delete(fold(nick));
    }
    if (member.away !== away || member.operator !== operator || member.op !== op) {
      member.away = away;
      member.operator = operator;
      member.op = op;
      chan.whoDirty = true;
    }
    return ask ? [msg('WHOIS', [nick])] : [];
  }

  private onWhoEnd(mask: string): void {
    const chan = this.chan(mask);
    if (!chan || !chan.whoDirty) return;
    chan.whoDirty = false;
    this.emitMembers(chan);
  }

  private onListEnd(): IrcMessage[] {
    const listed = this.listed ?? [];
    this.listed = null;
    const now = this.now();
    const missing = listed.filter((name) => {
      if (!isChannelName(name) || this.channels.get(fold(name))?.joined) return false;
      const last = this.joinAttempts.get(fold(name)) ?? 0;
      return now - last > 20_000;
    });
    for (const name of missing) this.joinAttempts.set(fold(name), now);
    return joinNames(missing).map((names) => msg('JOIN', [names]));
  }

  // ---- queries ----

  channelNames(): string[] {
    return [...this.channels.values()].map((c) => c.name);
  }

  hasChannel(name: string): boolean {
    return this.channels.has(fold(name));
  }

  members(channel: string): Member[] {
    const chan = this.chan(channel);
    return chan ? this.membersOf(chan) : [];
  }

  topic(channel: string): string {
    return this.chan(channel)?.topic ?? '';
  }

  dmNames(): string[] {
    return [...this.dms.values()].sort((a, b) => a.localeCompare(b));
  }

  addDm(name: string): IrcMessage[] {
    return this.ensureDm(name);
  }

  messageCount(target: string): number {
    return this.targets.get(fold(target))?.messages.length ?? 0;
  }

  oldestMsgid(target: string): string | undefined {
    return this.targets.get(fold(target))?.messages.find((x) => x.msgid !== '')?.msgid;
  }

  isExhausted(target: string): boolean {
    return this.targets.get(fold(target))?.exhausted ?? false;
  }

  unreadFor(target: Target): UnreadInfo {
    let unread = 0;
    let mentions = 0;
    for (const message of target.messages) {
      if (message.seq <= target.readSeq || message.self || message.history) continue;
      if (message.kind !== 'privmsg' && message.kind !== 'notice') continue;
      unread += 1;
      if (message.mention) mentions += 1;
    }
    return { unread, mentions };
  }

  markRead(target: string, seq: number): void {
    const t = this.targets.get(fold(target));
    if (t && seq > t.readSeq) t.readSeq = seq;
  }

  snapshot(): StateResponse {
    const channels: ChannelInfo[] = [...this.channels.values()]
      .sort((a, b) => {
        if (a.name === '#lobby') return -1;
        if (b.name === '#lobby') return 1;
        return a.name.localeCompare(b.name);
      })
      .map((c) => ({ name: c.name, topic: c.topic, members: this.membersOf(c) }));
    const unread: Record<string, UnreadInfo> = {};
    const last: Record<string, number> = {};
    for (const t of this.targets.values()) {
      const info = this.unreadFor(t);
      if (info.unread > 0) unread[t.name] = info;
      const tail = t.messages.filter((x) => x.kind === 'privmsg' || x.kind === 'notice').pop();
      if (tail) last[t.name] = tail.time;
    }
    return {
      epoch: this.epoch,
      connected: this.connected,
      needsLogin: this.needsLogin,
      nick: this.nick,
      error: this.error,
      channels,
      dms: this.dmNames(),
      unread,
      last,
      seq: this.seq,
    };
  }

  page(target: string, before: number | null, limit: number, maxBytes = 200_000): MessagesResponse {
    const t = this.targets.get(fold(target));
    const list = t?.messages ?? [];
    let end = list.length;
    if (before !== null) {
      const at = list.findIndex((x) => x.seq === before);
      end = at !== -1 ? at : list.filter((x) => x.seq < before).length;
    }
    let start = Math.max(0, end - limit);
    let slice = list.slice(start, end);
    let size = slice.reduce((sum, x) => sum + x.text.length + 300, 0);
    while (size > maxBytes && slice.length > 1) {
      const dropped = slice[0]!;
      size -= dropped.text.length + 300;
      slice = slice.slice(1);
      start += 1;
    }
    return {
      epoch: this.epoch,
      target: t?.name ?? target,
      messages: slice,
      hasMore: start > 0 || !(t?.exhausted ?? false),
      seq: this.seq,
    };
  }

  // ---- events ----

  private emit(event: DistributiveOmit<ServiceEvent, 'seq'>): void {
    this.pushEvent({ ...event, seq: ++this.seq } as ServiceEvent);
  }

  private pushEvent(event: ServiceEvent): void {
    this.events.push(event);
    while (this.events.length > this.eventLogSize) {
      const old = this.events.shift();
      if (old) this.droppedThrough = old.seq;
    }
    for (const waiter of [...this.waiters]) {
      if (event.seq > waiter.after) waiter.wake();
    }
  }

  private collect(after: number): EventsResponse {
    let from = this.events.length;
    while (from > 0 && this.events[from - 1]!.seq > after) from -= 1;
    const out: ServiceEvent[] = [];
    let size = 0;
    let truncated = false;
    for (let i = from; i < this.events.length; i += 1) {
      const event = this.events[i]!;
      const bytes = JSON.stringify(event).length;
      if (out.length >= 300 || (out.length > 0 && size + bytes > 200_000)) {
        truncated = true;
        break;
      }
      out.push(event);
      size += bytes;
    }
    const last = out[out.length - 1];
    return { epoch: this.epoch, seq: truncated && last ? last.seq : this.seq, events: out };
  }

  /** Long poll. Resolves at once when events exist after `after`, else when one arrives or after `waitMs`. */
  poll(after: number, epoch: string | null, waitMs: number, signal?: AbortSignal): Promise<EventsResponse> {
    const stale = (epoch !== null && epoch !== '' && epoch !== this.epoch) || after > this.seq || after < this.droppedThrough;
    if (stale) return Promise.resolve({ epoch: this.epoch, seq: this.seq, events: [], reset: true });
    const ready = this.events.length > 0 && this.events[this.events.length - 1]!.seq > after;
    if (ready || waitMs <= 0 || signal?.aborted) return Promise.resolve(this.collect(after));
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        after,
        wake: () => finish(),
      };
      const finish = (): void => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', finish);
        resolve(this.collect(after));
      };
      this.waiters.add(waiter);
      timer = setTimeout(finish, waitMs);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
