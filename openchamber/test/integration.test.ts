// Integration test: the service against a REAL agent-comms server.
// Needs the server binary (`cargo build -p agent-comms`). The test starts its own server on a free port
// in a temp directory. It never touches ~/.config/agent-comms.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { IrcClient, OPERATOR_CAPS } from '../../plugin/e2e/irc-client.ts';
import { freePort, serverBinary, startServer, type TestServer } from '../../plugin/e2e/server.ts';
import type {
  AgentResponse,
  ChatMessage,
  ClaimsResponse,
  EventsResponse,
  LoginResponse,
  MessagesResponse,
  SendResponse,
  StateResponse,
} from '../shared/types.ts';
import { FakeLink } from './fake-agent.ts';

const root = path.resolve(import.meta.dir, '..');
const haveServer = fs.existsSync(serverBinary());

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!haveServer)('service against a real agent-comms server', () => {
  let server: TestServer;
  let service: ChildProcess | null = null;
  let base = '';
  let servicePort = 0;
  const token = 'test-token-123';
  let guest: IrcClient;
  let link: FakeLink;
  let log = '';

  const call = async <T>(method: string, route: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as T };
  };

  const state = async (): Promise<StateResponse> => (await call<StateResponse>('GET', '/state')).json;

  const waitFor = async <T>(fn: () => Promise<T | null>, ms = 10_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await fn();
      if (value !== null) return value;
      if (Date.now() > end) throw new Error(`timeout. service log:\n${log}\nserver log:\n${server.log().split('\n').slice(-30).join('\n')}`);
      await sleep(100);
    }
  };

  const startService = async (): Promise<void> => {
    // Run the built bundle with Node, as OpenChamber does.
    const runtime = spawnSync('node', ['--version']).status === 0 ? 'node' : process.execPath;
    service = spawn(runtime, [path.join(root, 'service/main.js')], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: path.join(server.configDir, 'home'),
        OPENCHAMBER_SERVICE_PORT: String(servicePort),
        OPENCHAMBER_SERVICE_TOKEN: token,
        AGENT_COMMS_CONFIG_DIR: server.configDir,
        AGENT_COMMS_LIST_INTERVAL_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    service.stderr?.on('data', (d: Buffer) => (log += d.toString()));
    service.stdout?.on('data', (d: Buffer) => (log += d.toString()));
    await waitFor(async () => {
      try {
        return (await call('GET', '/health')).status === 200 ? true : null;
      } catch {
        return null;
      }
    });
  };

  const stopService = async (): Promise<void> => {
    const proc = service;
    if (!proc) return;
    service = null;
    const done = new Promise<void>((r) => proc.once('exit', () => r()));
    proc.kill('SIGTERM');
    await done;
  };

  const events = async (after: number, wait = 10_000): Promise<EventsResponse> =>
    (await call<EventsResponse>('GET', `/events?after=${after}&wait=${wait}`)).json;

  /** Poll until an event that satisfies `match` arrives. */
  const eventsUntil = async (after: number, match: (e: EventsResponse['events'][number]) => boolean, ms = 10_000): Promise<EventsResponse['events'][number]> => {
    const end = Date.now() + ms;
    let cursor = after;
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) throw new Error('no matching event');
      const result = await events(cursor, Math.min(left, 5000));
      const hit = result.events.find(match);
      if (hit) return hit;
      cursor = result.seq;
    }
  };

  const messages = async (target: string, extra = ''): Promise<MessagesResponse> =>
    (await call<MessagesResponse>('GET', `/messages?target=${encodeURIComponent(target)}${extra}`)).json;

  beforeAll(async () => {
    const built = spawnSync('bun', ['run', 'build:service'], { cwd: root, encoding: 'utf8' });
    if (built.status !== 0) throw new Error(`build failed: ${built.stderr}${built.stdout}`);
    server = await startServer({ operatorPassword: 'correct horse' });
    servicePort = await freePort();
    base = `http://127.0.0.1:${servicePort}`;
    await startService();
  });

  afterAll(async () => {
    link?.close();
    await guest?.close().catch(() => undefined);
    await stopService();
    await server?.cleanup();
  });

  test('rejects a request without the bearer token', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(401);
    const wrong = await fetch(`${base}/state`, { headers: { Authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
  });

  test('asks for a login first, then rejects a wrong password', async () => {
    const s = await state();
    expect(s.needsLogin).toBe(true);
    expect(s.connected).toBe(false);
    const bad = (await call<LoginResponse>('POST', '/login', { password: 'wrong' })).json;
    expect(bad.ok).toBe(false);
    expect(fs.existsSync(path.join(server.configDir, 'openchamber-operator.json'))).toBe(false);
    expect((await state()).needsLogin).toBe(true);
  });

  test('logs in, stores the password with mode 0600, and never returns it', async () => {
    const response = await call<LoginResponse>('POST', '/login', { password: 'correct horse' });
    expect(response.json.ok).toBe(true);
    expect(JSON.stringify(response.json)).not.toContain('correct horse');
    const file = path.join(server.configDir, 'openchamber-operator.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const s = await waitFor(async () => ((await state()).connected ? await state() : null));
    expect(s.needsLogin).toBe(false);
    expect(s.nick).toBe('chamber');
    expect(JSON.stringify(s)).not.toContain('correct horse');
  });

  test('joins channels that agents create and sees their members', async () => {
    link = new FakeLink({ host: server.host, port: server.port, token: server.readLinkToken() });
    await link.connect([
      { account: 'ses_a', nick: 'fix-auth', project: 'proj-x', state: 'busy' },
      { account: 'ses_b', nick: 'fix-auth|explore1', parent: 'ses_a', project: 'proj-x', state: 'idle' },
    ]);
    // The service runs LIST every 30 s and joins the channels that it does not know.
    const s = await waitFor(async () => {
      const cur = await state();
      const names = cur.channels.map((c) => c.name);
      return ['#lobby', '#proj-x', '#fix-auth'].every((n) => names.includes(n)) ? cur : null;
    }, 45_000);
    const proj = s.channels.find((c) => c.name === '#proj-x');
    expect(proj?.members.map((m) => m.nick).sort()).toEqual(['chamber', 'fix-auth', 'fix-auth|explore1']);
    await waitFor(async () => {
      const cur = (await state()).channels.find((c) => c.name === '#proj-x');
      const busy = cur?.members.find((m) => m.nick === 'fix-auth');
      const idle = cur?.members.find((m) => m.nick === 'fix-auth|explore1');
      return busy?.away === null && idle?.away === 'idle' ? true : null;
    });
  }, 60_000);

  test('sees an agent message in a channel, with role and mention', async () => {
    const before = (await state()).seq;
    const sent = await link.say('ses_a', 'PRIVMSG #proj-x :working on it, operator');
    expect(sent.ok).toBe(true);
    const seen = await eventsUntil(before, (e) => e.type === 'message' && e.message.text.includes('working on it'));
    const message = (seen as { message: ChatMessage }).message;
    expect(message).toMatchObject({ target: '#proj-x', from: 'fix-auth', role: 'agent', self: false, mention: true, kind: 'privmsg' });
    expect(message.msgid).toBe(sent.msgid ?? 'x');
    // Unread: counted until the panel marks the target as read.
    expect((await state()).unread['#proj-x']?.mentions).toBe(1);
    await call('POST', '/read', { target: '#proj-x', seq: message.seq });
    expect((await state()).unread['#proj-x']).toBeUndefined();
  });

  test('presence changes: busy to idle, and retire', async () => {
    const before = (await state()).seq;
    link.setState('ses_a', 'idle');
    await eventsUntil(before, (e) => e.type === 'members' && e.channel === '#proj-x');
    await waitFor(async () => {
      const m = (await state()).channels.find((c) => c.name === '#proj-x')?.members.find((x) => x.nick === 'fix-auth');
      return m?.away === 'idle' ? true : null;
    });
    const page = await messages('#proj-x');
    expect(page.messages.some((m) => m.kind === 'away' && m.from === 'fix-auth')).toBe(true);
  });

  test('a direct message to the operator opens a DM target', async () => {
    const before = (await state()).seq;
    // Agents reply to the nick that wrote to them: here the nick of the service connection.
    const sent = await link.say('ses_a', 'PRIVMSG chamber :please review the diff');
    expect(sent.ok).toBe(true);
    const seen = await eventsUntil(before, (e) => e.type === 'message' && e.message.text.includes('review the diff'));
    const message = (seen as { message: ChatMessage }).message;
    expect(message.target).toBe('fix-auth');
    expect(message.mention).toBe(true);
    const s = await state();
    expect(s.dms).toContain('fix-auth');
    expect(s.unread['fix-auth']?.unread).toBe(1);
  });

  test('sends to a channel as the operator, with @here', async () => {
    const mark = link.lines.length;
    const sent = (await call<SendResponse>('POST', '/send', { target: '#proj-x', text: 'operator here: status? @here' })).json;
    expect(sent.error).toBeUndefined();
    expect(sent.ok).toBe(true);
    expect(sent.msgid).toBeTruthy();
    const delivered = await link.waitFor((l) => l.command === 'DELIVER' && l.params[1]?.includes('status? @here') === true, 8000, mark);
    expect(delivered.params[1]).toContain('agent-comms.local/broadcast=here');
    const page = await messages('#proj-x');
    const own = page.messages.find((m) => m.text === 'operator here: status? @here');
    expect(own).toMatchObject({ self: true, role: 'operator', broadcast: 'here' });
  });

  test('sends a DM to an agent', async () => {
    const mark = link.lines.length;
    const sent = (await call<SendResponse>('POST', '/send', { target: 'fix-auth', text: 'direct: hi' })).json;
    expect(sent.ok).toBe(true);
    await link.waitFor((l) => l.command === 'DELIVER' && l.params[1]?.includes('direct: hi') === true, 8000, mark);
    const page = await messages('fix-auth');
    expect(page.messages.some((m) => m.text === 'direct: hi' && m.self)).toBe(true);
  });

  test('sends multiline and very long messages', async () => {
    guest = await IrcClient.connect({
      host: server.host,
      port: server.port,
      nick: 'guest',
      password: server.operatorPassword,
      caps: [...OPERATOR_CAPS, 'draft/multiline'],
    });
    guest.join('#proj-x');
    await guest.waitFor((l) => l.command === '366' && l.params[1] === '#proj-x');
    const mark = guest.mark();
    const text = 'line one\nline two\n\nline four';
    const sent = (await call<SendResponse>('POST', '/send', { target: '#proj-x', text })).json;
    expect(sent.error).toBeUndefined();
    expect(sent.ok).toBe(true);
    await guest.waitFor((l) => l.command === 'BATCH' && l.params[0]?.startsWith('+') === true && l.params[1] === 'draft/multiline', 5000, { since: mark });
    const page = await waitFor(async () => {
      const p = await messages('#proj-x');
      return p.messages.some((m) => m.text === text) ? p : null;
    });
    expect(page.messages.find((m) => m.text === text)?.self).toBe(true);

    const long = 'x'.repeat(1500) + ' é ' + 'y'.repeat(1500);
    const longSent = (await call<SendResponse>('POST', '/send', { target: '#proj-x', text: long })).json;
    expect(longSent.ok).toBe(true);
    await waitFor(async () => ((await messages('#proj-x')).messages.some((m) => m.text === long) ? true : null));
  });

  test('rejects bad messages', async () => {
    const empty = (await call<SendResponse>('POST', '/send', { target: '#proj-x', text: '   ' })).json;
    expect(empty.ok).toBe(false);
    const cr = (await call<SendResponse>('POST', '/send', { target: '#proj-x', text: 'a\rb' })).json;
    expect(cr.ok).toBe(false);
    const huge = (await call<SendResponse>('POST', '/send', { target: '#proj-x', text: 'a'.repeat(16385) })).json;
    expect(huge.ok).toBe(false);
    const nobody = (await call<SendResponse>('POST', '/send', { target: 'nobody-here', text: 'hi' })).json;
    expect(nobody.ok).toBe(false);
    expect(nobody.error).toMatch(/no such nick/i);
  });

  test('AGENT verbs reach the agent; a guest is "not an agent"', async () => {
    const status = (await call<AgentResponse>('POST', '/agent', { verb: 'STATUS', target: 'fix-auth' })).json;
    expect(status.ok).toBe(true);
    expect(status.lines).toEqual(['[fix-auth] busy, editing src/auth.rs']);
    const stop = (await call<AgentResponse>('POST', '/agent', { verb: 'interrupt', target: 'fix-auth' })).json;
    expect(stop.lines).toEqual(['[fix-auth] interrupted']);
    const channel = (await call<AgentResponse>('POST', '/agent', { verb: 'STATUS', target: '#proj-x' })).json;
    expect(channel.lines.length).toBe(2);
    const notAgent = (await call<AgentResponse>('POST', '/agent', { verb: 'STATUS', target: 'guest' })).json;
    expect(notAgent.ok).toBe(true);
    expect(notAgent.lines.join('\n')).toMatch(/not an agent/i);
    const missing = (await call<AgentResponse>('POST', '/agent', { verb: 'STATUS', target: 'nobody-here' })).json;
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/no such nick/i);
    const bad = await call<AgentResponse>('POST', '/agent', { verb: 'DROP', target: 'guest' });
    expect(bad.status).toBe(400);
  });

  test('CLAIMS returns a parsed list', async () => {
    link.write({ tags: [['label', 'c1']], source: null, command: 'CLAIM', params: ['ses_a', '/work/a file.rs'] });
    await link.waitFor((l) => l.command === 'CLAIMSET');
    const result = (await call<ClaimsResponse>('GET', '/claims')).json;
    expect(result.ok).toBe(true);
    expect(result.claims.find((c) => c.path === '/work/a file.rs')).toMatchObject({ nick: 'fix-auth' });
  });

  test('a quit of an agent removes it from the members', async () => {
    link.retire('ses_b');
    await waitFor(async () => {
      const m = (await state()).channels.find((c) => c.name === '#proj-x')?.members ?? [];
      return m.some((x) => x.nick === 'fix-auth|explore1') ? null : true;
    });
    const page = await messages('#proj-x');
    expect(page.messages.some((m) => m.kind === 'quit' && m.from === 'fix-auth|explore1')).toBe(true);
  });

  test('long poll: epoch mismatch resets; a poll wakes early on an event', async () => {
    const reset = (await call<EventsResponse>('GET', '/events?after=0&wait=0&epoch=other')).json;
    expect(reset.reset).toBe(true);
    const s = await state();
    const started = Date.now();
    const pending = call<EventsResponse>('GET', `/events?after=${s.seq}&wait=15000&epoch=${s.epoch}`);
    await sleep(300);
    await link.say('ses_a', 'PRIVMSG #proj-x :wake up');
    const result = (await pending).json;
    expect(Date.now() - started).toBeLessThan(6000);
    expect(result.events.length).toBeGreaterThan(0);
    await eventsUntil(s.seq, (e) => e.type === 'message' && e.message.text === 'wake up');
  });

  test('after a restart of the service, backlog fills and older pages come from the server', async () => {
    for (let i = 1; i <= 130; i += 1) {
      const r = await link.say('ses_a', `PRIVMSG #lobby :bulk ${i}`);
      expect(r.ok).toBe(true);
      await sleep(60); // stay below the flood limit of the account
    }
    await stopService();
    await startService();
    const s = await waitFor(async () => {
      const cur = await state();
      return cur.connected && cur.channels.some((c) => c.name === '#lobby') ? cur : null;
    }, 45_000);
    expect(s.needsLogin).toBe(false);
    const latest = await waitFor(async () => {
      const p = await messages('#lobby', '&limit=200');
      return p.messages.length >= 100 ? p : null;
    });
    expect(latest.messages.at(-1)?.text).toBe('bulk 130');
    expect(latest.messages.every((m) => m.history)).toBe(true);
    // Backlog is never unread.
    expect((await state()).unread['#lobby']).toBeUndefined();
    const oldest = latest.messages[0]!;
    const older = (await call<MessagesResponse>('GET', `/messages?target=%23lobby&before=${oldest.seq}&limit=20`)).json;
    expect(older.messages.length).toBe(20);
    expect(older.messages.at(-1)!.time).toBeLessThanOrEqual(oldest.time);
    const ids = new Set([...older.messages, ...latest.messages].map((m) => m.msgid));
    expect(ids.size).toBe(older.messages.length + latest.messages.length);
    // Direct messages come back too.
    await waitFor(async () => ((await state()).dms.includes('fix-auth') ? true : null));
    const dm = await messages('fix-auth');
    expect(dm.messages.some((m) => m.text.includes('review the diff'))).toBe(true);
  }, 120_000);

  test('reconnects with the stored password after the server restarts', async () => {
    await server.restart();
    const s = await waitFor(async () => ((await state()).connected ? await state() : null), 45_000);
    expect(s.needsLogin).toBe(false);
    // The service joins the channels again: a new user who writes in #lobby is seen.
    const again = await IrcClient.connect({ host: server.host, port: server.port, nick: 'guest2', password: server.operatorPassword });
    try {
      again.join('#lobby');
      await again.waitFor((l) => l.command === '366' && l.params[1] === '#lobby');
      const before = (await state()).seq;
      await waitFor(async () => {
        again.privmsg('#lobby', 'after the restart');
        try {
          await eventsUntil(before, (e) => e.type === 'message' && e.message.text === 'after the restart', 2500);
          return true;
        } catch {
          return null;
        }
      }, 40_000);
    } finally {
      await again.close();
    }
  }, 90_000);

  test('logout deletes the password file and asks for a login again', async () => {
    await call('POST', '/logout');
    expect(fs.existsSync(path.join(server.configDir, 'openchamber-operator.json'))).toBe(false);
    const s = await state();
    expect(s.needsLogin).toBe(true);
    expect(s.connected).toBe(false);
  });
});
