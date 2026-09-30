import { createHash } from "node:crypto"

function cut(s: string, maxLen: number): string {
  return s.slice(0, Math.max(0, maxLen)).replace(/-+$/, "")
}

/** Lowercase ASCII slug. Never starts with a digit or "-". Empty input gives "session". */
export function slugify(title: string, maxLen: number): string {
  let s = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (s === "") s = "session"
  else if (/^[0-9]/.test(s)) s = `s-${s}`
  const out = cut(s, maxLen)
  return out === "" ? "s" : out
}

export function provisionalNick(agent: string, sessionID: string): string {
  const id = sessionID.toLowerCase().replace(/[^a-z0-9]/g, "")
  const shortId = id.slice(-4) || "x"
  return `${slugify(agent, 12)}-${shortId}`
}

export function childNick(parentNick: string, childBase: string): string {
  return `${parentNick}|${childBase}`
}

export function childBase(agent: string, index: number): string {
  return `${slugify(agent, 16)}${index}`
}

const NICK_RE = /^[A-Za-z_\[\]\\`^{}|][A-Za-z0-9_\-\[\]\\`^{}|]*$/

export function isValidNick(n: string, max = 96): boolean {
  return n.length >= 1 && n.length <= max && NICK_RE.test(n)
}

export function projectSlug(nameOrDir: string): string {
  const parts = nameOrDir.split(/[\\/]+/).filter((p) => p !== "")
  const base = parts[parts.length - 1] ?? ""
  const s = base
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const out = cut(s, 64)
  return out === "" ? "project" : out
}

function sanitizeLinkPart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_")
}

function shortenPart(original: string, max: number): string {
  const clean = sanitizeLinkPart(original)
  if (clean.length <= max) return clean
  const hash = createHash("sha256").update(original).digest("hex").slice(0, 8)
  return clean.slice(0, max - 8) + hash
}

export function linkName(serviceID: string, projectID: string): string {
  const build = (s: string, p: string): string => `svc-${s}.prj-${p}`
  const full = build(sanitizeLinkPart(serviceID), sanitizeLinkPart(projectID))
  if (full.length <= 64 && full.length >= 1) return full
  // "svc-" + "." + "prj-" use 9 characters; 55 remain for the two parts.
  return build(shortenPart(serviceID, 27), shortenPart(projectID, 27))
}
