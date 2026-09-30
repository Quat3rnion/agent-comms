import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { TAG_VENDOR } from "../src/constants.ts"
import type { IrcMessage } from "../src/proto.ts"
import {
  CLIENT_LIMITS,
  LINK_LIMITS,
  LineSplitter,
  ParseError,
  escapeTagValue,
  getTag,
  msg,
  parseLine,
  serializeLine,
  setTag,
  sourceNick,
  unescapeTagValue,
  vendorTag,
} from "../src/proto.ts"

const fixturesDir = new URL("../../fixtures/link/", import.meta.url).pathname

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (e) {
    if (e instanceof ParseError) return e.code
    throw e
  }
  return undefined
}

describe("golden fixtures", () => {
  const names = [...new Bun.Glob("*.txt").scanSync({ cwd: fixturesDir })].sort()

  test("at least 3 fixture files", () => {
    expect(names.length).toBeGreaterThanOrEqual(3)
  })

  for (const file of names) {
    test(file, () => {
      const lines = readFileSync(fixturesDir + file, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "" && !l.startsWith("//"))
      const expected = JSON.parse(
        readFileSync(fixturesDir + file.replace(/\.txt$/, ".json"), "utf8"),
      ) as IrcMessage[]
      expect(expected.length).toBe(lines.length)
      lines.forEach((line, i) => {
        const parsed = parseLine(line, LINK_LIMITS)
        expect(parsed).toEqual(expected[i] as IrcMessage)
        expect(serializeLine(parsed)).toBe(line)
      })
    })
  }
})

describe("parse errors", () => {
  test("Empty", () => {
    expect(codeOf(() => parseLine(""))).toBe("Empty")
    expect(codeOf(() => parseLine("\r\n"))).toBe("Empty")
    expect(codeOf(() => parseLine("\n"))).toBe("Empty")
  })

  test("ContainsNewline", () => {
    expect(codeOf(() => parseLine("PING a\nPING b"))).toBe("ContainsNewline")
    expect(codeOf(() => parseLine("PING a\rb"))).toBe("ContainsNewline")
    expect(codeOf(() => parseLine("PING a\0b"))).toBe("ContainsNewline")
    expect(codeOf(() => parseLine("PING a\r\n\r\n"))).toBe("ContainsNewline")
  })

  test("trailing CRLF and LF stripped", () => {
    expect(parseLine("PING x\r\n").params).toEqual(["x"])
    expect(parseLine("PING x\n").params).toEqual(["x"])
  })

  test("TagsTooLong", () => {
    const tags = "@a=" + "x".repeat(LINK_LIMITS.tags)
    expect(codeOf(() => parseLine(`${tags} PING`))).toBe("TagsTooLong")
    const ok = "@a=" + "x".repeat(LINK_LIMITS.tags - 3)
    expect(codeOf(() => parseLine(`${ok} PING`))).toBeUndefined()
  })

  test("BodyTooLong", () => {
    expect(codeOf(() => parseLine("PING " + "x".repeat(LINK_LIMITS.body), LINK_LIMITS))).toBe(
      "BodyTooLong",
    )
  })

  test("MissingCommand", () => {
    expect(codeOf(() => parseLine("@a=b"))).toBe("MissingCommand")
    expect(codeOf(() => parseLine(":nick!u@h"))).toBe("MissingCommand")
    expect(codeOf(() => parseLine("@a=b :nick "))).toBe("MissingCommand")
  })

  test("InvalidCommand", () => {
    expect(codeOf(() => parseLine("PING1 x"))).toBe("InvalidCommand")
    expect(codeOf(() => parseLine("12 x"))).toBe("InvalidCommand")
    expect(codeOf(() => parseLine("1234 x"))).toBe("InvalidCommand")
    expect(codeOf(() => parseLine("PR!VMSG x"))).toBe("InvalidCommand")
  })

  test("valid commands", () => {
    expect(parseLine("001 nick :Welcome").command).toBe("001")
    expect(parseLine("PrivMsg #a :hi").command).toBe("PrivMsg")
  })

  test("TooManyParams", () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => `p${i}`).join(" ")
    expect(parseLine(`CMD ${fifteen}`).params.length).toBe(15)
    expect(codeOf(() => parseLine(`CMD ${fifteen} p15`))).toBe("TooManyParams")
    expect(codeOf(() => parseLine(`CMD ${fifteen} :trail`))).toBe("TooManyParams")
  })

  test("InvalidTag", () => {
    expect(codeOf(() => parseLine("@=v PING"))).toBe("InvalidTag")
    expect(codeOf(() => parseLine("@a;;b PING"))).toBe("InvalidTag")
    expect(codeOf(() => parseLine("@ PING"))).toBe("InvalidTag")
  })
})

describe("limits", () => {
  test("CLIENT_LIMITS body boundary", () => {
    expect(CLIENT_LIMITS).toEqual({ body: 512, tags: 8191 })
    const ok = "PING " + "x".repeat(510 - 5)
    expect(new TextEncoder().encode(ok).length).toBe(510)
    expect(codeOf(() => parseLine(ok, CLIENT_LIMITS))).toBeUndefined()
    const bad = ok + "x"
    expect(codeOf(() => parseLine(bad, CLIENT_LIMITS))).toBe("BodyTooLong")
  })

  test("body limit counts UTF-8 bytes", () => {
    const line = "PING " + "é".repeat(253) // 5 + 506 = 511 bytes
    expect(codeOf(() => parseLine(line, CLIENT_LIMITS))).toBe("BodyTooLong")
    expect(codeOf(() => parseLine("PING " + "é".repeat(252), CLIENT_LIMITS))).toBeUndefined()
  })

  test("body excludes tags", () => {
    const line = "@a=" + "x".repeat(1000) + " PING " + "y".repeat(100)
    expect(codeOf(() => parseLine(line, CLIENT_LIMITS))).toBeUndefined()
  })
})

