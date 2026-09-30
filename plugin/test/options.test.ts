import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_OPTIONS, parseOptions, readToken } from "../src/options.ts"

describe("parseOptions", () => {
  test("undefined and null give defaults without warnings", () => {
    for (const raw of [undefined, null, {}]) {
      const { options, warnings } = parseOptions(raw)
      expect(options).toEqual(DEFAULT_OPTIONS)
      expect(warnings).toEqual([])
    }
  })

  test("defaults have the documented values", () => {
    expect(DEFAULT_OPTIONS.enabled).toBe(true)
    expect(DEFAULT_OPTIONS.failMode).toBe("ask")
    expect(DEFAULT_OPTIONS.host).toBe("127.0.0.1")
    expect(DEFAULT_OPTIONS.port).toBe(6667)
    expect(DEFAULT_OPTIONS.hopLimit).toBe(4)
    expect(DEFAULT_OPTIONS.wakeWindowMs).toBe(3_600_000)
    expect(DEFAULT_OPTIONS.tokenPath.endsWith("agent-comms/link-token")).toBe(true)
    expect(DEFAULT_OPTIONS.claimEditTools).toContain("apply_patch")
  })

  test("valid values are applied", () => {
    const { options, warnings } = parseOptions({
      enabled: false,
      excludeAgents: ["plan"],
      failMode: "deny",
      host: "irc.example",
      port: 6697,
      tls: true,
      tlsCaPath: "/ca.pem",
      tokenPath: "/tok",
      hopLimit: 2,
      backoffMaxMs: 1000,
      editActions: ["edit"],
    })
    expect(warnings).toEqual([])
    expect(options.enabled).toBe(false)
    expect(options.excludeAgents).toEqual(["plan"])
    expect(options.failMode).toBe("deny")
    expect(options.host).toBe("irc.example")
    expect(options.port).toBe(6697)
    expect(options.tls).toBe(true)
    expect(options.tlsCaPath).toBe("/ca.pem")
    expect(options.tokenPath).toBe("/tok")
    expect(options.hopLimit).toBe(2)
    expect(options.backoffMaxMs).toBe(1000)
    expect(options.editActions).toEqual(["edit"])
  })

  test("invalid values fall back to defaults with warnings", () => {
    const { options, warnings } = parseOptions({
      enabled: "yes",
      failMode: "maybe",
      port: 70000,
      hopLimit: 1.5,
      excludeAgents: [1, 2],
      host: "",
      tlsCaPath: 5,
      graceMs: "10",
    })
    expect(options).toEqual(DEFAULT_OPTIONS)
    expect(warnings.length).toBe(8)
    expect(warnings.some((w) => w.includes("failMode"))).toBe(true)
    expect(warnings.some((w) => w.includes("port"))).toBe(true)
  })

  test("unknown keys are ignored with a warning", () => {
    const { options, warnings } = parseOptions({ bogus: 1, port: 7000 })
    expect(options.port).toBe(7000)
    expect(warnings).toEqual(['unknown option "bogus" ignored'])
  })

  test("non-object input warns and gives defaults", () => {
    for (const raw of ["x", 5, [1]]) {
      const { options, warnings } = parseOptions(raw)
      expect(options).toEqual(DEFAULT_OPTIONS)
      expect(warnings.length).toBe(1)
    }
  })

  test("result does not share arrays with the defaults", () => {
    const { options } = parseOptions({})
    options.excludeAgents.push("x")
    options.claimEditTools.push("y")
    expect(DEFAULT_OPTIONS.excludeAgents).toEqual([])
    expect(DEFAULT_OPTIONS.claimEditTools).not.toContain("y")
  })
})

describe("readToken", () => {
  test("reads and trims the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-comms-opt-"))
    const path = join(dir, "link-token")
    writeFileSync(path, "  secret-token\n")
    expect(await readToken(path)).toBe("secret-token")
  })

  test("missing file mentions agent-comms install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-comms-opt-"))
    let message = ""
    try {
      await readToken(join(dir, "nope"))
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain("agent-comms install")
  })

  test("empty file is an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-comms-opt-"))
    const path = join(dir, "link-token")
    writeFileSync(path, "\n")
    await expect(readToken(path)).rejects.toThrow("agent-comms install")
  })
})
