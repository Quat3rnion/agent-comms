import { describe, expect, test } from 'bun:test';
import { parseLine, serializeLine } from '../../plugin/src/proto.ts';
import { ChamberState } from '../service/state.ts';

const SERVER = ':irc.agent-comms.local';
const ME = 'chamber!operator@127.0.0.1';

/** Feed raw IRC lines into the state and return the lines that it wants to send. */
const feed = (state: ChamberState, ...lines: string[]): string[] =>
  lines.flatMap((line) => state.handleLine(parseLine(line)).map((m) => serializeLine(m)));

const ready = (options: ConstructorParameters<typeof ChamberState>[0] = {}): ChamberState => {
  const state = new ChamberState(options);
  feed(state, `${SERVER} 001 chamber :Welcome`);
  return state;
};

const joinLobby = (state: ChamberState): string[] =>
  feed(
    state,
    `:${ME} JOIN #lobby`,
    `${SERVER} 353 chamber = #lobby :@fix-auth chamber busy-one`,
    `${SERVER} 366 chamber #lobby :End of /NAMES list`,
  );

const agentTags = (id: string, time = '2026-09-30T10:00:00.000Z', extra = ''): string =>
  `@time=${time};msgid=${id};account=ses_a;agent-comms.local/role=agent${extra}`;

describe('connection', () => {
  test('welcome sets nick and asks for LIST and DM targets', () => {
    const state = new ChamberState();
    const out = feed(state, `${SERVER} 001 chamber2 :Welcome`);
    expect(state.connected).toBe(true);
    expect(state.nick).toBe('chamber2');
    expect(out[0]).toBe('LIST');
    expect(out[1]).toMatch(/^CHATHISTORY TARGETS timestamp=.* timestamp=.* 50$/);
    expect(state.snapshot().connected).toBe(true);
  });

  test('status changes make events and disconnect keeps messages', () => {
    const state = ready();
    joinLobby(state);
    feed(state, `${agentTags('m1')} :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :hello`);
    state.onDisconnected();
    expect(state.snapshot().connected).toBe(false);
    expect(state.page('#lobby', null, 10).messages.map((m) => m.text)).toEqual(['hello']);
  });
});

