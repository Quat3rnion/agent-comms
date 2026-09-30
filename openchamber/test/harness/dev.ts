// Manual test harness. Run: bun test/harness/dev.ts
// It starts a real agent-comms server with fake agents, the built service, and a web page that acts as the
// OpenChamber host for the panel. Open the printed URL in a browser.
//   POST /inject {account, text, target}  sends a message as a fake agent.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, startServer } from '../../../plugin/e2e/server.ts';
import { FakeLink } from '../fake-agent.ts';

const root = path.resolve(import.meta.dir, '../..');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

spawnSync('bun', ['run', 'build'], { cwd: root, stdio: 'inherit' });
const server = await startServer({ operatorPassword: 'harness-pass' });
const servicePort = await freePort();
const token = 'harness-token';
const service = spawn('node', [path.join(root, 'service/main.js')], {
  env: {
    PATH: process.env.PATH ?? '',
    HOME: path.join(server.configDir, 'home'),
    OPENCHAMBER_SERVICE_PORT: String(servicePort),
    OPENCHAMBER_SERVICE_TOKEN: token,
    AGENT_COMMS_CONFIG_DIR: server.configDir,
    AGENT_COMMS_LIST_INTERVAL_MS: '2000',
  },
  stdio: 'inherit',
});
const svc = async (method: string, route: string, body?: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${servicePort}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
for (let i = 0; i < 100; i += 1) {
  try {
    if ((await svc('GET', '/health')).ok) break;
  } catch {
    // not ready
  }
  await sleep(100);
}
if (process.env.HARNESS_LOGIN !== '0') await svc('POST', '/login', { password: 'harness-pass' });

// A link that goes away: its agents become dormant.
const gone = new FakeLink({ host: server.host, port: server.port, token: server.readLinkToken(), linkName: 'svc-gone.prj-docs' });
await gone.connect([{ account: 'ses_docs', nick: 'docs-bot', project: 'docs', state: 'idle' }]);
const link = new FakeLink({ host: server.host, port: server.port, token: server.readLinkToken(), linkName: 'svc-main.prj-webapp' });
await link.connect([
  { account: 'ses_a', nick: 'fix-auth', project: 'webapp', state: 'busy' },
  { account: 'ses_b', nick: 'fix-auth|explore1', parent: 'ses_a', project: 'webapp', state: 'idle' },
  { account: 'ses_c', nick: 'planner', project: 'infra', state: 'idle' },
  { account: 'ses_d', nick: 'feature-planning-discuss|task1', project: 'infra', state: 'busy' },
]);
await sleep(300);
await gone.say('ses_docs', 'PRIVMSG #lobby :Docs are rebuilt. Going to sleep now.');
gone.close();

const say = (account: string, inner: string): Promise<unknown> => link.say(account, inner);
await say('ses_a', 'PRIVMSG #webapp :Working on src/auth.rs. I claimed the file.');
await say('ses_b', 'PRIVMSG #webapp :Found 3 call sites of verify_token().');
await say('ses_a', 'PRIVMSG #fix-auth :fix-auth|explore1: please list the call sites.');
await say('ses_c', 'PRIVMSG #lobby :Planning the infra move. Anyone touching terraform/? Ask me first.');
await say('ses_d', 'PRIVMSG #infra :Draft plan is in /tmp/plan.md (about 40 lines).');
await say('ses_a', 'PRIVMSG chamber :operator: I need a decision. Keep the old token format, or migrate now?');
await say('ses_c', 'PRIVMSG #lobby :@here heads up: CI is slow today.');
// A multiline message from an agent (an inner batch through SEND).
const ref = 'mlx';
link.write({ tags: [], source: null, command: 'SEND', params: ['ses_a', `BATCH +${ref} draft/multiline #webapp`] });
for (const line of ['Summary of the change:', '- verify_token() now returns Result', '- callers updated', '', 'All tests pass.']) {
  link.write({ tags: [], source: null, command: 'SEND', params: ['ses_a', `@batch=${ref} PRIVMSG #webapp :${line}`] });
}
link.write({ tags: [], source: null, command: 'SEND', params: ['ses_a', `BATCH -${ref}`] });
await sleep(200);
const longLines = Array.from({ length: 30 }, (_, i) => `log line ${i + 1}: request handled in ${10 + i} ms`);
link.write({ tags: [], source: null, command: 'SEND', params: ['ses_b', 'BATCH +mly draft/multiline #webapp'] });
for (const line of longLines) link.write({ tags: [], source: null, command: 'SEND', params: ['ses_b', `@batch=mly PRIVMSG #webapp :${line}`] });
link.write({ tags: [], source: null, command: 'SEND', params: ['ses_b', 'BATCH -mly'] });
for (let i = 1; i <= 40; i += 1) await say(i % 2 ? 'ses_a' : 'ses_b', `PRIVMSG #webapp :filler message ${i} to make the channel scroll`);

let ctlId = 0;
let ctlWake: (() => void) | null = null;
const ctlQueue: Array<{ id: number; code: string }> = [];
const ctlWaiters = new Map<number, (value: string) => void>();

const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const web = Bun.serve({
  port: Number(process.env.HARNESS_PORT ?? 0),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response(Bun.file(path.join(import.meta.dir, 'host.html')), { headers: { 'content-type': 'text/html' } });
    if (url.pathname.startsWith('/panel/')) {
      const file = path.join(root, 'panel', path.basename(url.pathname));
      if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
      return new Response(Bun.file(file), { headers: { 'content-type': mime[path.extname(file)] ?? 'text/plain' } });
    }
    if (url.pathname === '/svc' && req.method === 'POST') {
      const r = (await req.json()) as { method: string; path: string; query?: Record<string, string>; body?: string };
      const q = r.query ? `?${new URLSearchParams(r.query).toString()}` : '';
      const res = await fetch(`http://127.0.0.1:${servicePort}${r.path}${q}`, {
        method: r.method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(r.body !== undefined ? { body: r.body } : {}),
      });
      return Response.json({ status: res.status, body: await res.text() });
    }
    // Remote control: POST /ctl {code} runs JavaScript inside the panel frame and returns the result.
    if (url.pathname === '/ctl' && req.method === 'POST') {
      const { code } = (await req.json()) as { code: string };
      const id = ++ctlId;
      const result = new Promise<string>((resolve) => ctlWaiters.set(id, resolve));
      ctlQueue.push({ id, code });
      ctlWake?.();
      const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 8000));
      return new Response(await Promise.race([result, timeout]));
    }
    if (url.pathname === '/ctl/next') {
      if (ctlQueue.length === 0) await new Promise<void>((resolve) => { ctlWake = resolve; setTimeout(resolve, 10_000); });
      return Response.json(ctlQueue.shift() ?? null);
    }
    if (url.pathname === '/ctl/result' && req.method === 'POST') {
      const { id, value } = (await req.json()) as { id: number; value: string };
      ctlWaiters.get(id)?.(value);
      ctlWaiters.delete(id);
      return new Response('ok');
    }
    if (url.pathname === '/inject' && req.method === 'POST') {
      const { account, inner } = (await req.json()) as { account: string; inner: string };
      return Response.json(await link.say(account, inner));
    }
    return new Response('not found', { status: 404 });
  },
});
console.log(`HARNESS_URL http://127.0.0.1:${web.port}/`);
console.log(`HARNESS_PASSWORD harness-pass`);

const stop = async (): Promise<void> => {
  service.kill('SIGTERM');
  link.close();
  await server.cleanup();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
