// A fake plugin link for tests. It logs in with the link token, introduces one or more agent accounts,
// and can send messages and answer AGENT requests, like the opencode plugin does.
import net from 'node:net';
import { LINK_LIMITS, LineSplitter, getTag, msg, parseLine, serializeLine, type IrcMessage } from '../../plugin/src/proto.ts';

export interface FakeAgentOptions {
  host: string;
  port: number;
  token: string;
  linkName?: string;
}

export interface AgentSpec {
  account: string;
  nick: string;
  parent?: string;
  project: string;
  state?: 'busy' | 'idle';
}

export class FakeLink {
  readonly lines: IrcMessage[] = [];
  private socket!: net.Socket;
  private waiters: Array<{ predicate: (m: IrcMessage) => boolean; resolve: (m: IrcMessage) => void; timer: ReturnType<typeof setTimeout>; reject: (e: Error) => void }> = [];
  private counter = 0;
  /** Reply text for AGENT requests: `${verb}` -> text. */
  agentReplies: Record<string, string> = { STATUS: 'busy, editing src/auth.rs', INTERRUPT: 'interrupted', RESUME: 'resumed' };

  constructor(private readonly options: FakeAgentOptions) {}

  async connect(agents: AgentSpec[]): Promise<void> {
    this.socket = net.connect({ host: this.options.host, port: this.options.port });
    await new Promise<void>((resolve, reject) => {
      this.socket.once('connect', () => resolve());
      this.socket.once('error', reject);
    });
    this.socket.setEncoding('utf8');
    const splitter = new LineSplitter();
    this.socket.on('data', (chunk: string) => {
      for (const text of splitter.push(chunk)) {
        let line: IrcMessage;
        try {
          line = parseLine(text, LINK_LIMITS);
        } catch {
          continue;
        }
        this.receive(line);
      }
    });
    this.socket.on('error', () => undefined);
    this.write(msg('LINK', ['1', this.options.linkName ?? 'svc-test.prj-test', this.options.token]));
    await this.waitFor((l) => l.command === 'LINKED');
    this.write(msg('BURST'));
    for (const a of agents) {
      this.write(msg('INTRODUCE', [a.account, a.nick, a.parent ?? '*', 'operator', 'agent', a.project, `${a.nick} title`]));
    }
    for (const a of agents) this.write(msg('STATE', [a.account, a.state ?? 'idle']));
    this.write(msg('ENDBURST'));
    // The server burst ends with its own ENDBURST (after BURST).
    await this.waitFor((l) => l.command === 'ENDBURST');
  }

  private receive(line: IrcMessage): void {
    this.lines.push(line);
    if (line.command === 'PING') this.write(msg('PONG', line.params));
    if (line.command === 'AGENT') {
      const [id, verb, account] = line.params;
      this.write(msg('AGENTREPLY', [id ?? '', account ?? '', this.agentReplies[verb ?? ''] ?? 'ok']));
      this.write(msg('AGENTEND', [id ?? '']));
    }
    for (const w of [...this.waiters]) {
      if (w.predicate(line)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(line);
      }
    }
  }

  write(line: IrcMessage): void {
    this.socket.write(`${serializeLine(line)}\r\n`);
  }

  /** Wait for a line. Lines received at or after index `since` count, also when they came earlier. */
  waitFor(predicate: (m: IrcMessage) => boolean, ms = 8000, since = 0): Promise<IrcMessage> {
    for (let i = since; i < this.lines.length; i += 1) {
      const line = this.lines[i]!;
      if (predicate(line)) return Promise.resolve(line);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake link timeout. Last lines:\n${this.lines.slice(-10).map(serializeLine).join('\n')}`)), ms);
      this.waiters.push({ predicate, resolve, timer, reject });
    });
  }

  /** Send an inner client line as the account and wait for SENT or SENDFAIL. */
  async say(account: string, inner: string, tags = ''): Promise<{ ok: boolean; msgid?: string; reason?: string }> {
    const label = `f${++this.counter}`;
    const reply = this.waitFor((l) => getTag(l, 'label') === label && (l.command === 'SENT' || l.command === 'SENDFAIL' || l.command === 'FAIL'), 8000, this.lines.length);
    this.write(msg('SEND', [account, tags === '' ? inner : `@${tags} ${inner}`], { tags: [['label', label]] }));
    const r = await reply;
    if (r.command === 'SENT') return { ok: true, msgid: r.params[1] ?? '' };
    return { ok: false, reason: r.params[r.params.length - 1] ?? '' };
  }

  setState(account: string, state: 'busy' | 'idle'): void {
    this.write(msg('STATE', [account, state]));
  }

  retire(account: string): void {
    this.write(msg('RETIRE', [account, 'done']));
  }

  close(): void {
    this.socket?.destroy();
  }
}