describe('channels and members', () => {
  test('own JOIN asks for backlog and WHO; NAMES fills members', () => {
    const state = ready();
    const out = joinLobby(state);
    expect(out).toEqual(['CHATHISTORY LATEST #lobby * 100', 'WHO #lobby']);
    const members = state.members('#lobby');
    expect(members.map((m) => m.nick)).toEqual(['busy-one', 'chamber', 'fix-auth']);
    expect(members.find((m) => m.nick === 'fix-auth')?.op).toBe(true);
    expect(state.snapshot().channels.map((c) => c.name)).toEqual(['#lobby']);
  });

  test('JOIN, PART, QUIT and NICK of others change members and add system lines', () => {
    const state = ready();
    joinLobby(state);
    feed(state, ':new-agent!ses_c@agent-comms.local JOIN #lobby');
    expect(state.members('#lobby').some((m) => m.nick === 'new-agent')).toBe(true);
    feed(state, ':new-agent!ses_c@agent-comms.local NICK :renamed');
    expect(state.members('#lobby').map((m) => m.nick)).toContain('renamed');
    feed(state, ':renamed!ses_c@agent-comms.local PART #lobby :done');
    expect(state.members('#lobby').map((m) => m.nick)).not.toContain('renamed');
    feed(state, ':busy-one!ses_d@agent-comms.local QUIT :retired');
    expect(state.members('#lobby').map((m) => m.nick)).not.toContain('busy-one');
    const kinds = state.page('#lobby', null, 50).messages.map((m) => `${m.kind}:${m.from}:${m.text}`);
    expect(kinds).toEqual([
      'join:new-agent:joined',
      'nick:new-agent:is now known as renamed',
      'part:renamed:left (done)',
      'quit:busy-one:quit (retired)',
    ]);
  });

  test('AWAY sets idle or dormant and clears; unchanged AWAY is silent', () => {
    const state = ready();
    joinLobby(state);
    const awayOf = (): string | null => state.members('#lobby').find((m) => m.nick === 'fix-auth')?.away ?? null;
    feed(state, ':fix-auth!ses_a@agent-comms.local AWAY idle');
    expect(awayOf()).toBe('idle');
    feed(state, ':fix-auth!ses_a@agent-comms.local AWAY dormant');
    expect(awayOf()).toBe('dormant');
    feed(state, ':fix-auth!ses_a@agent-comms.local AWAY dormant');
    feed(state, ':fix-auth!ses_a@agent-comms.local AWAY');
    expect(awayOf()).toBeNull();
    const texts = state.page('#lobby', null, 50).messages.filter((m) => m.kind === 'away').map((m) => m.text);
    expect(texts).toEqual(['is idle', 'is dormant', 'is active']);
  });

  test('WHO marks G as away and asks WHOIS once; 301 gives the reason', () => {
    const state = ready();
    joinLobby(state);
    const who = `${SERVER} 352 chamber #lobby ses_a agent-comms.local irc.agent-comms.local fix-auth G 0 :title`;
    expect(feed(state, who)).toEqual(['WHOIS fix-auth']);
    expect(feed(state, who)).toEqual([]);
    feed(state, `${SERVER} 315 chamber #lobby :End of WHO list`);
    expect(state.members('#lobby').find((m) => m.nick === 'fix-auth')?.away).toBe('idle');
    feed(state, `${SERVER} 301 chamber fix-auth :dormant`);
    expect(state.members('#lobby').find((m) => m.nick === 'fix-auth')?.away).toBe('dormant');
    // H clears it, and the * flag marks the human operator.
    feed(state, `${SERVER} 352 chamber #lobby operator 127.0.0.1 irc.agent-comms.local fix-auth H*@ 0 :x`);
    const m = state.members('#lobby').find((x) => x.nick === 'fix-auth');
    expect(m).toMatchObject({ away: null, operator: true, op: true });
  });

  test('LIST joins unknown channels once in a while', () => {
    let now = 1_000_000;
    const state = ready({ now: () => now });
    joinLobby(state);
    const list = [`${SERVER} 322 chamber #lobby 3 :`, `${SERVER} 322 chamber #proj-a 1 :`, `${SERVER} 322 chamber #proj-b 1 :`, `${SERVER} 323 chamber :End of /LIST`];
    expect(feed(state, ...list)).toEqual(['JOIN #proj-a,#proj-b']);
    now += 5000;
    expect(feed(state, ...list)).toEqual([]);
    now += 30_000;
    expect(feed(state, ...list)).toEqual(['JOIN #proj-a,#proj-b']);
  });

  test('after a disconnect, LIST makes the state join the channels again', () => {
    const state = ready();
    joinLobby(state);
    state.onDisconnected();
    feed(state, `${SERVER} 001 chamber :Welcome`);
    expect(state.snapshot().channels.map((c) => c.name)).toEqual(['#lobby']);
    expect(feed(state, `${SERVER} 322 chamber #lobby 3 :`, `${SERVER} 323 chamber :End of /LIST`)).toEqual(['JOIN #lobby']);
    // The server confirms the JOIN: no more requests.
    joinLobby(state);
    expect(feed(state, `${SERVER} 322 chamber #lobby 3 :`, `${SERVER} 323 chamber :End of /LIST`)).toEqual([]);
  });

  test('topic from 332 and TOPIC', () => {
    const state = ready();
    joinLobby(state);
    feed(state, `${SERVER} 332 chamber #lobby :Welcome all`);
    expect(state.topic('#lobby')).toBe('Welcome all');
    feed(state, ':fix-auth!ses_a@agent-comms.local TOPIC #lobby :New topic');
    expect(state.topic('#lobby')).toBe('New topic');
  });

  test('own PART removes the channel', () => {
    const state = ready();
    joinLobby(state);
    feed(state, `:${ME} PART #lobby`);
    expect(state.snapshot().channels).toEqual([]);
  });
});

