// Read the agent-comms server config and keep the operator password on disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ConnectionConfig {
  host: string;
  port: number;
  /** PEM of the trusted certificate. Set when the server uses TLS. */
  ca: string | null;
  serverName: string;
}

export const configDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env.AGENT_COMMS_CONFIG_DIR;
  if (override) return path.resolve(override);
  const xdg = env.XDG_CONFIG_HOME;
  return path.join(xdg ? xdg : path.join(os.homedir(), '.config'), 'agent-comms');
};

const unquote = (raw: string): string | null => {
  const value = raw.trim();
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(value) ?? /^'([^']*)'/.exec(value);
  if (!match) return null;
  return (match[1] ?? '').replace(/\\(.)/g, '$1');
};

/** Very small TOML reader. It reads only string values, for the keys that this extension needs. */
export const parseToml = (text: string): Record<string, string> => {
  const values: Record<string, string> = {};
  let table = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      table = (header[1] ?? '').trim();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1));
    if (value !== null) values[table === '' ? key : `${table}.${key}`] = value;
  }
  return values;
};

export const parseBind = (bind: string): { host: string; port: number } | null => {
  const at = bind.lastIndexOf(':');
  if (at === -1) return null;
  const port = Number(bind.slice(at + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  let host = bind.slice(0, at).replace(/^\[|\]$/g, '');
  if (host === '' || host === '0.0.0.0' || host === '::' || host === '*') host = '127.0.0.1';
  return { host, port };
};

export const readConnectionConfig = (dir: string): ConnectionConfig => {
  const file = path.join(dir, 'config.toml');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Cannot read ${file}. Install agent-comms first.`);
  }
  const toml = parseToml(text);
  const bind = parseBind(toml.bind ?? '127.0.0.1:6667');
  if (!bind) throw new Error(`Invalid bind address in ${file}`);
  let ca: string | null = null;
  const cert = toml['tls.cert'];
  if (cert !== undefined) {
    const certPath = path.isAbsolute(cert) ? cert : path.join(dir, cert);
    try {
      ca = fs.readFileSync(certPath, 'utf8');
    } catch {
      throw new Error(`Cannot read the TLS certificate ${certPath}`);
    }
  }
  return { host: bind.host, port: bind.port, ca, serverName: toml.server_name ?? 'irc.agent-comms.local' };
};

const passwordFile = (dir: string): string => path.join(dir, 'openchamber-operator.json');

export const loadPassword = (dir: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(passwordFile(dir), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'password' in parsed) {
      const value = (parsed as { password: unknown }).password;
      if (typeof value === 'string' && value !== '') return value;
    }
  } catch {
    // No file, or a broken file: the operator must log in again.
  }
  return null;
};

export const savePassword = (dir: string, password: string): void => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = passwordFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ password }), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
};

export const deletePassword = (dir: string): void => {
  try {
    fs.rmSync(passwordFile(dir), { force: true });
  } catch {
    // Nothing to delete.
  }
};
