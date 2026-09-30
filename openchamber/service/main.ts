// Local service for the Agent Comms extension. OpenChamber starts it and proxies panel
// requests to it on 127.0.0.1 with a private bearer token.
//
// Routes (JSON):
//   GET  /health
//   GET  /state
//   GET  /messages?target=&before=<seq>&limit=
//   GET  /events?after=<seq>&wait=<ms>&epoch=
//   POST /send    {target, text}
//   POST /agent   {verb: STATUS|INTERRUPT|RESUME, target}
//   GET  /claims
//   POST /login   {password}
//   POST /logout
//   POST /join    {channel}
//   POST /part    {channel}
//   POST /dm      {nick}
//   POST /read    {target, seq}
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AgentVerb } from '../shared/types.ts';
import { IrcClient, validateTarget } from './client.ts';
import { configDir } from './config.ts';
import { ChamberState, isChannelName } from './state.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const MAX_BODY_BYTES = 64 * 1024;
const VERBS: readonly string[] = ['STATUS', 'INTERRUPT', 'RESUME'];

const state = new ChamberState();
const client = new IrcClient({
  dir: configDir(),
  state,
  log: (text) => console.error(`[agent-comms] ${text}`),
  // Tests set a short interval. OpenChamber does not pass this variable.
  listIntervalMs: Number(process.env.AGENT_COMMS_LIST_INTERVAL_MS) || 30_000,
});

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sendJson = (res: http.ServerResponse, status: number, body: object): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const readJson = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
  const text = await readBody(req);
  if (text.trim() === '') return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Body must be a JSON object');
  return parsed as Record<string, unknown>;
};

const str = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  return typeof value === 'string' ? value : '';
};

const num = (value: string | null, fallback: number, min: number, max: number): number => {
  if (value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
};

const expectedAuth = Buffer.from(`Bearer ${token}`);

const authorized = (header: string | undefined): boolean => {
  if (header === undefined) return false;
  const given = Buffer.from(header);
  return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth);
};

const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
  if (!authorized(req.headers.authorization)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = `${req.method ?? 'GET'} ${url.pathname}`;

  switch (route) {
    case 'GET /health':
      sendJson(res, 200, { ok: true });
      return;

    case 'GET /state':
      sendJson(res, 200, state.snapshot());
      return;

    case 'GET /messages': {
      const target = url.searchParams.get('target') ?? '';
      const invalid = validateTarget(target);
      if (invalid) {
        sendJson(res, 400, { error: invalid });
        return;
      }
      const beforeRaw = url.searchParams.get('before');
      const before = beforeRaw === null || beforeRaw === '' ? null : num(beforeRaw, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = num(url.searchParams.get('limit'), 50, 1, 200);
      let result = state.page(target, before, limit);
      // The store has no more messages: ask the server for older ones once.
      if (before !== null && result.messages.length < limit && !state.isExhausted(target)) {
        const count = await client.history(target, state.oldestMsgid(target));
        if (count > 0) result = state.page(target, before, limit);
      }
      sendJson(res, 200, result);
      return;
    }

    case 'GET /events': {
      const after = num(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER);
      const wait = num(url.searchParams.get('wait'), 0, 0, 15_000);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const result = await state.poll(after, url.searchParams.get('epoch'), wait, abort.signal);
      if (!res.destroyed) sendJson(res, 200, result);
      return;
    }

    case 'POST /send': {
      const body = await readJson(req);
      sendJson(res, 200, await client.send(str(body, 'target'), str(body, 'text')));
      return;
    }

    case 'POST /agent': {
      const body = await readJson(req);
      const verb = str(body, 'verb').toUpperCase();
      if (!VERBS.includes(verb)) {
        sendJson(res, 400, { ok: false, lines: [], error: 'verb must be STATUS, INTERRUPT or RESUME' });
        return;
      }
      sendJson(res, 200, await client.agent(verb as AgentVerb, str(body, 'target')));
      return;
    }

    case 'GET /claims':
      sendJson(res, 200, await client.claims());
      return;

    case 'POST /login': {
      const body = await readJson(req);
      const password = str(body, 'password');
      if (password === '' || /[\r\n\u0000]/.test(password)) {
        sendJson(res, 400, { ok: false, error: 'Enter the operator password' });
        return;
      }
      sendJson(res, 200, await client.login(password));
      return;
    }

    case 'POST /logout':
      client.logout();
      sendJson(res, 200, { ok: true });
      return;

    case 'POST /join':
    case 'POST /part': {
      const body = await readJson(req);
      const channel = str(body, 'channel');
      if (!isChannelName(channel) || validateTarget(channel)) {
        sendJson(res, 400, { ok: false, error: 'Invalid channel name' });
        return;
      }
      try {
        if (url.pathname === '/join') client.join(channel);
        else client.part(channel);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: errorMessage(error) });
      }
      return;
    }

    case 'POST /dm': {
      const body = await readJson(req);
      const nick = str(body, 'nick');
      if (isChannelName(nick) || validateTarget(nick)) {
        sendJson(res, 400, { ok: false, error: 'Invalid nick' });
        return;
      }
      client.requestLines(state.addDm(nick));
      sendJson(res, 200, { ok: true });
      return;
    }

    case 'POST /read': {
      const body = await readJson(req);
      const seq = typeof body.seq === 'number' ? body.seq : 0;
      state.markRead(str(body, 'target'), seq);
      sendJson(res, 200, { ok: true });
      return;
    }

    default:
      sendJson(res, 404, { error: 'not-found' });
  }
};

const server = http.createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) });
    else res.end();
  });
});

// A failure in one socket must never stop the service.
process.on('uncaughtException', (error) => console.error(`[agent-comms] uncaught: ${errorMessage(error)}`));
process.on('unhandledRejection', (error) => console.error(`[agent-comms] unhandled: ${errorMessage(error)}`));
process.on('SIGTERM', () => {
  client.stop();
  server.close();
  process.exit(0);
});

server.listen(port, '127.0.0.1', () => client.start());