describe('messages', () => {
  test('PRIVMSG with tags: role, broadcast, mention, time, msgid', () => {
    const state = ready();
    joinLobby(state);
    feed(
      state,
      `${agentTags('m1', '2026-09-30T10:00:00.000Z')} :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :plain chatter`,
      `${agentTags('m2', '2026-09-30T10:00:01.000Z', ';agent-comms.local/broadcast=here')} :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :@here anyone?`,
      `${agentTags('m3', '2026-09-30T10:00:02.000Z')} :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :operator: please look`,
      `${agentTags('m4', '2026-09-30T10:00:03.000Z')} :fix-auth!ses_a@agent-comms.local NOTICE #lobby :done`,
    );
    const messages = state.page('#lobby', null, 10).messages;
    expect(messages.map((m) => [m.msgid, m.kind, m.role, m.broadcast, m.mention, m.self])).toEqual([
      ['m1', 'privmsg', 'agent', '', false, false],
      ['m2', 'privmsg', 'agent', 'here', true, false],
      ['m3', 'privmsg', 'agent', '', true, false],
      ['m4', 'notice', 'agent', '', false, false],
    ]);
    expect(messages[0]?.time).toBe(Date.parse('2026-09-30T10:00:00.000Z'));
    expect(state.snapshot().unread['#lobby']).toEqual({ unread: 4, mentions: 2 });
    state.markRead('#lobby', messages[2]!.seq);
    expect(state.snapshot().unread['#lobby']).toEqual({ unread: 1, mentions: 0 });
  });

  test('own echo is a self message with the operator role', () => {
    const state = ready();
    joinLobby(state);
    feed(state, `@time=2026-09-30T10:00:00.000Z;msgid=e1;account=operator;agent-comms.local/role=operator :${ME} PRIVMSG #lobby :hi all`);
    const [m] = state.page('#lobby', null, 10).messages;
    expect(m).toMatchObject({ self: true, role: 'operator', mention: false });
    expect(state.snapshot().unread['#lobby']).toBeUndefined();
  });

  test('message from another operator connection is a self message too', () => {
    const state = ready();
    joinLobby(state);
    feed(state, '@msgid=e2;account=operator :alice!operator@host PRIVMSG #lobby :from weechat');
    expect(state.page('#lobby', null, 10).messages[0]?.self).toBe(true);
  });

  test('multiline batch becomes one message; concat lines join without newline', () => {
    const state = ready();
    joinLobby(state);
    const out = feed(
      state,
      `@time=2026-09-30T10:00:00.000Z;msgid=ml1;account=ses_a;agent-comms.local/role=agent :fix-auth!ses_a@agent-comms.local BATCH +b1 draft/multiline #lobby`,
      '@batch=b1 :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :line one',
      '@batch=b1 :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :',
      '@batch=b1 :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :line three',
      '@batch=b1;draft/multiline-concat :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby : continues',
      `${SERVER} BATCH -b1`,
    );
    expect(out).toEqual([]);
    const messages = state.page('#lobby', null, 10).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ msgid: 'ml1', text: 'line one\n\nline three continues', from: 'fix-auth', role: 'agent' });
  });

  test('chathistory batch: history flag, no events, dedupe with live messages, sorted by time', () => {
    const state = ready();
    joinLobby(state);
    feed(state, `${agentTags('live1', '2026-09-30T10:05:00.000Z')} :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :live`);
    const seqBefore = state.seq;
    const done: Array<[string, number]> = [];
    state.onHistoryDone = (t, n) => done.push([t, n]);
    feed(
      state,
      `${SERVER} BATCH +h1 chathistory #lobby`,
      '@batch=h1;time=2026-09-30T10:01:00.000Z;msgid=old1;account=ses_a :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :old one',
      '@batch=h1;time=2026-09-30T10:02:00.000Z;msgid=old2;account=ses_a :fix-auth!ses_a@agent-comms.local BATCH +ml draft/multiline #lobby',
      '@batch=ml :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :old',
      '@batch=ml :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :two',
      `${SERVER} BATCH -ml`,
      '@batch=h1;time=2026-09-30T10:05:00.000Z;msgid=live1;account=ses_a :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :live',
      `${SERVER} BATCH -h1`,
    );
    const messages = state.page('#lobby', null, 10).messages;
    expect(messages.map((m) => m.text)).toEqual(['old one', 'old\ntwo', 'live']);
    expect(messages.map((m) => m.history)).toEqual([true, true, false]);
    expect(done).toEqual([['#lobby', 3]]);
    expect(state.page('#lobby', null, 10, 1e9).hasMore).toBe(true);
    // No event for backlog messages except one "history" event.
    return state.poll(seqBefore, null, 0).then((r) => {
      expect(r.events.map((e) => e.type)).toEqual(['history']);
      // Empty batch marks the target as exhausted.
      feed(state, `${SERVER} BATCH +h2 chathistory #lobby`, `${SERVER} BATCH -h2`);
      expect(state.isExhausted('#lobby')).toBe(true);
      expect(state.page('#lobby', null, 10).hasMore).toBe(false);
    });
  });

  test('backlog without vendor tags gets role and broadcast from account and text', () => {
    const state = ready();
    joinLobby(state);
    feed(
      state,
      `${SERVER} BATCH +h1 chathistory #lobby`,
      '@batch=h1;time=2026-09-30T10:01:00.000Z;msgid=o1;account=ses_a :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :@here news',
      '@batch=h1;time=2026-09-30T10:02:00.000Z;msgid=o2;account=operator :alice!operator@host PRIVMSG #lobby :hello @all',
      '@batch=h1;time=2026-09-30T10:03:00.000Z;msgid=o3;account=ses_a :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :mail me@here.com',
      `${SERVER} BATCH -h1`,
    );
    const rows = state.page('#lobby', null, 10).messages.map((m) => [m.role, m.broadcast]);
    expect(rows).toEqual([['agent', 'here'], ['operator', 'all'], ['agent', '']]);
  });

  test('direct messages: incoming, outgoing echo, history request for a new partner', () => {
    const state = ready();
    const out = feed(state, `${agentTags('d1')} :fix-auth!ses_a@agent-comms.local PRIVMSG chamber :need input`);
    expect(out).toEqual(['CHATHISTORY LATEST fix-auth * 50']);
    feed(state, `@time=2026-09-30T10:00:05.000Z;msgid=d2;account=operator :${ME} PRIVMSG fix-auth :ok`);
    const snapshot = state.snapshot();
    expect(snapshot.dms).toEqual(['fix-auth']);
    const messages = state.page('fix-auth', null, 10).messages;
    expect(messages.map((m) => [m.text, m.self, m.mention])).toEqual([
      ['need input', false, true],
      ['ok', true, false],
    ]);
    expect(snapshot.unread['fix-auth']).toEqual({ unread: 1, mentions: 1 });
  });

  test('CHATHISTORY TARGETS batch discovers DM partners but not channels or self', () => {
    const state = ready();
    const out = feed(
      state,
      `${SERVER} BATCH +t1 draft/chathistory-targets`,
      '@batch=t1 :irc.agent-comms.local CHATHISTORY TARGETS #lobby 2026-09-30T10:00:00.000Z',
      '@batch=t1 :irc.agent-comms.local CHATHISTORY TARGETS docs-bot 2026-09-30T10:00:00.000Z',
      '@batch=t1 :irc.agent-comms.local CHATHISTORY TARGETS chamber 2026-09-30T10:00:00.000Z',
      `${SERVER} BATCH -t1`,
    );
    expect(out).toEqual(['CHATHISTORY LATEST docs-bot * 50']);
    expect(state.snapshot().dms).toEqual(['docs-bot']);
  });

  test('server notices are not stored as messages', () => {
    const state = ready();
    joinLobby(state);
    feed(state, `${SERVER} NOTICE chamber :[fix-auth] busy`);
    expect(state.page('#lobby', null, 10).messages).toEqual([]);
    expect(state.snapshot().dms).toEqual([]);
  });

  test('ring buffer and system-line limit', () => {
    const state = ready({ ringSize: 5, systemLimit: 2 });
    joinLobby(state);
    for (let i = 1; i <= 8; i += 1) {
      feed(state, `${agentTags(`r${i}`, `2026-09-30T10:00:0${i}.000Z`)} :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :msg ${i}`);
    }
    expect(state.page('#lobby', null, 50).messages.map((m) => m.text)).toEqual(['msg 4', 'msg 5', 'msg 6', 'msg 7', 'msg 8']);
    const s2 = ready({ ringSize: 50, systemLimit: 2 });
    joinLobby(s2);
    for (const nick of ['a1', 'a2', 'a3', 'a4']) feed(s2, `:${nick}!x@y JOIN #lobby`);
    expect(s2.page('#lobby', null, 50).messages.map((m) => m.from)).toEqual(['a3', 'a4']);
  });

  test('paging with a before cursor', () => {
    const state = ready();
    joinLobby(state);
    for (let i = 1; i <= 10; i += 1) {
      feed(state, `${agentTags(`p${i}`, `2026-09-30T10:00:${String(i).padStart(2, '0')}.000Z`)} :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :p${i}`);
    }
    const last = state.page('#lobby', null, 4);
    expect(last.messages.map((m) => m.text)).toEqual(['p7', 'p8', 'p9', 'p10']);
    expect(last.hasMore).toBe(true);
    const older = state.page('#lobby', last.messages[0]!.seq, 4);
    expect(older.messages.map((m) => m.text)).toEqual(['p3', 'p4', 'p5', 'p6']);
    const oldest = state.page('#lobby', older.messages[0]!.seq, 4);
    expect(oldest.messages.map((m) => m.text)).toEqual(['p1', 'p2']);
  });
});

