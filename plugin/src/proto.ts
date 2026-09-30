import { TAG_VENDOR } from "./constants.ts"

export type Tags = Array<[string, string | null]>

export interface IrcMessage {
  tags: Tags
  source: string | null
  command: string
  params: string[]
}

export interface Limits {
  body: number
  tags: number
}

export const CLIENT_LIMITS: Limits = { body: 512, tags: 8191 }
export const LINK_LIMITS: Limits = { body: 65536, tags: 8191 }

const MAX_PARAMS = 15

export type ParseErrorCode =
  | "Empty"
  | "TagsTooLong"
  | "BodyTooLong"
  | "MissingCommand"
  | "InvalidCommand"
  | "TooManyParams"
  | "InvalidTag"
  | "ContainsNewline"

export class ParseError extends Error {
  constructor(
    public code:
      | "Empty"
      | "TagsTooLong"
      | "BodyTooLong"
      | "MissingCommand"
      | "InvalidCommand"
      | "TooManyParams"
      | "InvalidTag"
      | "ContainsNewline",
  ) {
    super(`IRC parse error: ${code}`)
    this.name = "ParseError"
  }
}

const encoder = new TextEncoder()

function byteLength(s: string): number {
  return encoder.encode(s).length
}

export function escapeTagValue(v: string): string {
  let out = ""
  for (const ch of v) {
    switch (ch) {
      case ";":
        out += "\\:"
        break
      case " ":
        out += "\\s"
        break
      case "\\":
        out += "\\\\"
        break
      case "\r":
        out += "\\r"
        break
      case "\n":
        out += "\\n"
        break
      default:
        out += ch
    }
  }
  return out
}

export function unescapeTagValue(v: string): string {
  let out = ""
  let i = 0
  while (i < v.length) {
    const ch = v.charAt(i)
    if (ch !== "\\") {
      out += ch
      i += 1
      continue
    }
    if (i + 1 >= v.length) break // lone trailing backslash is dropped
    // Advance by a full code point so a surrogate pair stays intact.
    const cp = v.codePointAt(i + 1) as number
    const next = String.fromCodePoint(cp)
    switch (next) {
      case ":":
        out += ";"
        break
      case "s":
        out += " "
        break
      case "r":
        out += "\r"
        break
      case "n":
        out += "\n"
        break
      default:
        out += next
    }
    i += 1 + next.length
  }
  return out
}

function parseTags(section: string): Tags {
  const tags: Tags = []
  for (const part of section.split(";")) {
    const eq = part.indexOf("=")
    const key = eq === -1 ? part : part.slice(0, eq)
    if (key === "") throw new ParseError("InvalidTag")
    let value: string | null = null
    if (eq !== -1) {
      const raw = unescapeTagValue(part.slice(eq + 1))
      value = raw === "" ? null : raw
    }
    const existing = tags.findIndex((t) => t[0] === key)
    if (existing !== -1) {
      const entry = tags[existing]
      if (entry) entry[1] = value
    } else {
      tags.push([key, value])
    }
  }
  return tags
}

function skipSpaces(s: string, from: number): number {
  let i = from
  while (i < s.length && s.charCodeAt(i) === 0x20) i += 1
  return i
}

export function parseLine(line: string, limits: Limits = LINK_LIMITS): IrcMessage {
  let s = line
  if (s.endsWith("\r\n")) s = s.slice(0, -2)
  else if (s.endsWith("\n")) s = s.slice(0, -1)

  if (s.includes("\r") || s.includes("\n") || s.includes("\0")) {
    throw new ParseError("ContainsNewline")
  }
  if (s === "") throw new ParseError("Empty")

  let pos = 0
  let tags: Tags = []
  if (s.startsWith("@")) {
    let end = s.indexOf(" ")
    if (end === -1) end = s.length
    const section = s.slice(0, end)
    if (byteLength(section) > limits.tags) throw new ParseError("TagsTooLong")
    tags = parseTags(section.slice(1))
    pos = skipSpaces(s, end)
  }

  const body = s.slice(pos)
  if (byteLength(body) + 2 > limits.body) throw new ParseError("BodyTooLong")

  let i = 0
  let source: string | null = null
  if (body.startsWith(":")) {
    let end = body.indexOf(" ")
    if (end === -1) end = body.length
    source = body.slice(1, end)
    i = skipSpaces(body, end)
  }

  let cmdEnd = body.indexOf(" ", i)
  if (cmdEnd === -1) cmdEnd = body.length
  const command = body.slice(i, cmdEnd)
  if (command === "") throw new ParseError("MissingCommand")
  if (!/^(?:[A-Za-z]+|[0-9]{3})$/.test(command)) throw new ParseError("InvalidCommand")
  i = cmdEnd

  const params: string[] = []
  for (;;) {
    i = skipSpaces(body, i)
    if (i >= body.length) break
    if (params.length >= MAX_PARAMS) throw new ParseError("TooManyParams")
    if (body.charAt(i) === ":") {
      params.push(body.slice(i + 1))
      break
    }
    let end = body.indexOf(" ", i)
    if (end === -1) end = body.length
    params.push(body.slice(i, end))
    i = end
  }

  return { tags, source, command, params }
}

export function serializeLine(m: IrcMessage): string {
  let out = ""
  if (m.tags.length > 0) {
    out +=
      "@" +
      m.tags
        .map(([k, v]) => (v === null || v === "" ? k : `${k}=${escapeTagValue(v)}`))
        .join(";") +
      " "
  }
  if (m.source) out += `:${m.source} `
  out += m.command
  const last = m.params.length - 1
  m.params.forEach((p, idx) => {
    const trailing = idx === last && (p === "" || p.includes(" ") || p.startsWith(":"))
    out += " " + (trailing ? ":" : "") + p
  })
  return out
}

export function getTag(m: IrcMessage, key: string): string | undefined {
  const entry = m.tags.find((t) => t[0] === key)
  if (!entry) return undefined
  return entry[1] ?? ""
}

export function setTag(m: IrcMessage, key: string, value: string | null): void {
  const entry = m.tags.find((t) => t[0] === key)
  if (entry) entry[1] = value
  else m.tags.push([key, value])
}

export function vendorTag(name: string): string {
  return `${TAG_VENDOR}/${name}`
}

export function msg(
  command: string,
  params: string[] = [],
  opts: { tags?: Tags; source?: string | null } = {},
): IrcMessage {
  return {
    tags: opts.tags ?? [],
    source: opts.source ?? null,
    command,
    params,
  }
}

export function sourceNick(m: IrcMessage): string | null {
  if (m.source === null) return null
  const bang = m.source.indexOf("!")
  return bang === -1 ? m.source : m.source.slice(0, bang)
}

export class LineSplitter {
  private buf = ""

  push(chunk: string): string[] {
    this.buf += chunk
    const pieces = this.buf.split("\n")
    this.buf = pieces.pop() ?? ""
    const lines: string[] = []
    for (const piece of pieces) {
      const line = piece.endsWith("\r") ? piece.slice(0, -1) : piece
      if (line !== "") lines.push(line)
    }
    return lines
  }

  get pending(): string {
    return this.buf
  }
}
