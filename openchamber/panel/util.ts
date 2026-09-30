// Pure helpers for the panel. No DOM access, so bun can test them.
import type { Away, ChannelInfo, Member, UnreadInfo } from '../shared/types.ts';

export const fold = (s: string): string => s.toLowerCase();

/** Stable hue for a nick. */
export const nickHue = (nick: string): number => {
  let hash = 0;
  for (let i = 0; i < nick.length; i += 1) hash = (hash * 31 + nick.charCodeAt(i)) >>> 0;
  return hash % 360;
};

export const nickColor = (nick: string, dark: boolean): string => `hsl(${nickHue(nick)}, 65%, ${dark ? 70 : 36}%)`;

export const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

export const formatClock = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

export const formatDay = (ms: number, now = Date.now()): string => {
  if (dayKey(ms) === dayKey(now)) return 'Today';
  if (dayKey(ms) === dayKey(now - 86_400_000)) return 'Yesterday';
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

export const formatDuration = (seconds: number): string => {
  if (seconds <= 0) return 'now';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
};

export const awayRank = (away: Away): number => (away === null ? 0 : away === 'idle' ? 1 : 2);

/** Busy first, then idle, then dormant. Humans last inside a group. Then by name. */
export const sortMembers = (members: Member[]): Member[] =>
  [...members].sort(
    (a, b) =>
      awayRank(a.away) - awayRank(b.away) ||
      Number(a.operator) - Number(b.operator) ||
      a.nick.localeCompare(b.nick, undefined, { sensitivity: 'base' }),
  );

/** Agents that are not away. The human operator and the own nick do not count. */
export const awakeCount = (members: Member[], me: string): number =>
  members.filter((m) => m.away === null && !m.operator && fold(m.nick) !== fold(me)).length;

export type SectionId = 'lobby' | 'projects' | 'families' | 'dms';

export interface SidebarItem {
  target: string;
  kind: 'channel' | 'dm';
  label: string;
  unread: number;
  mentions: number;
  awake: number | null;
}

export interface SidebarSection {
  id: SectionId;
  title: string;
  items: SidebarItem[];
}

const NO_UNREAD: UnreadInfo = { unread: 0, mentions: 0 };

/**
 * Group channels: Lobby, Projects, Families (the channel name is the nick of a member), Direct messages.
 */
export const groupTargets = (
  channels: ChannelInfo[],
  dms: string[],
  unread: Map<string, UnreadInfo>,
  me: string,
): SidebarSection[] => {
  const nicks = new Set<string>();
  for (const channel of channels) for (const member of channel.members) nicks.add(fold(member.nick));
  const sections: SidebarSection[] = [
    { id: 'lobby', title: 'Lobby', items: [] },
    { id: 'projects', title: 'Projects', items: [] },
    { id: 'families', title: 'Families', items: [] },
    { id: 'dms', title: 'Direct messages', items: [] },
  ];
  const by = (id: SectionId): SidebarSection => sections.find((s) => s.id === id)!;
  for (const channel of [...channels].sort((a, b) => a.name.localeCompare(b.name))) {
    const info = unread.get(channel.name) ?? NO_UNREAD;
    const item: SidebarItem = {
      target: channel.name,
      kind: 'channel',
      label: channel.name,
      unread: info.unread,
      mentions: info.mentions,
      awake: awakeCount(channel.members, me),
    };
    const bare = fold(channel.name.replace(/^[#&]/, ''));
    if (fold(channel.name) === '#lobby') by('lobby').items.push(item);
    else if (nicks.has(bare)) by('families').items.push(item);
    else by('projects').items.push(item);
  }
  for (const name of [...dms].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
    const info = unread.get(name) ?? NO_UNREAD;
    by('dms').items.push({ target: name, kind: 'dm', label: name, unread: info.unread, mentions: info.mentions, awake: null });
  }
  return sections.filter((s) => s.items.length > 0 || s.id === 'dms');
};

/** Nick completion for the Tab key. */
export interface Completion {
  text: string;
  caret: number;
}

export const wordBefore = (text: string, caret: number): { start: number; word: string } => {
  let start = caret;
  while (start > 0 && !/\s/.test(text.charAt(start - 1))) start -= 1;
  return { start, word: text.slice(start, caret) };
};

export const completionCandidates = (word: string, nicks: string[]): string[] => {
  const bare = word.replace(/^@/, '').toLowerCase();
  if (bare === '') return [];
  return nicks
    .filter((n) => n.toLowerCase().startsWith(bare))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
};

export const applyCompletion = (text: string, start: number, end: number, nick: string): Completion => {
  const atLineStart = text.slice(0, start).trim() === '' || text.charAt(start - 1) === '\n';
  const suffix = atLineStart ? ': ' : ' ';
  const before = text.slice(0, start);
  const after = text.slice(end).replace(/^[: ]/, '');
  const next = `${before}${nick}${suffix}${after}`;
  return { text: next, caret: before.length + nick.length + suffix.length };
};

/** Split text into plain parts and mention parts for highlighting. */
export const splitMentions = (text: string, me: string): Array<{ text: string; kind: 'text' | 'me' | 'broadcast' }> => {
  const escaped = me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = ['operator', 'chamber\\d*'];
  if (me !== '') names.push(escaped);
  const re = new RegExp(`(^|[^\\w-])(@?(?:${names.join('|')})|@here|@all)(?![\\w-])`, 'gi');
  const parts: Array<{ text: string; kind: 'text' | 'me' | 'broadcast' }> = [];
  let last = 0;
  for (const match of text.matchAll(re)) {
    const lead = match[1] ?? '';
    const token = match[2] ?? '';
    const start = (match.index ?? 0) + lead.length;
    if (start > last) parts.push({ text: text.slice(last, start), kind: 'text' });
    const lower = token.toLowerCase();
    parts.push({ text: token, kind: lower === '@here' || lower === '@all' ? 'broadcast' : 'me' });
    last = start + token.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), kind: 'text' });
  return parts.length > 0 ? parts : [{ text, kind: 'text' }];
};

export const isLong = (text: string): boolean => text.length > 700 || text.split('\n').length > 14;