describe('long poll', () => {
  test('returns at once when events exist after the cursor', async () => {
    const state = ready();
    const first = await state.poll(0, null, 5000);
    expect(first.events.map((e) => e.type)).toEqual(['connection']);
    expect(first.seq).toBe(state.seq);
    const again = await state.poll(first.seq, state.epoch, 0);
    expect(again.events).toEqual([]);
  });

  test('waits, then resolves early when an event arrives', async () => {
    const state = ready();
    joinLobby(state);
    const cursor = state.seq;
    const started = Date.now();
    const pending = state.poll(cursor, state.epoch, 5000);
    setTimeout(() => feed(state, `${agentTags('w1')} :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :hi`), 50);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.events.map((e) => e.type)).toEqual(['message']);
    expect(result.reset).toBeUndefined();
  });

  test('times out with no events', async () => {
    const state = ready();
    const started = Date.now();
    const result = await state.poll(state.seq, state.epoch, 100);
    expect(result.events).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  test('abort ends the wait', async () => {
    const state = ready();
    const controller = new AbortController();
    const pending = state.poll(state.seq, state.epoch, 5000, controller.signal);
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(result.events).toEqual([]);
  });

  test('reset when the epoch differs, the cursor is ahead, or events were dropped', async () => {
    const state = ready({ eventLogSize: 3 });
    joinLobby(state);
    expect((await state.poll(0, 'other-epoch', 0)).reset).toBe(true);
    expect((await state.poll(state.seq + 100, state.epoch, 0)).reset).toBe(true);
    // Log holds only 3 events; a cursor older than the dropped ones must reset.
    for (let i = 0; i < 5; i += 1) feed(state, `${agentTags(`x${i}`)} :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :m${i}`);
    expect((await state.poll(0, state.epoch, 0)).reset).toBe(true);
    const recent = await state.poll(state.seq - 2, state.epoch, 0);
    expect(recent.reset).toBeUndefined();
    expect(recent.events).toHaveLength(2);
  });

  test('a large backlog of events is returned in parts', async () => {
    const state = ready();
    joinLobby(state);
    const start = state.seq;
    for (let i = 0; i < 400; i += 1) feed(state, `${agentTags(`b${i}`)} :fix-auth!ses_a@agent-comms.local PRIVMSG #lobby :m${i}`);
    const first = await state.poll(start, state.epoch, 0);
    expect(first.events.length).toBe(300);
    expect(first.seq).toBe(first.events.at(-1)!.seq);
    const second = await state.poll(first.seq, state.epoch, 0);
    expect(second.events.length).toBe(100);
    expect(second.seq).toBe(state.seq);
  });
});
