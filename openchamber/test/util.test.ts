import { describe, expect, test } from 'bun:test';
import {
  applyCompletion,
  awakeCount,
  completionCandidates,
  formatDuration,
  groupTargets,
  nickColor,
  sortMembers,
  splitMentions,
  wordBefore,
} from '../panel/util.ts';
import type { ChannelInfo, Member, UnreadInfo } from '../shared/types.ts';
import { chunkText, parseClaim, planSend, validateTarget } from '../service/client.ts';
import { parseBind, parseToml } from '../service/config.ts';

const member = (nick: string, away: Member['away'] = null, operator = false): Member => ({ nick, away, op: false, operator });

describe('panel helpers', () => {
  test('nick color is stable and differs per theme', () => {
    expect(nickColor('fix-auth', true)).toBe(nickColor('fix-auth', true));
    expect(nickColor('fix-auth', true)).not.toBe(nickColor('fix-auth', false));
    expect(nickColor('a', true)).not.toBe(nickColor('b', true));
  });

  test('sort members: busy, idle, dormant; humans last in a group', () => {
    const sorted = sortMembers([member('zed', 'dormant'), member('bob', 'idle'), member('al'), member('human', null, true), member('cy')]);
    expect(sorted.map((m) => m.nick)).toEqual(['al', 'cy', 'human', 'bob', 'zed']);
  });

  test('awake count skips away agents, the operator and me', () => {
    expect(awakeCount([member('a'), member('b', 'idle'), member('chamber'), member('h', null, true)], 'chamber')).toBe(1);
  });

  test('group targets into lobby, projects, families and DMs', () => {
    const channels: ChannelInfo[] = [
      { name: '#lobby', topic: '', members: [member('fix-auth'), member('chamber')] },
      { name: '#proj-x', topic: '', members: [member('fix-auth')] },
      { name: '#fix-auth', topic: '', members: [member('fix-auth'), member('fix-auth|t1', 'idle')] },
    ];
    const unread = new Map<string, UnreadInfo>([['#proj-x', { unread: 3, mentions: 1 }]]);
    const sections = groupTargets(channels, ['docs-bot'], unread, 'chamber');
    expect(sections.map((s) => [s.id, s.items.map((i) => i.target)])).toEqual([
      ['lobby', ['#lobby']],
      ['projects', ['#proj-x']],
      ['families', ['#fix-auth']],
      ['dms', ['docs-bot']],
    ]);
    expect(sections[1]?.items[0]).toMatchObject({ unread: 3, mentions: 1, awake: 1 });
    expect(sections[3]?.items[0]?.awake).toBeNull();
    // The DM section stays, so the new-DM button has a place.
    expect(groupTargets([], [], new Map(), 'chamber').map((s) => s.id)).toEqual(['dms']);
  });

  test('nick completion', () => {
    const text = 'hello fix';
    const { start, word } = wordBefore(text, text.length);
    expect(word).toBe('fix');
    const nicks = ['fix-auth', 'fix-bug', 'docs-bot'];
    expect(completionCandidates(word, nicks)).toEqual(['fix-auth', 'fix-bug']);
    expect(completionCandidates('@doc', nicks)).toEqual(['docs-bot']);
    expect(completionCandidates('', nicks)).toEqual([]);
    expect(applyCompletion(text, start, text.length, 'fix-auth')).toEqual({ text: 'hello fix-auth ', caret: 15 });
    expect(applyCompletion('fi', 0, 2, 'fix-auth')).toEqual({ text: 'fix-auth: ', caret: 10 });
  });

  test('mention highlight parts', () => {
    const parts = splitMentions('hey operator, and @here please; chamber2! not xoperator', 'chamber');
    expect(parts.filter((p) => p.kind !== 'text').map((p) => [p.text, p.kind])).toEqual([
      ['operator', 'me'],
      ['@here', 'broadcast'],
      ['chamber2', 'me'],
    ]);
    expect(parts.map((p) => p.text).join('')).toBe('hey operator, and @here please; chamber2! not xoperator');
  });

  test('duration', () => {
    expect(formatDuration(-1)).toBe('now');
    expect(formatDuration(30)).toBe('30s');
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(7200)).toBe('2h');
  });
});

describe('service helpers', () => {
  test('chunkText keeps characters whole and respects the byte limit', () => {
    const text = 'é'.repeat(300) + '😀'.repeat(50);
    const chunks = chunkText(text, 101);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(101);
  });

  test('planSend: single line, multiline, long line, and invalid input', () => {
    const single = planSend('#lobby', 'hello', 'r1');
    expect(single).toMatchObject({ batch: false });
    const multi = planSend('#lobby', 'a\n\nb', 'r1');
    if (typeof multi === 'string') throw new Error(multi);
    expect(multi.batch).toBe(true);
    expect(multi.lines.map((l) => l.command)).toEqual(['BATCH', 'PRIVMSG', 'PRIVMSG', 'PRIVMSG', 'BATCH']);
    const long = planSend('#lobby', 'x'.repeat(1000), 'r1');
    if (typeof long === 'string') throw new Error(long);
    const bodies = long.lines.filter((l) => l.command === 'PRIVMSG');
    expect(bodies.length).toBeGreaterThan(2);
    expect(bodies[0]?.tags.some(([k]) => k === 'draft/multiline-concat')).toBe(false);
    expect(bodies[1]?.tags.some(([k]) => k === 'draft/multiline-concat')).toBe(true);
    expect(planSend('#lobby', '  ', 'r')).toMatch(/empty/);
    expect(planSend('#lobby', 'a\rb', 'r')).toMatch(/carriage/);
    expect(planSend('#lobby', 'a\u0000b', 'r')).toMatch(/NUL/);
    expect(planSend('#lobby', 'x'.repeat(16385), 'r')).toMatch(/longer/);
    expect(planSend('#lobby', Array(201).fill('l').join('\n'), 'r')).toMatch(/too many lines/);
    expect(planSend('bad target', 'hi', 'r')).toMatch(/Invalid target/);
  });

  test('validateTarget', () => {
    expect(validateTarget('#lobby')).toBeNull();
    expect(validateTarget('fix-auth|t1')).toBeNull();
    expect(validateTarget('')).not.toBeNull();
    expect(validateTarget('a,b')).not.toBeNull();
    expect(validateTarget(':x')).not.toBeNull();
  });

  test('parseClaim', () => {
    expect(parseClaim('fix-auth holds /a b/c.rs since 100 until 700')).toEqual({ nick: 'fix-auth', path: '/a b/c.rs', since: 100, until: 700 });
    expect(parseClaim('end of CLAIMS')).toBeNull();
  });

  test('config parsing', () => {
    const toml = parseToml('server_name = "irc.x"\nbind = "0.0.0.0:6667"\n# c\n[limits]\nmax = 5\n[tls]\ncert = "/a/b.pem" # note\nkey = \'/a/k.pem\'\n');
    expect(toml).toMatchObject({ server_name: 'irc.x', bind: '0.0.0.0:6667', 'tls.cert': '/a/b.pem', 'tls.key': '/a/k.pem' });
    expect(parseBind('0.0.0.0:6667')).toEqual({ host: '127.0.0.1', port: 6667 });
    expect(parseBind('[::]:7000')).toEqual({ host: '127.0.0.1', port: 7000 });
    expect(parseBind('10.1.2.3:6697')).toEqual({ host: '10.1.2.3', port: 6697 });
    expect(parseBind('nonsense')).toBeNull();
  });
});
