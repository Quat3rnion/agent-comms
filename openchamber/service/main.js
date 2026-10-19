// service/main.ts
import { timingSafeEqual } from "node:crypto";
import http from "node:http";

// service/client.ts
import net from "node:net";
import tls from "node:tls";

// ../plugin/src/proto.ts
var CLIENT_LIMITS = { body: 512, tags: 8191 };
var LINK_LIMITS = { body: 65536, tags: 8191 };
var MAX_PARAMS = 15;

class ParseError extends Error {
  code;
  constructor(code) {
    super(`IRC parse error: ${code}`);
    this.code = code;
    this.name = "ParseError";
  }
}
var encoder = new TextEncoder;
function byteLength(s) {
  return encoder.encode(s).length;
}
function escapeTagValue(v) {
  let out = "";
  for (const ch of v) {
    switch (ch) {
      case ";":
        out += "\\:";
        break;
      case " ":
        out += "\\s";
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\r":
        out += "\\r";
        break;
      case `
`:
        out += "\\n";
        break;
      default:
        out += ch;
    }
  }
  return out;
}
function unescapeTagValue(v) {
  let out = "";
  let i = 0;
  while (i < v.length) {
    const ch = v.charAt(i);
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    if (i + 1 >= v.length)
      break;
    const cp = v.codePointAt(i + 1);
    const next = String.fromCodePoint(cp);
    switch (next) {
      case ":":
        out += ";";
        break;
      case "s":
        out += " ";
        break;
      case "r":
        out += "\r";
        break;
      case "n":
        out += `
`;
        break;
      default:
        out += next;
    }
    i += 1 + next.length;
  }
  return out;
}
function parseTags(section) {
  const tags = [];
  for (const part of section.split(";")) {
    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    if (key === "")
      throw new ParseError("InvalidTag");
    let value = null;
    if (eq !== -1) {
      const raw = unescapeTagValue(part.slice(eq + 1));
      value = raw === "" ? null : raw;
    }
    const existing = tags.findIndex((t) => t[0] === key);
    if (existing !== -1) {
      const entry = tags[existing];
      if (entry)
        entry[1] = value;
    } else {
      tags.push([key, value]);
    }
  }
  return tags;
}
function skipSpaces(s, from) {
  let i = from;
  while (i < s.length && s.charCodeAt(i) === 32)
    i += 1;
  return i;
}
function parseLine(line, limits = LINK_LIMITS) {
  let s = line;
  if (s.endsWith(`\r
`))
    s = s.slice(0, -2);
  else if (s.endsWith(`
`))
    s = s.slice(0, -1);
  if (s.includes("\r") || s.includes(`
`) || s.includes("\x00")) {
    throw new ParseError("ContainsNewline");
  }
  if (s === "")
    throw new ParseError("Empty");
  let pos = 0;
  let tags = [];
  if (s.startsWith("@")) {
    let end = s.indexOf(" ");
    if (end === -1)
      end = s.length;
    const section = s.slice(0, end);
    if (byteLength(section) > limits.tags)
      throw new ParseError("TagsTooLong");
    tags = parseTags(section.slice(1));
    pos = skipSpaces(s, end);
  }
  const body = s.slice(pos);
  if (byteLength(body) + 2 > limits.body)
    throw new ParseError("BodyTooLong");
  let i = 0;
  let source = null;
  if (body.startsWith(":")) {
    let end = body.indexOf(" ");
    if (end === -1)
      end = body.length;
    source = body.slice(1, end);
    i = skipSpaces(body, end);
  }
  let cmdEnd = body.indexOf(" ", i);
  if (cmdEnd === -1)
    cmdEnd = body.length;
  const command = body.slice(i, cmdEnd);
  if (command === "")
    throw new ParseError("MissingCommand");
  if (!/^(?:[A-Za-z]+|[0-9]{3})$/.test(command))
    throw new ParseError("InvalidCommand");
  i = cmdEnd;
  const params = [];
  for (;; ) {
    i = skipSpaces(body, i);
    if (i >= body.length)
      break;
    if (params.length >= MAX_PARAMS)
      throw new ParseError("TooManyParams");
    if (body.charAt(i) === ":") {
      params.push(body.slice(i + 1));
      break;
    }
    let end = body.indexOf(" ", i);
    if (end === -1)
      end = body.length;
    params.push(body.slice(i, end));
    i = end;
  }
  return { tags, source, command, params };
}
function serializeLine(m) {
  let out = "";
  if (m.tags.length > 0) {
    out += "@" + m.tags.map(([k, v]) => v === null || v === "" ? k : `${k}=${escapeTagValue(v)}`).join(";") + " ";
  }
  if (m.source)
    out += `:${m.source} `;
  out += m.command;
  const last = m.params.length - 1;
  m.params.forEach((p, idx) => {
    const trailing = idx === last && (p === "" || p.includes(" ") || p.startsWith(":"));
    out += " " + (trailing ? ":" : "") + p;
  });
  return out;
}
function getTag(m, key) {
  const entry = m.tags.find((t) => t[0] === key);
  if (!entry)
    return;
  return entry[1] ?? "";
}
function msg(command, params = [], opts = {}) {
  return {
    tags: opts.tags ?? [],
    source: opts.source ?? null,
    command,
    params
  };
}
class LineSplitter {
  buf = "";
  push(chunk) {
    this.buf += chunk;
    const pieces = this.buf.split(`
`);
    this.buf = pieces.pop() ?? "";
    const lines = [];
    for (const piece of pieces) {
      const line = piece.endsWith("\r") ? piece.slice(0, -1) : piece;
      if (line !== "")
        lines.push(line);
    }
    return lines;
  }
  get pending() {
    return this.buf;
  }
}

