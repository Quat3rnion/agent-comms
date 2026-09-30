/**
 * Smoke test for the harness: real agent-comms server + embedded opencode + mock model.
 *
 * Run with `bun run test:e2e` (default `bun test` skips this directory).
 * The server binary must exist: `cargo build -p agent-comms`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { IrcClient } from "./irc-client.ts"
import { createMockModel } from "./mock-model.ts"
import type { MockModel } from "./mock-model.ts"
import { removeSharedRoot, startOpencode } from "./opencode.ts"
import type { TestOpencode } from "./opencode.ts"
import { startServer } from "./server.ts"
import type { TestServer } from "./server.ts"

let server: TestServer
let model: MockModel
let opencode: TestOpencode
let operator: IrcClient

beforeAll(async () => {
  model = createMockModel()
  server = await startServer()
  opencode = await startOpencode({
    serverPort: server.port,
    tokenPath: server.tokenPath,
    mockUrl: model.url,
  })
  operator = await IrcClient.connect({
    host: server.host,
    port: server.port,
    password: server.operatorPassword,
  })
}, 60_000)

afterAll(async () => {
  await operator?.close()
  await opencode?.stop()
  await model?.close()
  await server?.cleanup()
  removeSharedRoot()
}, 30_000)

function diagnostics(): string {
  const logs = opencode.logs.slice(-40).map((l) => `[${l.level}] ${l.message}`)
  const requests = model.requests.map((r) => `#${r.index} ${r.kind} tag=${r.tag} answer=${r.answer}`)
  return [
    "--- server log (tail) ---",
    server.log().split("\n").slice(-40).join("\n"),
    "--- opencode log (tail) ---",
    logs.join("\n"),
    "--- model requests ---",
    requests.join("\n"),
  ].join("\n")
}

test(
  "a session joins #lobby and an operator DM reaches the model as [IRC]",
  async () => {
    try {
      operator.join("#lobby")
      await operator.waitFor((l) => l.command === "366" && l.params[1] === "#lobby", 10_000)

      model.title("smoke", "Smoke session")
      model.script("smoke", [{ text: "Hello from the mock model." }])

      const sessionID = await opencode.createSession()
      await opencode.prompt(sessionID, "Say hello.", { tag: "smoke" })

      // The session nick joins #lobby (JOIN line or NAMES reply).
      await operator.waitForMember("#lobby", (nick) => nick !== operator.nick, 30_000)
      await opencode.waitIdle(sessionID, 30_000)

      // The nick can change after the title is set. Read the current nick.
      const nicks = (await operator.names("#lobby")).filter((n) => n !== operator.nick)
      expect(nicks.length).toBeGreaterThan(0)
      const nick = nicks[0] as string

      const text = "please reply with pong"
      operator.privmsg(nick, text)

      const request = await model.waitForRequest(
        (r) => r.kind === "primary" && r.allText.includes("[IRC]") && r.allText.includes(text),
        30_000,
      )
      expect(request.tag).toBe("smoke")
    } catch (error) {
      console.error(diagnostics())
      throw error
    }
  },
  60_000,
)