describe("parsing details", () => {
  test("full message", () => {
    const m = parseLine("@a=b;c :nick!user@host PRIVMSG #chan :hello world")
    expect(m).toEqual({
      tags: [
        ["a", "b"],
        ["c", null],
      ],
      source: "nick!user@host",
      command: "PRIVMSG",
      params: ["#chan", "hello world"],
    })
  })

  test("multiple spaces collapse", () => {
    const m = parseLine("@a=b   :src   CMD   x    y   :z w")
    expect(m.source).toBe("src")
    expect(m.params).toEqual(["x", "y", "z w"])
  })

  test("empty trailing", () => {
    expect(parseLine("CMD x :").params).toEqual(["x", ""])
  })

  test("empty tag value normalizes to null", () => {
    expect(parseLine("@a= PING").tags).toEqual([["a", null]])
  })

  test("duplicate tags: later value wins, first position kept", () => {
    const m = parseLine("@a=1;b=2;a=3 PING")
    expect(m.tags).toEqual([
      ["a", "3"],
      ["b", "2"],
    ])
    expect(parseLine("@a=1;a PING").tags).toEqual([["a", null]])
  })
})

describe("tag escaping", () => {
  test("escape mapping", () => {
    expect(escapeTagValue("a;b c\\d\r\ne")).toBe("a\\:b\\sc\\\\d\\r\\ne")
  })

  test("unescape rules", () => {
    expect(unescapeTagValue("\\:\\s\\\\\\r\\n")).toBe("; \\\r\n")
    expect(unescapeTagValue("ab\\")).toBe("ab")
    expect(unescapeTagValue("a\\xb")).toBe("axb")
  })

  test("round trip with special and unicode characters", () => {
    const value = "a; b\\c\r\nd — ünï 日本語 🎉"
    expect(unescapeTagValue(escapeTagValue(value))).toBe(value)
    const line = serializeLine(msg("PING", ["x"], { tags: [["k", value]] }))
    expect(line.includes("\r") || line.includes("\n")).toBe(false)
    const parsed = parseLine(line)
    expect(getTag(parsed, "k")).toBe(value)
    expect(serializeLine(parsed)).toBe(line)
  })
})

describe("serializeLine", () => {
  test("trailing rules", () => {
    expect(serializeLine(msg("CMD", ["a", "b"]))).toBe("CMD a b")
    expect(serializeLine(msg("CMD", ["a", "b c"]))).toBe("CMD a :b c")
    expect(serializeLine(msg("CMD", ["a", ""]))).toBe("CMD a :")
    expect(serializeLine(msg("CMD", ["a", ":b"]))).toBe("CMD a ::b")
    expect(serializeLine(msg("CMD", ["a b", "c"]))).toBe("CMD a b c")
    expect(serializeLine(msg("CMD"))).toBe("CMD")
  })

  test("tags and source", () => {
    const m = msg("PRIVMSG", ["#c", "hi there"], {
      tags: [
        ["a", "x y"],
        ["b", null],
        ["c", ""],
      ],
      source: "n!u@h",
    })
    expect(serializeLine(m)).toBe("@a=x\\sy;b;c :n!u@h PRIVMSG #c :hi there")
  })
})

describe("LineSplitter", () => {
  test("multiple lines in one chunk", () => {
    const s = new LineSplitter()
    expect(s.push("A\r\nB\nC\r\n")).toEqual(["A", "B", "C"])
    expect(s.pending).toBe("")
  })

  test("partial line stays pending", () => {
    const s = new LineSplitter()
    expect(s.push("PING ab")).toEqual([])
    expect(s.pending).toBe("PING ab")
    expect(s.push("c\r\n")).toEqual(["PING abc"])
    expect(s.pending).toBe("")
  })

  test("split in the middle of CRLF", () => {
    const s = new LineSplitter()
    expect(s.push("A\r")).toEqual([])
    expect(s.push("\nB\r")).toEqual(["A"])
    expect(s.push("\n")).toEqual(["B"])
    expect(s.pending).toBe("")
  })

  test("empty lines dropped", () => {
    const s = new LineSplitter()
    expect(s.push("\r\n\nA\n\r\n\nB\r\n")).toEqual(["A", "B"])
  })

  test("byte-by-byte", () => {
    const s = new LineSplitter()
    const out: string[] = []
    for (const ch of "A b\r\nC\nD\r\n") out.push(...s.push(ch))
    expect(out).toEqual(["A b", "C", "D"])
  })
})

describe("helpers", () => {
  test("getTag", () => {
    const m = parseLine("@a=1;b PING")
    expect(getTag(m, "a")).toBe("1")
    expect(getTag(m, "b")).toBe("")
    expect(getTag(m, "c")).toBeUndefined()
  })

  test("setTag replaces in place or appends", () => {
    const m = msg("PING", [], { tags: [["a", "1"], ["b", "2"]] })
    setTag(m, "a", "9")
    setTag(m, "c", null)
    expect(m.tags).toEqual([
      ["a", "9"],
      ["b", "2"],
      ["c", null],
    ])
  })

  test("vendorTag", () => {
    expect(vendorTag("msgid")).toBe(`${TAG_VENDOR}/msgid`)
  })

  test("msg defaults", () => {
    expect(msg("PING")).toEqual({ tags: [], source: null, command: "PING", params: [] })
  })

  test("sourceNick", () => {
    expect(sourceNick(msg("X", [], { source: "nick!user@host" }))).toBe("nick")
    expect(sourceNick(msg("X", [], { source: "server.name" }))).toBe("server.name")
    expect(sourceNick(msg("X"))).toBeNull()
  })
})