// service/config.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var configDir = (env = process.env) => {
  const override = env.AGENT_COMMS_CONFIG_DIR;
  if (override)
    return path.resolve(override);
  const xdg = env.XDG_CONFIG_HOME;
  return path.join(xdg ? xdg : path.join(os.homedir(), ".config"), "agent-comms");
};
var unquote = (raw) => {
  const value = raw.trim();
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(value) ?? /^'([^']*)'/.exec(value);
  if (!match)
    return null;
  return (match[1] ?? "").replace(/\\(.)/g, "$1");
};
var parseToml = (text) => {
  const values = {};
  let table = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#"))
      continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      table = (header[1] ?? "").trim();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1)
      continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1));
    if (value !== null)
      values[table === "" ? key : `${table}.${key}`] = value;
  }
  return values;
};
var parseBind = (bind) => {
  const at = bind.lastIndexOf(":");
  if (at === -1)
    return null;
  const port = Number(bind.slice(at + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    return null;
  let host = bind.slice(0, at).replace(/^\[|\]$/g, "");
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "*")
    host = "127.0.0.1";
  return { host, port };
};
var readConnectionConfig = (dir) => {
  const file = path.join(dir, "config.toml");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`Cannot read ${file}. Install agent-comms first.`);
  }
  const toml = parseToml(text);
  const bind = parseBind(toml.bind ?? "127.0.0.1:6667");
  if (!bind)
    throw new Error(`Invalid bind address in ${file}`);
  let ca = null;
  const cert = toml["tls.cert"];
  if (cert !== undefined) {
    const certPath = path.isAbsolute(cert) ? cert : path.join(dir, cert);
    try {
      ca = fs.readFileSync(certPath, "utf8");
    } catch {
      throw new Error(`Cannot read the TLS certificate ${certPath}`);
    }
  }
  return { host: bind.host, port: bind.port, ca, serverName: toml.server_name ?? "irc.agent-comms.local" };
};
var passwordFile = (dir) => path.join(dir, "openchamber-operator.json");
var loadPassword = (dir) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(passwordFile(dir), "utf8"));
    if (typeof parsed === "object" && parsed !== null && "password" in parsed) {
      const value = parsed.password;
      if (typeof value === "string" && value !== "")
        return value;
    }
  } catch {}
  return null;
};
var savePassword = (dir, password) => {
  fs.mkdirSync(dir, { recursive: true, mode: 448 });
  const file = passwordFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ password }), { mode: 384 });
  fs.chmodSync(tmp, 384);
  fs.renameSync(tmp, file);
};
var deletePassword = (dir) => {
  try {
    fs.rmSync(passwordFile(dir), { force: true });
  } catch {}
};

