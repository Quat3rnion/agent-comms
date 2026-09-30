/**
 * Registry of the sessions that one plugin instance owns. It keeps aliases (old nicks),
 * a per-parent counter for child nick bases, and channel lists. It persists each session
 * in the plugin storage under `session/<sessionID>`.
 */
import type { Plugin } from "@opencode/plugin"
import { casefold } from "./delivery.ts"
import type { RegistryApi, SessionRecord } from "./types.ts"

export type RegistryStorage = Pick<Plugin.Context["storage"], "set" | "remove" | "scan">
type StorageJson = Parameters<RegistryStorage["set"]>[1]

export const KEY_PREFIX = "session/"

interface Meta {
  aliases: string[]
  /** Last child index that was handed out for this session as a parent. */
  lastChild: number
  /** Directory of the session. */
  directory: string
}

interface Persisted {
  v: 1
  record: SessionRecord
  aliases: string[]
  lastChild: number
  directory: string
}

export type RegistryLog = (level: "warn" | "error", message: string) => void

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
}

function parseRecord(v: unknown): SessionRecord | null {
  if (!isRecord(v)) return null
  const { sessionID, account, nick, provisional, parentID, agent, title, project, optedOut, channels } = v
  if (
    typeof sessionID !== "string" ||
    typeof account !== "string" ||
    typeof nick !== "string" ||
    typeof provisional !== "boolean" ||
    !(parentID === null || typeof parentID === "string") ||
    typeof agent !== "string" ||
    typeof title !== "string" ||
    typeof project !== "string" ||
    typeof optedOut !== "boolean" ||
    !isStringArray(channels)
  ) {
    return null
  }
  return {
    sessionID,
    account,
    nick,
    provisional,
    parentID,
    agent,
    title,
    project,
    optedOut,
    busy: false,
    channels: [...channels],
  }
}

export function parsePersisted(v: unknown): Persisted | null {
  if (!isRecord(v) || v["v"] !== 1) return null
  const record = parseRecord(v["record"])
  const aliases = v["aliases"]
  const lastChild = v["lastChild"]
  const directory = v["directory"]
  if (!record || !isStringArray(aliases) || typeof lastChild !== "number" || typeof directory !== "string") {
    return null
  }
  return { v: 1, record, aliases: [...aliases], lastChild, directory }
}

export class Registry implements RegistryApi {
  private readonly records = new Map<string, SessionRecord>()
  private readonly meta = new Map<string, Meta>()
  private writes: Promise<void> = Promise.resolve()

  /**
   * @param storage Plugin storage, or null for a memory-only registry.
   * @param directory Directory of this plugin location. `load` keeps only sessions of this directory.
   */
  constructor(
    private readonly storage: RegistryStorage | null,
    private readonly directory: string,
    private readonly log: RegistryLog = () => {},
  ) {}

  // ------------------------------------------------------------------ load

  /** Read the persisted sessions of this directory. Returns how many were loaded. */
  async load(): Promise<number> {
    if (!this.storage) return 0
    let after: string | undefined
    let loaded = 0
    for (;;) {
      const page = await this.storage.scan({
        prefix: KEY_PREFIX,
        limit: 200,
        ...(after !== undefined ? { after } : {}),
      })
      for (const entry of page.entries) {
        const p = parsePersisted(entry.value)
        if (!p) {
          this.log("warn", `ignoring unreadable stored session ${entry.key}`)
          continue
        }
        if (p.directory !== this.directory) continue
        this.records.set(p.record.sessionID, p.record)
        this.meta.set(p.record.sessionID, {
          aliases: p.aliases,
          lastChild: p.lastChild,
          directory: p.directory,
        })
        loaded += 1
      }
      if (page.next === undefined || page.next === after) break
      after = page.next
    }
    return loaded
  }

  // ------------------------------------------------------------------ reads

  get(sessionID: string): SessionRecord | undefined {
    return this.records.get(sessionID)
  }

  /** Lookup by current nick (rfc1459 case-insensitive). Opted-out sessions have no nick. */
  byNick(nick: string): SessionRecord | undefined {
    const wanted = casefold(nick)
    for (const r of this.records.values()) {
      if (r.optedOut || r.nick === "") continue
      if (casefold(r.nick) === wanted) return r
    }
    return undefined
  }

  all(): SessionRecord[] {
    return [...this.records.values()]
  }

  aliases(sessionID: string): string[] {
    return [...(this.meta.get(sessionID)?.aliases ?? [])]
  }

  directoryOf(sessionID: string): string | undefined {
    return this.meta.get(sessionID)?.directory
  }

  children(sessionID: string): SessionRecord[] {
    return this.all().filter((r) => r.parentID === sessionID)
  }

