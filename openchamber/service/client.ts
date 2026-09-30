// One persistent IRC connection for the operator account.
// It logs in with SASL PLAIN, feeds every line to the state machine, and answers requests
// (send a message, AGENT verbs, CLAIMS, chathistory).
import net from 'node:net';
import tls from 'node:tls';
import {
  CLIENT_LIMITS,
  LINK_LIMITS,
  LineSplitter,
  getTag,
  msg,
  parseLine,
  serializeLine,
  type IrcMessage,
} from '../../plugin/src/proto.ts';
import type { AgentResponse, AgentVerb, Claim, ClaimsResponse, LoginResponse, SendResponse } from '../shared/types.ts';
import { deletePassword, loadPassword, readConnectionConfig, savePassword, type ConnectionConfig } from './config.ts';
import { fold, isChannelName, type ChamberState } from './state.ts';

const WANTED_CAPS = [
  'message-tags',
  'server-time',
  'account-tag',
  'away-notify',
  'echo-message',
  'batch',
  'labeled-response',
  'draft/chathistory',
  'draft/read-marker',
  'draft/multiline',
];

export const MAX_MESSAGE_BYTES = 16384;
const MAX_LINES = 200;
const NICKS = ['chamber', 'chamber2', 'chamber3', 'chamber4', 'chamber5', 'chamber6'];
const ACCOUNT = 'operator';

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Split text into pieces of at most `max` bytes, without cutting a character. */
export const chunkText = (text: string, max: number): string[] => {
  if (byteLength(text) <= max) return [text];
  const chunks: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of text) {
    const bytes = byteLength(ch);
    if (size + bytes > max) {
      chunks.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  if (current !== '') chunks.push(current);
  return chunks;
};

export interface SendPlan {
  /** Lines to write, in order. The label tag is not set yet. */
  lines: IrcMessage[];
  batch: boolean;
}

export const validateTarget = (target: string): string | null => {
  if (target === '' || target.length > 200) return 'Invalid target';
  if (/[\s,\u0000-\u001f\u007f]/.test(target)) return 'Invalid target';
  if (!isChannelName(target) && /^[:@+%~]/.test(target)) return 'Invalid target';
  return null;
};

/** Build the IRC lines for one message. Returns an error text when the message is not valid. */
export const planSend = (target: string, text: string, ref: string): SendPlan | string => {
  const targetError = validateTarget(target);
  if (targetError) return targetError;
  if (/[\r\u0000]/.test(text)) return 'The message contains a carriage return or a NUL character';
  if (text.trim() === '') return 'The message is empty';
  if (byteLength(text) > MAX_MESSAGE_BYTES) return `The message is longer than ${MAX_MESSAGE_BYTES} bytes`;
  const max = CLIENT_LIMITS.body - 2 - byteLength(`PRIVMSG ${target} :`) - 2;
  const rows = text.split('\n');
  const single = rows.length === 1 && byteLength(text) <= max;
  if (single) return { lines: [msg('PRIVMSG', [target, text])], batch: false };
  const lines: IrcMessage[] = [msg('BATCH', [`+${ref}`, 'draft/multiline', target])];
  let count = 0;
  for (const row of rows) {
    const chunks = chunkText(row, max);
    chunks.forEach((chunk, index) => {
      const tags: IrcMessage['tags'] = [['batch', ref]];
      if (index > 0) tags.push(['draft/multiline-concat', null]);
      lines.push(msg('PRIVMSG', [target, chunk], { tags }));
      count += 1;
    });
    if (chunks.length === 0) {
      lines.push(msg('PRIVMSG', [target, ''], { tags: [['batch', ref]] }));
      count += 1;
    }
  }
  if (count > MAX_LINES) return `The message has too many lines (limit ${MAX_LINES})`;
  lines.push(msg('BATCH', [`-${ref}`]));
  return { lines, batch: true };
};

export const parseClaim = (text: string): Claim | null => {
  const match = /^(\S+) holds (.+) since (\d+) until (\d+)$/.exec(text);
  if (!match) return null;
  return { nick: match[1] ?? '', path: match[2] ?? '', since: Number(match[3]), until: Number(match[4]) };
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

interface Pending {
  resolve: (value: SendResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Collector {
  verb: string;
  lines: string[];
  error: string | null;
  done: () => void;
  isEnd: (text: string) => boolean;
}

type SessionEnd = { registered: boolean; authFailed: boolean; message: string | null };

export interface ClientOptions {
  dir: string;
  state: ChamberState;
  log?: (text: string) => void;
  /** Time between LIST requests that find new channels. Default 30000. */
  listIntervalMs?: number;
}

export class IrcClient {
  private readonly dir: string;
  private readonly state: ChamberState;
  private readonly log: (text: string) => void;
  private readonly listIntervalMs: number;
  private password: string | null;
  private socket: net.Socket | null = null;
  private registered = false;
  private stopped = false;
  private wakeSleep: (() => void) | null = null;
  private loginWait: Deferred<LoginResponse> | null = null;
  private labelCounter = 0;
  private batchCounter = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly batchLabels = new Map<string, string>();
  private collector: Collector | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly historyWaiters: Array<{ target: string; resolve: (count: number) => void }> = [];
  private background: IrcMessage[] = [];
  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  private lastReceived = 0;
  private timers: Array<ReturnType<typeof setInterval>> = [];

  constructor(options: ClientOptions) {
    this.dir = options.dir;
    this.state = options.state;
    this.log = options.log ?? (() => undefined);
    this.listIntervalMs = options.listIntervalMs ?? 30_000;
    this.password = loadPassword(this.dir);
    this.state.onHistoryDone = (target, count) => {
      for (const waiter of this.historyWaiters.splice(0)) {
        if (fold(waiter.target) === fold(target)) waiter.resolve(count);
        else this.historyWaiters.push(waiter);
      }
    };
  }

  // ---- lifecycle ----

  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
    this.wakeSleep?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === Infinity ? null : setTimeout(done, ms);
      function done(): void {
        if (timer) clearTimeout(timer);
        resolve();
      }
      this.wakeSleep = done;
    });
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      if (this.password === null) {
        this.state.setStatus({ connected: false, needsLogin: true });
        await this.sleep(Infinity);
        continue;
      }
      let end: SessionEnd;
      try {
        end = await this.session(this.password);
      } catch (error) {
        end = { registered: false, authFailed: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (this.stopped) return;
      this.state.onDisconnected();
      if (end.authFailed) {
        this.password = null;
        deletePassword(this.dir);
        this.state.setStatus({ needsLogin: true, error: 'The operator password was rejected.' });
        this.finishLogin({ ok: false, error: 'The operator password was rejected.' });
        attempt = 0;
        continue;
      }
      if (end.registered) attempt = 0;
      else if (this.loginWait) {
        // A first login that cannot even connect. Ask again instead of retrying with a new password.
        this.password = null;
        const message = end.message ?? 'Cannot connect to the server';
        this.state.setStatus({ needsLogin: true, error: message });
        this.finishLogin({ ok: false, error: message });
        continue;
      }
      if (end.message) this.state.setStatus({ error: end.message });
      attempt += 1;
      await this.sleep(Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)));
    }
  }

  private finishLogin(result: LoginResponse): void {
    const wait = this.loginWait;
    this.loginWait = null;
    wait?.resolve(result);
  }

  async login(password: string): Promise<LoginResponse> {
    if (this.loginWait) return { ok: false, error: 'A login is already in progress' };
    const wait = deferred<LoginResponse>();
    this.loginWait = wait;
    this.password = password;
    this.state.setStatus({ error: null });
    this.socket?.destroy();
    this.wakeSleep?.();
    const timer = setTimeout(() => this.finishLogin({ ok: false, error: 'The server did not answer in time' }), 20_000);
    const result = await wait.promise;
    clearTimeout(timer);
    if (result.ok) {
      savePassword(this.dir, password);
    } else if (this.password === password) {
      this.password = null;
      this.socket?.destroy();
    }
    return result;
  }

  logout(): void {
    this.password = null;
    deletePassword(this.dir);
    this.state.setStatus({ needsLogin: true, error: null });
    this.socket?.destroy();
    this.wakeSleep?.();
  }

  // ---- session ----

  private session(password: string): Promise<SessionEnd> {
    return new Promise((resolve) => {
      let config: ConnectionConfig;
      try {
        config = readConnectionConfig(this.dir);
      } catch (error) {
        resolve({ registered: false, authFailed: false, message: error instanceof Error ? error.message : String(error) });
        return;
      }
      const socket: net.Socket = config.ca
        ? tls.connect({
          host: config.host,
          port: config.port,
          ca: config.ca,
          servername: /^[\d.:]+$/.test(config.host) ? 'localhost' : config.host,
        })
        : net.connect({ host: config.host, port: config.port });
      this.socket = socket;
      socket.setEncoding('utf8');
      socket.setNoDelay(true);
      const splitter = new LineSplitter();
      let registered = false;
      let authFailed = false;
      let message: string | null = null;
      let nickIndex = 0;
      let ended = false;
      const offered = new Set<string>();
      const connectTimer = setTimeout(() => {
        message = 'Timed out while connecting or logging in';
        socket.destroy();
      }, 20_000);

      const cleanup = (): void => {
        if (ended) return;
        ended = true;
        clearTimeout(connectTimer);
        this.stopTimers();
        this.registered = false;
        if (this.socket === socket) this.socket = null;
        this.failPending('Disconnected from the IRC server');
        for (const waiter of this.historyWaiters.splice(0)) waiter.resolve(0);
        this.collector?.done();
        resolve({ registered, authFailed, message });
      };
      socket.on('close', cleanup);
      socket.on('error', (error: Error) => {
        message = error.message;
      });

      const write = (line: IrcMessage): void => {
        if (!socket.destroyed) socket.write(`${serializeLine(line)}\r\n`);
      };
      this.writer = write;

      const onLine = (line: IrcMessage): void => {
        this.lastReceived = Date.now();
        if (line.command === 'PING') {
          write(msg('PONG', line.params));
          return;
        }
        if (!registered) {
          switch (line.command) {
            case 'CAP': {
              const sub = line.params[1];
              if (sub === 'LS') {
                const more = line.params[2] === '*';
                for (const item of (line.params[more ? 3 : 2] ?? '').split(' ')) {
                  if (item !== '') offered.add(item.split('=')[0] ?? item);
                }
                if (more) return;
                if (!offered.has('sasl')) {
                  message = 'The server does not offer SASL';
                  socket.destroy();
                  return;
                }
                write(msg('CAP', ['REQ', [...WANTED_CAPS.filter((c) => offered.has(c)), 'sasl'].join(' ')]));
              } else if (sub === 'ACK') {
                write(msg('AUTHENTICATE', ['PLAIN']));
              } else if (sub === 'NAK') {
                message = `The server refused capabilities: ${line.params[2] ?? ''}`;
                socket.destroy();
              }
              return;
            }
            case 'AUTHENTICATE': {
              if (line.params[0] !== '+') return;
              const payload = Buffer.from(`\u0000${ACCOUNT}\u0000${password}`, 'utf8').toString('base64');
              for (let i = 0; i < payload.length; i += 400) write(msg('AUTHENTICATE', [payload.slice(i, i + 400)]));
              if (payload.length % 400 === 0) write(msg('AUTHENTICATE', ['+']));
              return;
            }
            case '903':
              write(msg('CAP', ['END']));
              return;
            case '902':
            case '904':
            case '905':
            case '906':
              authFailed = true;
              socket.destroy();
              return;
            case '432':
            case '433': {
              nickIndex += 1;
              const next = NICKS[nickIndex];
              if (next === undefined) {
                message = 'No free nick for the operator connection';
                socket.destroy();
                return;
              }
              write(msg('NICK', [next]));
              return;
            }
            case '001':
              registered = true;
              this.registered = true;
              clearTimeout(connectTimer);
              this.startTimers();
              break;
            default:
              return;
          }
        }
        this.feed(line);
        if (line.command === '001') this.finishLogin({ ok: true });
      };

      socket.on('data', (chunk: string) => {
        for (const text of splitter.push(chunk)) {
          let line: IrcMessage;
          try {
            line = parseLine(text, LINK_LIMITS);
          } catch {
            continue;
          }
          try {
            onLine(line);
          } catch (error) {
            this.log(`line handler failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      });

      socket.once('connect', () => undefined);
      socket.once(config.ca ? 'secureConnect' : 'connect', () => {
        write(msg('CAP', ['LS', '302']));
        write(msg('NICK', [NICKS[0] ?? 'chamber']));
        write(msg('USER', [ACCOUNT, '0', '*', 'OpenChamber operator view']));
      });
    });
  }

  private writer: ((line: IrcMessage) => void) | null = null;

  private write(line: IrcMessage): void {
    if (!this.registered) throw new Error('Not connected to the IRC server');
    this.writer?.(line);
  }

  /** Queue lines that nobody waits for. They leave at a gentle rate. */
  private enqueue(lines: IrcMessage[]): void {
    this.background.push(...lines);
    if (this.backgroundTimer) return;
    const drain = (): void => {
      const next = this.background.shift();
      if (!next || !this.registered) {
        if (this.backgroundTimer) clearInterval(this.backgroundTimer);
        this.backgroundTimer = null;
        if (!this.registered) this.background = [];
        return;
      }
      this.writer?.(next);
    };
    drain();
    if (this.background.length > 0) this.backgroundTimer = setInterval(drain, 150);
  }

  private startTimers(): void {
    this.lastReceived = Date.now();
    this.timers.push(
      setInterval(() => {
        // Find new channels and join them.
        this.enqueue([msg('LIST')]);
      }, this.listIntervalMs),
      setInterval(() => {
        this.enqueue(this.state.channelNames().map((name) => msg('WHO', [name])));
      }, 60_000),
      setInterval(() => {
        if (Date.now() - this.lastReceived > 180_000) {
          this.socket?.destroy();
          return;
        }
        this.writer?.(msg('PING', ['openchamber']));
      }, 60_000),
    );
  }

  private stopTimers(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    if (this.backgroundTimer) clearInterval(this.backgroundTimer);
    this.backgroundTimer = null;
    this.background = [];
  }

  private failPending(error: string): void {
    for (const [label, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
      this.pending.delete(label);
    }
    this.batchLabels.clear();
  }

  // ---- incoming lines ----

  /** Handle one line after login: request collectors first, then the state machine. */
  feed(line: IrcMessage): void {
    this.resolveLabel(line);
    this.collect(line);
    if (line.command === 'FAIL' && line.params[0] === 'CHATHISTORY') {
      const target = line.params[3] ?? '';
      for (const waiter of this.historyWaiters.splice(0)) {
        if (fold(waiter.target) === fold(target)) waiter.resolve(0);
        else this.historyWaiters.push(waiter);
      }
    }
    const out = this.state.handleLine(line);
    if (out.length > 0) this.enqueue(out);
  }

  private resolveLabel(line: IrcMessage): void {
    if (line.command === 'BATCH' && (line.params[0] ?? '').startsWith('+')) {
      const id = (line.params[0] ?? '').slice(1);
      const own = getTag(line, 'label');
      const parent = getTag(line, 'batch');
      const label = own ?? (parent === undefined ? undefined : this.batchLabels.get(parent));
      if (label !== undefined) this.batchLabels.set(id, label);
    }
    const batch = getTag(line, 'batch');
    const label = getTag(line, 'label') ?? (batch === undefined ? undefined : this.batchLabels.get(batch));
    if (label === undefined) return;
    const pending = this.pending.get(label);
    if (!pending) return;
    const isError = line.command === 'FAIL' || /^[45]\d\d$/.test(line.command);
    const isOk =
      line.command === 'ACK' ||
      ((line.command === 'PRIVMSG' || line.command === 'NOTICE') && (line.source ?? '').includes('!')) ||
      (line.command === 'BATCH' && (line.params[0] ?? '').startsWith('+') && line.params[1] === 'draft/multiline');
    if (!isError && !isOk) return;
    clearTimeout(pending.timer);
    this.pending.delete(label);
    if (isError) pending.resolve({ ok: false, error: line.params[line.params.length - 1] ?? 'The server refused the message' });
    else pending.resolve({ ok: true, ...(getTag(line, 'msgid') ? { msgid: getTag(line, 'msgid') } : {}) });
  }

  private collect(line: IrcMessage): void {
    const c = this.collector;
    if (!c) return;
    const serverSource = !(line.source ?? '').includes('!');
    if (line.command === 'NOTICE' && serverSource) {
      const text = line.params[1] ?? '';
      if (c.isEnd(text)) c.done();
      else c.lines.push(text);
      return;
    }
    if (/^4\d\d$/.test(line.command)) {
      c.error = line.params[line.params.length - 1] ?? 'The server refused the command';
      if (line.command === '401') c.error = `No such nick: ${line.params[1] ?? ''}`;
      c.done();
    }
  }

  // ---- requests ----

  /** Run one request at a time for commands whose answers we cannot tell apart. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private collectNotices(command: IrcMessage, verb: string, endText: string): Promise<{ lines: string[]; error: string | null; timedOut: boolean }> {
    return this.serial(
      () =>
        new Promise((resolve) => {
          let timedOut = false;
          let finished = false;
          const collector: Collector = {
            verb,
            lines: [],
            error: null,
            isEnd: (text) => text === endText,
            done: () => {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              if (this.collector === collector) this.collector = null;
              resolve({ lines: collector.lines, error: collector.error, timedOut });
            },
          };
          const timer = setTimeout(() => {
            timedOut = true;
            collector.done();
          }, 12_000);
          this.collector = collector;
          try {
            this.write(command);
          } catch (error) {
            collector.error = error instanceof Error ? error.message : String(error);
            collector.done();
          }
        }),
    );
  }

  async agent(verb: AgentVerb, target: string): Promise<AgentResponse> {
    const targetError = validateTarget(target);
    if (targetError) return { ok: false, lines: [], error: targetError };
    const result = await this.collectNotices(msg('AGENT', [verb, target]), verb, `end of AGENT ${verb}`);
    const error = result.error ?? (result.timedOut ? 'The server did not finish the request in time' : null);
    return { ok: error === null, lines: result.lines, ...(result.timedOut ? { timedOut: true } : {}), ...(error ? { error } : {}) };
  }

  async claims(): Promise<ClaimsResponse> {
    const result = await this.collectNotices(msg('CLAIMS'), 'CLAIMS', 'end of CLAIMS');
    const claims = result.lines.map(parseClaim).filter((c): c is Claim => c !== null);
    const error = result.error ?? (result.timedOut ? 'The server did not finish the request in time' : null);
    return { ok: error === null, claims, ...(error ? { error } : {}) };
  }

  send(target: string, text: string): Promise<SendResponse> {
    if (!this.registered) return Promise.resolve({ ok: false, error: 'Not connected to the IRC server' });
    const label = `oc${++this.labelCounter}`;
    const ref = `oc${++this.batchCounter}`;
    const plan = planSend(target, text, ref);
    if (typeof plan === 'string') return Promise.resolve({ ok: false, error: plan });
    return new Promise<SendResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(label);
        resolve({ ok: false, error: 'The server did not confirm the message' });
      }, 10_000);
      this.pending.set(label, { resolve, timer });
      try {
        plan.lines.forEach((line, index) => {
          // The label goes on the first line: the PRIVMSG, or the opening BATCH.
          if (index === 0) line.tags.push(['label', label]);
          this.write(line);
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(label);
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  /** Ask for older messages before the oldest one that we hold. Resolves with the number of messages. */
  history(target: string, beforeMsgid: string | undefined): Promise<number> {
    if (!this.registered || validateTarget(target)) return Promise.resolve(0);
    return new Promise((resolve) => {
      const waiter: { target: string; resolve: (count: number) => void } = { target, resolve };
      const timer = setTimeout(() => {
        const at = this.historyWaiters.indexOf(waiter);
        if (at !== -1) this.historyWaiters.splice(at, 1);
        resolve(0);
      }, 8000);
      waiter.resolve = (count: number) => {
        clearTimeout(timer);
        resolve(count);
      };
      this.historyWaiters.push(waiter);
      const ref = beforeMsgid ? `msgid=${beforeMsgid}` : '*';
      try {
        this.write(msg('CHATHISTORY', [beforeMsgid ? 'BEFORE' : 'LATEST', target, ref, '100']));
      } catch {
        waiter.resolve(0);
      }
    });
  }

  join(channel: string): void {
    this.write(msg('JOIN', [channel]));
  }

  part(channel: string): void {
    this.write(msg('PART', [channel]));
  }

  /** Ask the server for history of a new DM. */
  requestLines(lines: IrcMessage[]): void {
    if (this.registered) this.enqueue(lines);
  }
}