// service/state.ts
var TAG_ROLE = "agent-comms.local/role";
var TAG_BROADCAST = "agent-comms.local/broadcast";
var RFC1459_MAP = { "[": "{", "]": "}", "\\": "|", "~": "^" };
var fold = (name) => name.toLowerCase().replace(/[[\]\\~]/g, (ch) => RFC1459_MAP[ch] ?? ch);
var isChannelName = (name) => name.startsWith("#") || name.startsWith("&");
var nickOf = (m) => {
  const source = m.source ?? "";
  const bang = source.indexOf("!");
  return bang === -1 ? source : source.slice(0, bang);
};
var escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var toAway = (reason) => {
  if (reason === undefined || reason === "")
    return null;
  return reason.trim().toLowerCase() === "dormant" ? "dormant" : "idle";
};
var joinNames = (list) => {
  const lines = [];
  let current = [];
  let size = 0;
  for (const name of list) {
    if (size + name.length + 1 > 380 && current.length > 0) {
      lines.push(current.join(","));
      current = [];
      size = 0;
    }
    current.push(name);
    size += name.length + 1;
  }
  if (current.length > 0)
    lines.push(current.join(","));
  return lines;
};
var isBoundary = (c) => /\s/.test(c) || /[!-/:-@[-`{-~]/.test(c) && c !== "@" && c !== "-" && c !== "_";
var hasWord = (text, word) => {
  for (let i = text.indexOf(word);i !== -1; i = text.indexOf(word, i + 1)) {
    const end = i + word.length;
    if ((i === 0 || isBoundary(text.charAt(i - 1))) && (end === text.length || isBoundary(text.charAt(end))))
      return true;
  }
  return false;
};
var detectBroadcast = (text) => {
  if (hasWord(text, "@all"))
    return "all";
  if (hasWord(text, "@here"))
    return "here";
  return "";
};
var timestampParam = (ms) => `timestamp=${new Date(ms).toISOString()}`;

class ChamberState {
  epoch = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  seq = 0;
  nick = "";
  serverName = "";
  connected = false;
  needsLogin = false;
  error = null;
  onHistoryDone = null;
  now;
  ringSize;
  systemLimit;
  eventLogSize;
  backlog;
  account;
  channels = new Map;
  targets = new Map;
  dms = new Map;
  awayCache = new Map;
  batches = new Map;
  joinAttempts = new Map;
  listed = null;
  events = [];
  droppedThrough = 0;
  waiters = new Set;
  mentionRe = null;
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    this.ringSize = options.ringSize ?? 500;
    this.systemLimit = options.systemLimit ?? 150;
    this.eventLogSize = options.eventLogSize ?? 5000;
    this.backlog = options.backlog ?? 100;
    this.account = (options.account ?? "operator").toLowerCase();
  }
  setStatus(status) {
    const before = `${this.connected}|${this.needsLogin}|${this.error}`;
    if (status.connected !== undefined)
      this.connected = status.connected;
    if (status.needsLogin !== undefined)
      this.needsLogin = status.needsLogin;
    if (status.error !== undefined)
      this.error = status.error;
    if (before === `${this.connected}|${this.needsLogin}|${this.error}`)
      return;
    this.emit({ type: "connection", connected: this.connected, needsLogin: this.needsLogin, error: this.error });
  }
  onDisconnected() {
    this.batches.clear();
    this.listed = null;
    this.joinAttempts.clear();
    for (const chan of this.channels.values()) {
      chan.joined = false;
      chan.namesOpen = false;
    }
    this.setStatus({ connected: false });
  }
  handleLine(m) {
    switch (m.command) {
      case "001":
        return this.onWelcome(m);
      case "BATCH":
        return this.onBatch(m);
      case "PRIVMSG":
      case "NOTICE":
        return this.onChatLine(m);
      case "CHATHISTORY":
        return this.onChatHistoryLine(m);
      case "JOIN":
        return this.onJoin(m);
      case "PART":
        this.onPart(nickOf(m), m.params[0] ?? "", m.params[1], "part");
        return [];
      case "KICK":
        this.onPart(m.params[1] ?? "", m.params[0] ?? "", m.params[2], "part");
        return [];
      case "QUIT":
        this.onQuit(nickOf(m), m.params[0]);
        return [];
      case "NICK":
        this.onNick(nickOf(m), m.params[0] ?? "");
        return [];
      case "AWAY":
        this.onAway(nickOf(m), toAway(m.params[0]));
        return [];
      case "TOPIC":
        this.onTopic(nickOf(m), m.params[0] ?? "", m.params[1] ?? "");
        return [];
      case "332":
        this.setTopic(m.params[1] ?? "", m.params[2] ?? "");
        return [];
      case "353":
        this.onNames(m);
        return [];
      case "322":
        (this.listed ??= []).push(m.params[1] ?? "");
        return [];
      case "323":
        return this.onListEnd();
      case "352":
        return this.onWhoReply(m);
      case "315":
        this.onWhoEnd(m.params[1] ?? "");
        return [];
      case "301":
        this.onAway(m.params[1] ?? "", toAway(m.params[2]), true);
        return [];
      default:
        return [];
    }
  }
  onWelcome(m) {
    this.nick = m.params[0] ?? this.nick;
    if (m.source)
      this.serverName = m.source;
    this.mentionRe = null;
    this.setStatus({ connected: true, needsLogin: false, error: null });
    const now = this.now();
    return [
      msg("LIST"),
      msg("CHATHISTORY", ["TARGETS", timestampParam(now - 7 * 86400000), timestampParam(now + 60000), "50"])
    ];
  }
  onBatch(m) {
    const ref = m.params[0] ?? "";
    if (ref.startsWith("+")) {
      const id = ref.slice(1);
      this.batches.set(id, {
        id,
        type: m.params[1] ?? "",
        args: m.params.slice(2),
        parent: getTag(m, "batch"),
        tags: m.tags,
        source: m.source,
        lines: [],
        count: 0,
        items: []
      });
      return [];
    }
    if (!ref.startsWith("-"))
      return [];
    const id = ref.slice(1);
    const batch = this.batches.get(id);
    if (!batch)
      return [];
    this.batches.delete(id);
    if (batch.type === "draft/multiline")
      return this.finishMultiline(batch);
    if (batch.type === "chathistory") {
      const target = batch.args[0] ?? "";
      const t = this.targets.get(fold(target));
      if (batch.count === 0 && t)
        t.exhausted = true;
      if (batch.count > 0)
        this.emit({ type: "history", target });
      this.onHistoryDone?.(target, batch.count);
      return [];
    }
    if (batch.type === "draft/chathistory-targets")
      return this.finishTargets(batch);
    return [];
  }
  isHistory(batchId) {
    let id = batchId;
    for (let depth = 0;id !== undefined && depth < 8; depth += 1) {
      const b = this.batches.get(id);
      if (!b)
        return false;
      if (b.type === "chathistory")
        return true;
      id = b.parent;
    }
    return false;
  }
  noteHistory(batchId) {
    let id = batchId;
    for (let depth = 0;id !== undefined && depth < 8; depth += 1) {
      const b = this.batches.get(id);
      if (!b)
        return;
      if (b.type === "chathistory") {
        b.count += 1;
        return;
      }
      id = b.parent;
    }
  }
  finishMultiline(batch) {
    const first = batch.lines[0];
    if (!first)
      return [];
    let text = "";
    batch.lines.forEach((line, index) => {
      if (index > 0 && !line.concat)
        text += `
`;
      text += line.text;
    });
    const open = { tags: batch.tags, source: batch.source, command: first.command, params: [first.target, text] };
    const history = this.isHistory(batch.parent);
    const out = this.deliverChat(open, history);
    if (history)
      this.noteHistory(batch.parent);
    return out;
  }
  finishTargets(batch) {
    const out = [];
    for (const item of batch.items) {
      const name = item.target;
      if (isChannelName(name))
        continue;
      if (fold(name) === fold(this.nick) || fold(name) === this.account)
        continue;
      out.push(...this.ensureDm(name));
    }
    return out;
  }
  onChatHistoryLine(m) {
    if ((m.params[0] ?? "").toUpperCase() !== "TARGETS")
      return [];
    const id = getTag(m, "batch");
    const batch = id === undefined ? undefined : this.batches.get(id);
    if (batch)
      batch.items.push({ target: m.params[1] ?? "" });
    return [];
  }
  onChatLine(m) {
    const source = m.source ?? "";
    if (!source.includes("!"))
      return [];
    const batchId = getTag(m, "batch");
    if (batchId !== undefined) {
      const batch = this.batches.get(batchId);
      if (batch?.type === "draft/multiline") {
        batch.lines.push({
          command: m.command,
          target: m.params[0] ?? "",
          text: m.params[1] ?? "",
          concat: getTag(m, "draft/multiline-concat") !== undefined
        });
        return [];
      }
    }
    const history = this.isHistory(batchId);
    const out = this.deliverChat(m, history);
    if (history)
      this.noteHistory(batchId);
    return out;
  }
  isSelf(from, account) {
    if (from !== "" && fold(from) === fold(this.nick))
      return true;
    return account !== "" && account.toLowerCase() === this.account;
  }
  mentions(text) {
    if (!this.mentionRe) {
      const names = ["operator", "chamber\\d*"];
      if (this.nick)
        names.push(escapeRegExp(this.nick));
      this.mentionRe = new RegExp(`(^|[^\\w-])@?(${names.join("|")})(?![\\w-])`, "i");
    }
    return this.mentionRe.test(text);
  }
  deliverChat(m, history) {
    const from = nickOf(m);
    const account = getTag(m, "account") ?? "";
    let dest = m.params[0] ?? "";
    const text = m.params[1] ?? "";
    if (/^[@+%&~][#&]/.test(dest))
      dest = dest.slice(1);
    const self = this.isSelf(from, account);
    const out = [];
    let target;
    let dmIn = false;
    const channelTarget = isChannelName(dest);
    if (channelTarget) {
      target = this.channels.get(fold(dest))?.name ?? dest;
    } else {
      const partner = self ? dest : from;
      if (partner === "" || fold(partner) === fold(this.nick) || fold(partner) === this.account)
        return out;
      target = this.dms.get(fold(partner)) ?? partner;
      dmIn = !self;
      out.push(...this.ensureDm(target));
    }
    const roleTag = getTag(m, TAG_ROLE) ?? (history ? account.toLowerCase() === this.account ? "operator" : account !== "" ? "agent" : "" : "");
    const role = roleTag === "operator" ? "operator" : roleTag === "agent" ? "agent" : "";
    const bc = getTag(m, TAG_BROADCAST) ?? (history && channelTarget ? detectBroadcast(text) : "");
    const broadcast = bc === "here" || bc === "all" ? bc : "";
    const timeTag = getTag(m, "time");
    const parsed = timeTag ? Date.parse(timeTag) : NaN;
    const kind = m.command === "NOTICE" ? "notice" : "privmsg";
    const message = {
      seq: 0,
      msgid: getTag(m, "msgid") ?? "",
      time: Number.isNaN(parsed) ? this.now() : parsed,
      target,
      from,
      text,
      kind,
      role,
      broadcast,
      self,
      mention: !self && !history && (dmIn || broadcast !== "" || this.mentions(text)),
      history
    };
    this.store(message, history);
    return out;
  }
  ensureDm(name) {
    const key = fold(name);
    if (this.dms.has(key))
      return [];
    this.dms.set(key, name);
    this.target(name);
    this.emit({ type: "channels" });
    return [msg("CHATHISTORY", ["LATEST", name, "*", String(Math.min(this.backlog, 50))])];
  }
  target(name) {
    const key = fold(name);
    let t = this.targets.get(key);
    if (!t) {
      t = { name, messages: [], ids: new Set, systemCount: 0, exhausted: false, readSeq: 0 };
      this.targets.set(key, t);
    }
    return t;
  }
  store(message, history) {
    const t = this.target(message.target);
    if (message.msgid !== "" && t.ids.has(message.msgid))
      return;
    message.seq = ++this.seq;
    if (message.msgid !== "")
      t.ids.add(message.msgid);
    const system = message.kind !== "privmsg" && message.kind !== "notice";
    if (system)
      t.systemCount += 1;
    if (!history || t.messages.length === 0 || t.messages[t.messages.length - 1].time <= message.time) {
      t.messages.push(message);
    } else {
      let index = t.messages.length;
      while (index > 0 && t.messages[index - 1].time > message.time)
        index -= 1;
      t.messages.splice(index, 0, message);
    }
    if (system && t.systemCount > this.systemLimit) {
      const at = t.messages.findIndex((x) => x.kind !== "privmsg" && x.kind !== "notice");
      if (at !== -1) {
        t.messages.splice(at, 1);
        t.systemCount -= 1;
      }
    }
    while (t.messages.length > this.ringSize) {
      const old = t.messages.shift();
      if (!old)
        break;
      if (old.msgid !== "")
        t.ids.delete(old.msgid);
      if (old.kind !== "privmsg" && old.kind !== "notice")
        t.systemCount -= 1;
    }
    if (!history)
      this.pushEvent({ seq: message.seq, type: "message", message });
  }
  system(channel, kind, from, text) {
    this.store({
      seq: 0,
      msgid: "",
      time: this.now(),
      target: channel,
      from,
      text,
      kind,
      role: "",
      broadcast: "",
      self: false,
      mention: false,
      history: false
    }, false);
  }
  chan(name) {
    return this.channels.get(fold(name));
  }
  membersOf(chan) {
    return [...chan.members.values()].sort((a, b) => a.nick.localeCompare(b.nick));
  }
  emitMembers(chan) {
    this.emit({ type: "members", channel: chan.name, members: this.membersOf(chan) });
  }
  onJoin(m) {
    const nick = nickOf(m);
    const name = m.params[0] ?? "";
    if (!name)
      return [];
    if (fold(nick) === fold(this.nick)) {
      const previous = this.chan(name);
      const chan = { name, topic: previous?.topic ?? "", members: new Map, joined: true, namesOpen: false, whoDirty: false };
      this.channels.set(fold(name), chan);
      this.joinAttempts.delete(fold(name));
      this.target(name);
      this.emit({ type: "channels" });
      return [
        msg("CHATHISTORY", ["LATEST", name, "*", String(this.backlog)]),
        msg("WHO", [name])
      ];
    }
    const chan = this.chan(name);
    if (!chan)
      return [];
    chan.members.set(fold(nick), {
      nick,
      away: this.awayCache.get(fold(nick)) ?? null,
      op: false,
      operator: getTag(m, TAG_ROLE) === "operator"
    });
    this.system(chan.name, "join", nick, "joined");
    this.emitMembers(chan);
    return [];
  }
  onPart(nick, name, reason, kind) {
    const chan = this.chan(name);
    if (!chan)
      return;
    if (fold(nick) === fold(this.nick)) {
      this.channels.delete(fold(name));
      this.targets.delete(fold(name));
      this.emit({ type: "channels" });
      return;
    }
    if (!chan.members.delete(fold(nick)))
      return;
    this.system(chan.name, kind, nick, reason ? `left (${reason})` : "left");
    this.emitMembers(chan);
  }
  onQuit(nick, reason) {
    if (fold(nick) === fold(this.nick))
      return;
    this.awayCache.delete(fold(nick));
    for (const chan of this.channels.values()) {
      if (!chan.members.delete(fold(nick)))
        continue;
      this.system(chan.name, "quit", nick, reason ? `quit (${reason})` : "quit");
      this.emitMembers(chan);
    }
  }
  onNick(oldNick, newNick) {
    if (!newNick)
      return;
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
      if (!member)
        continue;
      chan.members.delete(fold(oldNick));
      chan.members.set(fold(newNick), { ...member, nick: newNick });
      this.system(chan.name, "nick", oldNick, `is now known as ${newNick}`);
      this.emitMembers(chan);
    }
  }
  onAway(nick, away, quiet = false) {
    if (!nick)
      return;
    if (away === null)
      this.awayCache.delete(fold(nick));
    else
      this.awayCache.set(fold(nick), away);
    for (const chan of this.channels.values()) {
      const member = chan.members.get(fold(nick));
      if (!member || member.away === away)
        continue;
      member.away = away;
      if (!quiet)
        this.system(chan.name, "away", nick, away === null ? "is active" : `is ${away}`);
      this.emitMembers(chan);
    }
  }
  onTopic(nick, name, topic) {
    const chan = this.setTopic(name, topic);
    if (chan)
      this.system(chan.name, "topic", nick, topic === "" ? "cleared the topic" : `set the topic: ${topic}`);
  }
  setTopic(name, topic) {
    const chan = this.chan(name);
    if (!chan)
      return;
    chan.topic = topic;
    this.emit({ type: "topic", channel: chan.name, topic });
    return chan;
  }
  onNames(m) {
    const chan = this.chan(m.params[2] ?? "");
    if (!chan)
      return;
    if (!chan.namesOpen) {
      chan.members.clear();
      chan.namesOpen = true;
    }
    for (const raw of (m.params[3] ?? "").split(" ")) {
      if (raw === "")
        continue;
      const prefix = /^[~&@%+]*/.exec(raw)?.[0] ?? "";
      const nick = raw.slice(prefix.length);
      if (!nick)
        continue;
      chan.members.set(fold(nick), {
        nick,
        away: this.awayCache.get(fold(nick)) ?? null,
        op: /[~&@]/.test(prefix),
        operator: false
      });
    }
    this.emitMembers(chan);
  }
  onWhoReply(m) {
    const chan = this.chan(m.params[1] ?? "");
    if (!chan)
      return [];
    const nick = m.params[5] ?? "";
    const flags = m.params[6] ?? "";
    const member = chan.members.get(fold(nick));
    if (!member)
      return [];
    const gone = flags.startsWith("G");
    const operator = flags.includes("*");
    const op = /[~&@]/.test(flags);
    let away = null;
    let ask = false;
    if (gone) {
      const known = this.awayCache.get(fold(nick));
      away = known ?? member.away ?? "idle";
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
    return ask ? [msg("WHOIS", [nick])] : [];
  }
  onWhoEnd(mask) {
    const chan = this.chan(mask);
    if (!chan || !chan.whoDirty)
      return;
    chan.whoDirty = false;
    this.emitMembers(chan);
  }
  onListEnd() {
    const listed = this.listed ?? [];
    this.listed = null;
    const now = this.now();
    const missing = listed.filter((name) => {
      if (!isChannelName(name) || this.channels.get(fold(name))?.joined)
        return false;
      const last = this.joinAttempts.get(fold(name)) ?? 0;
      return now - last > 20000;
    });
    for (const name of missing)
      this.joinAttempts.set(fold(name), now);
    return joinNames(missing).map((names) => msg("JOIN", [names]));
  }
  channelNames() {
    return [...this.channels.values()].map((c) => c.name);
  }
  hasChannel(name) {
    return this.channels.has(fold(name));
  }
  members(channel) {
    const chan = this.chan(channel);
    return chan ? this.membersOf(chan) : [];
  }
  topic(channel) {
    return this.chan(channel)?.topic ?? "";
  }
  dmNames() {
    return [...this.dms.values()].sort((a, b) => a.localeCompare(b));
  }
  addDm(name) {
    return this.ensureDm(name);
  }
  messageCount(target) {
    return this.targets.get(fold(target))?.messages.length ?? 0;
  }
  oldestMsgid(target) {
    return this.targets.get(fold(target))?.messages.find((x) => x.msgid !== "")?.msgid;
  }
  isExhausted(target) {
    return this.targets.get(fold(target))?.exhausted ?? false;
  }
  unreadFor(target) {
    let unread = 0;
    let mentions = 0;
    for (const message of target.messages) {
      if (message.seq <= target.readSeq || message.self || message.history)
        continue;
      if (message.kind !== "privmsg" && message.kind !== "notice")
        continue;
      unread += 1;
      if (message.mention)
        mentions += 1;
    }
    return { unread, mentions };
  }
  markRead(target, seq) {
    const t = this.targets.get(fold(target));
    if (t && seq > t.readSeq)
      t.readSeq = seq;
  }
  snapshot() {
    const channels = [...this.channels.values()].sort((a, b) => {
      if (a.name === "#lobby")
        return -1;
      if (b.name === "#lobby")
        return 1;
      return a.name.localeCompare(b.name);
    }).map((c) => ({ name: c.name, topic: c.topic, members: this.membersOf(c) }));
    const unread = {};
    const last = {};
    for (const t of this.targets.values()) {
      const info = this.unreadFor(t);
      if (info.unread > 0)
        unread[t.name] = info;
      const tail = t.messages.filter((x) => x.kind === "privmsg" || x.kind === "notice").pop();
      if (tail)
        last[t.name] = tail.time;
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
      seq: this.seq
    };
  }
  page(target, before, limit, maxBytes = 200000) {
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
      const dropped = slice[0];
      size -= dropped.text.length + 300;
      slice = slice.slice(1);
      start += 1;
    }
    return {
      epoch: this.epoch,
      target: t?.name ?? target,
      messages: slice,
      hasMore: start > 0 || !(t?.exhausted ?? false),
      seq: this.seq
    };
  }
  emit(event) {
    this.pushEvent({ ...event, seq: ++this.seq });
  }
  pushEvent(event) {
    this.events.push(event);
    while (this.events.length > this.eventLogSize) {
      const old = this.events.shift();
      if (old)
        this.droppedThrough = old.seq;
    }
    for (const waiter of [...this.waiters]) {
      if (event.seq > waiter.after)
        waiter.wake();
    }
  }
  collect(after) {
    let from = this.events.length;
    while (from > 0 && this.events[from - 1].seq > after)
      from -= 1;
    const out = [];
    let size = 0;
    let truncated = false;
    for (let i = from;i < this.events.length; i += 1) {
      const event = this.events[i];
      const bytes = JSON.stringify(event).length;
      if (out.length >= 300 || out.length > 0 && size + bytes > 200000) {
        truncated = true;
        break;
      }
      out.push(event);
      size += bytes;
    }
    const last = out[out.length - 1];
    return { epoch: this.epoch, seq: truncated && last ? last.seq : this.seq, events: out };
  }
  poll(after, epoch, waitMs, signal) {
    const stale = epoch !== null && epoch !== "" && epoch !== this.epoch || after > this.seq || after < this.droppedThrough;
    if (stale)
      return Promise.resolve({ epoch: this.epoch, seq: this.seq, events: [], reset: true });
    const ready = this.events.length > 0 && this.events[this.events.length - 1].seq > after;
    if (ready || waitMs <= 0 || signal?.aborted)
      return Promise.resolve(this.collect(after));
    return new Promise((resolve) => {
      let timer;
      const waiter = {
        after,
        wake: () => finish()
      };
      const finish = () => {
        if (timer)
          clearTimeout(timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener("abort", finish);
        resolve(this.collect(after));
      };
      this.waiters.add(waiter);
      timer = setTimeout(finish, waitMs);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
}

// service/client.ts
var WANTED_CAPS = [
  "message-tags",
  "server-time",
  "account-tag",
  "away-notify",
  "echo-message",
  "batch",
  "labeled-response",
  "draft/chathistory",
  "draft/read-marker",
  "draft/multiline"
];
var MAX_MESSAGE_BYTES = 16384;
var MAX_LINES = 200;
var NICKS = ["chamber", "chamber2", "chamber3", "chamber4", "chamber5", "chamber6"];
var ACCOUNT = "operator";
var byteLength2 = (s) => Buffer.byteLength(s, "utf8");
var chunkText = (text, max) => {
  if (byteLength2(text) <= max)
    return [text];
  const chunks = [];
  let current = "";
  let size = 0;
  for (const ch of text) {
    const bytes = byteLength2(ch);
    if (size + bytes > max) {
      chunks.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  if (current !== "")
    chunks.push(current);
  return chunks;
};
var validateTarget = (target) => {
  if (target === "" || target.length > 200)
    return "Invalid target";
  if (/[\s,\u0000-\u001f\u007f]/.test(target))
    return "Invalid target";
  if (!isChannelName(target) && /^[:@+%~]/.test(target))
    return "Invalid target";
  return null;
};
var planSend = (target, text, ref) => {
  const targetError = validateTarget(target);
  if (targetError)
    return targetError;
  if (/[\r\u0000]/.test(text))
    return "The message contains a carriage return or a NUL character";
  if (text.trim() === "")
    return "The message is empty";
  if (byteLength2(text) > MAX_MESSAGE_BYTES)
    return `The message is longer than ${MAX_MESSAGE_BYTES} bytes`;
  const max = CLIENT_LIMITS.body - 2 - byteLength2(`PRIVMSG ${target} :`) - 2;
  const rows = text.split(`
`);
  const single = rows.length === 1 && byteLength2(text) <= max;
  if (single)
    return { lines: [msg("PRIVMSG", [target, text])], batch: false };
  const lines = [msg("BATCH", [`+${ref}`, "draft/multiline", target])];
  let count = 0;
  for (const row of rows) {
    const chunks = chunkText(row, max);
    chunks.forEach((chunk, index) => {
      const tags = [["batch", ref]];
      if (index > 0)
        tags.push(["draft/multiline-concat", null]);
      lines.push(msg("PRIVMSG", [target, chunk], { tags }));
      count += 1;
    });
    if (chunks.length === 0) {
      lines.push(msg("PRIVMSG", [target, ""], { tags: [["batch", ref]] }));
      count += 1;
    }
  }
  if (count > MAX_LINES)
    return `The message has too many lines (limit ${MAX_LINES})`;
  lines.push(msg("BATCH", [`-${ref}`]));
  return { lines, batch: true };
};
var parseClaim = (text) => {
  const match = /^(\S+) holds (.+) since (\d+) until (\d+)$/.exec(text);
  if (!match)
    return null;
  return { nick: match[1] ?? "", path: match[2] ?? "", since: Number(match[3]), until: Number(match[4]) };
};
var deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

class IrcClient {
  dir;
  state;
  log;
  listIntervalMs;
  password;
  socket = null;
  registered = false;
  stopped = false;
  wakeSleep = null;
  loginWait = null;
  labelCounter = 0;
  batchCounter = 0;
  pending = new Map;
  batchLabels = new Map;
  collector = null;
  queue = Promise.resolve();
  historyWaiters = [];
  background = [];
  backgroundTimer = null;
  lastReceived = 0;
  timers = [];
  constructor(options) {
    this.dir = options.dir;
    this.state = options.state;
    this.log = options.log ?? (() => {
      return;
    });
    this.listIntervalMs = options.listIntervalMs ?? 30000;
    this.password = loadPassword(this.dir);
    this.state.onHistoryDone = (target, count) => {
      for (const waiter of this.historyWaiters.splice(0)) {
        if (fold(waiter.target) === fold(target))
          waiter.resolve(count);
        else
          this.historyWaiters.push(waiter);
      }
    };
  }
  start() {
    this.run();
  }
  stop() {
    this.stopped = true;
    this.socket?.destroy();
    this.wakeSleep?.();
  }
  sleep(ms) {
    return new Promise((resolve) => {
      const timer = ms === Infinity ? null : setTimeout(done, ms);
      function done() {
        if (timer)
          clearTimeout(timer);
        resolve();
      }
      this.wakeSleep = done;
    });
  }
  async run() {
    let attempt = 0;
    while (!this.stopped) {
      if (this.password === null) {
        this.state.setStatus({ connected: false, needsLogin: true });
        await this.sleep(Infinity);
        continue;
      }
      let end;
      try {
        end = await this.session(this.password);
      } catch (error) {
        end = { registered: false, authFailed: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (this.stopped)
        return;
      this.state.onDisconnected();
      if (end.authFailed) {
        this.password = null;
        deletePassword(this.dir);
        this.state.setStatus({ needsLogin: true, error: "The operator password was rejected." });
        this.finishLogin({ ok: false, error: "The operator password was rejected." });
        attempt = 0;
        continue;
      }
      if (end.registered)
        attempt = 0;
      else if (this.loginWait) {
        this.password = null;
        const message = end.message ?? "Cannot connect to the server";
        this.state.setStatus({ needsLogin: true, error: message });
        this.finishLogin({ ok: false, error: message });
        continue;
      }
      if (end.message)
        this.state.setStatus({ error: end.message });
      attempt += 1;
      await this.sleep(Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5)));
    }
  }
  finishLogin(result) {
    const wait = this.loginWait;
    this.loginWait = null;
    wait?.resolve(result);
  }
  async login(password) {
    if (this.loginWait)
      return { ok: false, error: "A login is already in progress" };
    const wait = deferred();
    this.loginWait = wait;
    this.password = password;
    this.state.setStatus({ error: null });
    this.socket?.destroy();
    this.wakeSleep?.();
    const timer = setTimeout(() => this.finishLogin({ ok: false, error: "The server did not answer in time" }), 20000);
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
  logout() {
    this.password = null;
    deletePassword(this.dir);
    this.state.setStatus({ needsLogin: true, error: null });
    this.socket?.destroy();
    this.wakeSleep?.();
  }
  session(password) {
    return new Promise((resolve) => {
      let config;
      try {
        config = readConnectionConfig(this.dir);
      } catch (error) {
        resolve({ registered: false, authFailed: false, message: error instanceof Error ? error.message : String(error) });
        return;
      }
      const socket = config.ca ? tls.connect({
        host: config.host,
        port: config.port,
        ca: config.ca,
        servername: net.isIP(config.host) ? /^(127\.|::1$)/.test(config.host) ? "localhost" : undefined : config.host
      }) : net.connect({ host: config.host, port: config.port });
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.setNoDelay(true);
      const splitter = new LineSplitter;
      let registered = false;
      let authFailed = false;
      let message = null;
      let nickIndex = 0;
      let ended = false;
      const offered = new Set;
      const connectTimer = setTimeout(() => {
        message = "Timed out while connecting or logging in";
        socket.destroy();
      }, 20000);
      const cleanup = () => {
        if (ended)
          return;
        ended = true;
        clearTimeout(connectTimer);
        this.stopTimers();
        this.registered = false;
        if (this.socket === socket)
          this.socket = null;
        this.failPending("Disconnected from the IRC server");
        for (const waiter of this.historyWaiters.splice(0))
          waiter.resolve(0);
        this.collector?.done();
        resolve({ registered, authFailed, message });
      };
      socket.on("close", cleanup);
      socket.on("error", (error) => {
        message = error.message;
      });
      const write = (line) => {
        if (!socket.destroyed)
          socket.write(`${serializeLine(line)}\r
`);
      };
      this.writer = write;
      const onLine = (line) => {
        this.lastReceived = Date.now();
        if (line.command === "PING") {
          write(msg("PONG", line.params));
          return;
        }
        if (!registered) {
          switch (line.command) {
            case "CAP": {
              const sub = line.params[1];
              if (sub === "LS") {
                const more = line.params[2] === "*";
                for (const item of (line.params[more ? 3 : 2] ?? "").split(" ")) {
                  if (item !== "")
                    offered.add(item.split("=")[0] ?? item);
                }
                if (more)
                  return;
                if (!offered.has("sasl")) {
                  message = "The server does not offer SASL";
                  socket.destroy();
                  return;
                }
                write(msg("CAP", ["REQ", [...WANTED_CAPS.filter((c) => offered.has(c)), "sasl"].join(" ")]));
              } else if (sub === "ACK") {
                write(msg("AUTHENTICATE", ["PLAIN"]));
              } else if (sub === "NAK") {
                message = `The server refused capabilities: ${line.params[2] ?? ""}`;
                socket.destroy();
              }
              return;
            }
            case "AUTHENTICATE": {
              if (line.params[0] !== "+")
                return;
              const payload = Buffer.from(`\x00${ACCOUNT}\x00${password}`, "utf8").toString("base64");
              for (let i = 0;i < payload.length; i += 400)
                write(msg("AUTHENTICATE", [payload.slice(i, i + 400)]));
              if (payload.length % 400 === 0)
                write(msg("AUTHENTICATE", ["+"]));
              return;
            }
            case "903":
              write(msg("CAP", ["END"]));
              return;
            case "902":
            case "904":
            case "905":
            case "906":
              authFailed = true;
              socket.destroy();
              return;
            case "432":
            case "433": {
              nickIndex += 1;
              const next = NICKS[nickIndex];
              if (next === undefined) {
                message = "No free nick for the operator connection";
                socket.destroy();
                return;
              }
              write(msg("NICK", [next]));
              return;
            }
            case "001":
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
        if (line.command === "001")
          this.finishLogin({ ok: true });
      };
      socket.on("data", (chunk) => {
        for (const text of splitter.push(chunk)) {
          let line;
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
      socket.once("connect", () => {
        return;
      });
      socket.once(config.ca ? "secureConnect" : "connect", () => {
        write(msg("CAP", ["LS", "302"]));
        write(msg("NICK", [NICKS[0] ?? "chamber"]));
        write(msg("USER", [ACCOUNT, "0", "*", "OpenChamber operator view"]));
      });
    });
  }
  writer = null;
  write(line) {
    if (!this.registered)
      throw new Error("Not connected to the IRC server");
    this.writer?.(line);
  }
  enqueue(lines) {
    this.background.push(...lines);
    if (this.backgroundTimer)
      return;
    const drain = () => {
      const next = this.background.shift();
      if (!next || !this.registered) {
        if (this.backgroundTimer)
          clearInterval(this.backgroundTimer);
        this.backgroundTimer = null;
        if (!this.registered)
          this.background = [];
        return;
      }
      this.writer?.(next);
    };
    drain();
    if (this.background.length > 0)
      this.backgroundTimer = setInterval(drain, 150);
  }
  startTimers() {
    this.lastReceived = Date.now();
    this.timers.push(setInterval(() => {
      this.enqueue([msg("LIST")]);
    }, this.listIntervalMs), setInterval(() => {
      this.enqueue(this.state.channelNames().map((name) => msg("WHO", [name])));
    }, 60000), setInterval(() => {
      if (Date.now() - this.lastReceived > 180000) {
        this.socket?.destroy();
        return;
      }
      this.writer?.(msg("PING", ["openchamber"]));
    }, 60000));
  }
  stopTimers() {
    for (const timer of this.timers.splice(0))
      clearInterval(timer);
    if (this.backgroundTimer)
      clearInterval(this.backgroundTimer);
    this.backgroundTimer = null;
    this.background = [];
  }
  failPending(error) {
    for (const [label, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
      this.pending.delete(label);
    }
    this.batchLabels.clear();
  }
  feed(line) {
    this.resolveLabel(line);
    this.collect(line);
    if (line.command === "FAIL" && line.params[0] === "CHATHISTORY") {
      const target = line.params[3] ?? "";
      for (const waiter of this.historyWaiters.splice(0)) {
        if (fold(waiter.target) === fold(target))
          waiter.resolve(0);
        else
          this.historyWaiters.push(waiter);
      }
    }
    const out = this.state.handleLine(line);
    if (out.length > 0)
      this.enqueue(out);
  }
  resolveLabel(line) {
    if (line.command === "BATCH" && (line.params[0] ?? "").startsWith("+")) {
      const id = (line.params[0] ?? "").slice(1);
      const own = getTag(line, "label");
      const parent = getTag(line, "batch");
      const label = own ?? (parent === undefined ? undefined : this.batchLabels.get(parent));
      if (label !== undefined)
        this.batchLabels.set(id, label);
    }
    const batch = getTag(line, "batch");
    const label = getTag(line, "label") ?? (batch === undefined ? undefined : this.batchLabels.get(batch));
    if (label === undefined)
      return;
    const pending = this.pending.get(label);
    if (!pending)
      return;
    const isError = line.command === "FAIL" || /^[45]\d\d$/.test(line.command);
    const isOk = line.command === "ACK" || (line.command === "PRIVMSG" || line.command === "NOTICE") && (line.source ?? "").includes("!") || line.command === "BATCH" && (line.params[0] ?? "").startsWith("+") && line.params[1] === "draft/multiline";
    if (!isError && !isOk)
      return;
    clearTimeout(pending.timer);
    this.pending.delete(label);
    if (isError)
      pending.resolve({ ok: false, error: line.params[line.params.length - 1] ?? "The server refused the message" });
    else
      pending.resolve({ ok: true, ...getTag(line, "msgid") ? { msgid: getTag(line, "msgid") } : {} });
  }
  collect(line) {
    const c = this.collector;
    if (!c)
      return;
    const serverSource = !(line.source ?? "").includes("!");
    if (line.command === "NOTICE" && serverSource) {
      const text = line.params[1] ?? "";
      if (c.isEnd(text))
        c.done();
      else
        c.lines.push(text);
      return;
    }
    if (/^4\d\d$/.test(line.command)) {
      c.error = line.params[line.params.length - 1] ?? "The server refused the command";
      if (line.command === "401")
        c.error = `No such nick: ${line.params[1] ?? ""}`;
      c.done();
    }
  }
  serial(work) {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {
      return;
    });
    return run;
  }
  collectNotices(command, verb, endText) {
    return this.serial(() => new Promise((resolve) => {
      let timedOut = false;
      let finished = false;
      const collector = {
        verb,
        lines: [],
        error: null,
        isEnd: (text) => text === endText,
        done: () => {
          if (finished)
            return;
          finished = true;
          clearTimeout(timer);
          if (this.collector === collector)
            this.collector = null;
          resolve({ lines: collector.lines, error: collector.error, timedOut });
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        collector.done();
      }, 12000);
      this.collector = collector;
      try {
        this.write(command);
      } catch (error) {
        collector.error = error instanceof Error ? error.message : String(error);
        collector.done();
      }
    }));
  }
  async agent(verb, target) {
    const targetError = validateTarget(target);
    if (targetError)
      return { ok: false, lines: [], error: targetError };
    const result = await this.collectNotices(msg("AGENT", [verb, target]), verb, `end of AGENT ${verb}`);
    const error = result.error ?? (result.timedOut ? "The server did not finish the request in time" : null);
    return { ok: error === null, lines: result.lines, ...result.timedOut ? { timedOut: true } : {}, ...error ? { error } : {} };
  }
  async claims() {
    const result = await this.collectNotices(msg("CLAIMS"), "CLAIMS", "end of CLAIMS");
    const claims = result.lines.map(parseClaim).filter((c) => c !== null);
    const error = result.error ?? (result.timedOut ? "The server did not finish the request in time" : null);
    return { ok: error === null, claims, ...error ? { error } : {} };
  }
  send(target, text) {
    if (!this.registered)
      return Promise.resolve({ ok: false, error: "Not connected to the IRC server" });
    const label = `oc${++this.labelCounter}`;
    const ref = `oc${++this.batchCounter}`;
    const plan = planSend(target, text, ref);
    if (typeof plan === "string")
      return Promise.resolve({ ok: false, error: plan });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(label);
        resolve({ ok: false, error: "The server did not confirm the message" });
      }, 1e4);
      this.pending.set(label, { resolve, timer });
      try {
        plan.lines.forEach((line, index) => {
          if (index === 0)
            line.tags.push(["label", label]);
          this.write(line);
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(label);
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
  history(target, beforeMsgid) {
    if (!this.registered || validateTarget(target))
      return Promise.resolve(0);
    return new Promise((resolve) => {
      const waiter = { target, resolve };
      const timer = setTimeout(() => {
        const at = this.historyWaiters.indexOf(waiter);
        if (at !== -1)
          this.historyWaiters.splice(at, 1);
        resolve(0);
      }, 8000);
      waiter.resolve = (count) => {
        clearTimeout(timer);
        resolve(count);
      };
      this.historyWaiters.push(waiter);
      const ref = beforeMsgid ? `msgid=${beforeMsgid}` : "*";
      try {
        this.write(msg("CHATHISTORY", [beforeMsgid ? "BEFORE" : "LATEST", target, ref, "100"]));
      } catch {
        waiter.resolve(0);
      }
    });
  }
  join(channel) {
    this.write(msg("JOIN", [channel]));
  }
  part(channel) {
    this.write(msg("PART", [channel]));
  }
  requestLines(lines) {
    if (this.registered)
      this.enqueue(lines);
  }
}

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var MAX_BODY_BYTES = 64 * 1024;
var VERBS = ["STATUS", "INTERRUPT", "RESUME"];
var state = new ChamberState;
var client = new IrcClient({
  dir: configDir(),
  state,
  log: (text) => console.error(`[agent-comms] ${text}`),
  listIntervalMs: Number(process.env.AGENT_COMMS_LIST_INTERVAL_MS) || 30000
});
var errorMessage = (error) => error instanceof Error ? error.message : String(error);
var sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
var readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(new Error("Request body too large"));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});
var readJson = async (req) => {
  const text = await readBody(req);
  if (text.trim() === "")
    return {};
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Body must be a JSON object");
  return parsed;
};
var str = (body, key) => {
  const value = body[key];
  return typeof value === "string" ? value : "";
};
var num = (value, fallback, min, max) => {
  if (value === null || value === "")
    return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
};
var expectedAuth = Buffer.from(`Bearer ${token}`);
var authorized = (header) => {
  if (header === undefined)
    return false;
  const given = Buffer.from(header);
  return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth);
};
var handle = async (req, res) => {
  if (!authorized(req.headers.authorization)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const route = `${req.method ?? "GET"} ${url.pathname}`;
  switch (route) {
    case "GET /health":
      sendJson(res, 200, { ok: true });
      return;
    case "GET /state":
      sendJson(res, 200, state.snapshot());
      return;
    case "GET /messages": {
      const target = url.searchParams.get("target") ?? "";
      const invalid = validateTarget(target);
      if (invalid) {
        sendJson(res, 400, { error: invalid });
        return;
      }
      const beforeRaw = url.searchParams.get("before");
      const before = beforeRaw === null || beforeRaw === "" ? null : num(beforeRaw, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = num(url.searchParams.get("limit"), 50, 1, 200);
      let result = state.page(target, before, limit);
      if (before !== null && result.messages.length < limit && !state.isExhausted(target)) {
        const count = await client.history(target, state.oldestMsgid(target));
        if (count > 0)
          result = state.page(target, before, limit);
      }
      sendJson(res, 200, result);
      return;
    }
    case "GET /events": {
      const after = num(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
      const wait = num(url.searchParams.get("wait"), 0, 0, 15000);
      const abort = new AbortController;
      res.on("close", () => abort.abort());
      const result = await state.poll(after, url.searchParams.get("epoch"), wait, abort.signal);
      if (!res.destroyed)
        sendJson(res, 200, result);
      return;
    }
    case "POST /send": {
      const body = await readJson(req);
      sendJson(res, 200, await client.send(str(body, "target"), str(body, "text")));
      return;
    }
    case "POST /agent": {
      const body = await readJson(req);
      const verb = str(body, "verb").toUpperCase();
      if (!VERBS.includes(verb)) {
        sendJson(res, 400, { ok: false, lines: [], error: "verb must be STATUS, INTERRUPT or RESUME" });
        return;
      }
      sendJson(res, 200, await client.agent(verb, str(body, "target")));
      return;
    }
    case "GET /claims":
      sendJson(res, 200, await client.claims());
      return;
    case "POST /login": {
      const body = await readJson(req);
      const password = str(body, "password");
      if (password === "" || /[\r\n\u0000]/.test(password)) {
        sendJson(res, 400, { ok: false, error: "Enter the operator password" });
        return;
      }
      sendJson(res, 200, await client.login(password));
      return;
    }
    case "POST /logout":
      client.logout();
      sendJson(res, 200, { ok: true });
      return;
    case "POST /join":
    case "POST /part": {
      const body = await readJson(req);
      const channel = str(body, "channel");
      if (!isChannelName(channel) || validateTarget(channel)) {
        sendJson(res, 400, { ok: false, error: "Invalid channel name" });
        return;
      }
      try {
        if (url.pathname === "/join")
          client.join(channel);
        else
          client.part(channel);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: errorMessage(error) });
      }
      return;
    }
    case "POST /dm": {
      const body = await readJson(req);
      const nick = str(body, "nick");
      if (isChannelName(nick) || validateTarget(nick)) {
        sendJson(res, 400, { ok: false, error: "Invalid nick" });
        return;
      }
      client.requestLines(state.addDm(nick));
      sendJson(res, 200, { ok: true });
      return;
    }
    case "POST /read": {
      const body = await readJson(req);
      const seq = typeof body.seq === "number" ? body.seq : 0;
      state.markRead(str(body, "target"), seq);
      sendJson(res, 200, { ok: true });
      return;
    }
    default:
      sendJson(res, 404, { error: "not-found" });
  }
};
var server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent)
      sendJson(res, 500, { error: errorMessage(error) });
    else
      res.end();
  });
});
process.on("uncaughtException", (error) => console.error(`[agent-comms] uncaught: ${errorMessage(error)}`));
process.on("unhandledRejection", (error) => console.error(`[agent-comms] unhandled: ${errorMessage(error)}`));
process.on("SIGTERM", () => {
  client.stop();
  server.close();
  process.exit(0);
});
server.listen(port, "127.0.0.1", () => client.start());