  /** Sessions of one directory, parents before children. */
  ownedBy(directory: string): SessionRecord[] {
    const own = this.all().filter((r) => this.meta.get(r.sessionID)?.directory === directory)
    const depth = (r: SessionRecord): number => {
      let d = 0
      let cur: SessionRecord | undefined = r
      const seen = new Set<string>()
      while (cur && cur.parentID !== null && !seen.has(cur.sessionID)) {
        seen.add(cur.sessionID)
        cur = this.records.get(cur.parentID)
        if (cur) d += 1
      }
      return d
    }
    return own
      .map((r, i) => ({ r, i, d: depth(r) }))
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .map((x) => x.r)
  }

  // ----------------------------------------------------------------- writes

  put(record: SessionRecord, directory: string = this.directory): SessionRecord {
    const old = this.meta.get(record.sessionID)
    this.records.set(record.sessionID, record)
    this.meta.set(record.sessionID, {
      aliases: old?.aliases ?? [],
      lastChild: old?.lastChild ?? 0,
      directory,
    })
    this.persist(record.sessionID)
    return record
  }

  remove(sessionID: string): SessionRecord | undefined {
    const rec = this.records.get(sessionID)
    this.records.delete(sessionID)
    this.meta.delete(sessionID)
    const storage = this.storage
    if (storage) {
      this.chain(() => storage.remove(KEY_PREFIX + sessionID))
    }
    return rec
  }

  update(sessionID: string, patch: Partial<Omit<SessionRecord, "sessionID" | "account">>): void {
    const rec = this.records.get(sessionID)
    if (!rec) return
    Object.assign(rec, patch)
    this.persist(sessionID)
  }

  /** Set the current nick. The old nick becomes an alias unless `alias` is false. */
  setNick(sessionID: string, nick: string, opts: { alias?: boolean } = {}): void {
    const rec = this.records.get(sessionID)
    const meta = this.meta.get(sessionID)
    if (!rec || !meta) return
    const old = rec.nick
    if (old === nick) return
    if (opts.alias !== false && old !== "" && casefold(old) !== casefold(nick)) {
      if (!meta.aliases.some((a) => casefold(a) === casefold(old))) meta.aliases.push(old)
    }
    meta.aliases = meta.aliases.filter((a) => casefold(a) !== casefold(nick))
    rec.nick = nick
    this.persist(sessionID)
  }

  /** Transient state. It is not persisted. */
  setBusy(sessionID: string, busy: boolean): void {
    const rec = this.records.get(sessionID)
    if (rec) rec.busy = busy
  }

  setOptedOut(sessionID: string, optedOut: boolean): void {
    this.update(sessionID, { optedOut })
  }

  /** Hand out the next child index (1, 2, ...) for the children of `parentID`. */
  nextChildIndex(parentID: string): number {
    const meta = this.meta.get(parentID)
    if (!meta) return 1
    meta.lastChild += 1
    this.persist(parentID)
    return meta.lastChild
  }

  addChannel(sessionID: string, channel: string): void {
    const rec = this.records.get(sessionID)
    if (!rec) return
    if (rec.channels.some((c) => casefold(c) === casefold(channel))) return
    rec.channels.push(channel)
    this.persist(sessionID)
  }

  removeChannel(sessionID: string, channel: string): void {
    const rec = this.records.get(sessionID)
    if (!rec) return
    const next = rec.channels.filter((c) => casefold(c) !== casefold(channel))
    if (next.length === rec.channels.length) return
    rec.channels = next
    this.persist(sessionID)
  }

  /** Rename a channel in the channel list of every session (family channel rename). */
  replaceChannel(oldChannel: string, newChannel: string): void {
    for (const rec of this.records.values()) {
      const idx = rec.channels.findIndex((c) => casefold(c) === casefold(oldChannel))
      if (idx === -1) continue
      rec.channels[idx] = newChannel
      rec.channels = rec.channels.filter((c, i) => rec.channels.findIndex((d) => casefold(d) === casefold(c)) === i)
      this.persist(rec.sessionID)
    }
  }

  // ------------------------------------------------------------ persistence

  persist(sessionID: string): void {
    const storage = this.storage
    const rec = this.records.get(sessionID)
    const meta = this.meta.get(sessionID)
    if (!storage || !rec || !meta) return
    const value: Persisted = {
      v: 1,
      record: { ...rec, channels: [...rec.channels], busy: false },
      aliases: [...meta.aliases],
      lastChild: meta.lastChild,
      directory: meta.directory,
    }
    const json = JSON.parse(JSON.stringify(value)) as StorageJson
    this.chain(() => storage.set(KEY_PREFIX + sessionID, json))
  }

  /** Resolves when all queued storage writes are done. */
  flush(): Promise<void> {
    return this.writes
  }

  private chain(op: () => Promise<void>): void {
    this.writes = this.writes.then(op).catch((e: unknown) => {
      this.log("warn", `session storage write failed: ${e instanceof Error ? e.message : String(e)}`)
    })
  }
}
