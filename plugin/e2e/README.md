# End-to-end test harness

These tests start the real parts of the system. They do not use a real model.

- A real `agent-comms serve` process runs on a free port.
- opencode runs inside the test process. The V2 SDK embeds it. No HTTP port opens.
- A mock model replaces the LLM. It is an OpenAI-compatible server that follows a script.
- An operator IRC client connects to the server, like WeeChat does.

The tests need no API token and no network.

## Run the tests

1. Build the server: `cargo build -p agent-comms`.
2. Run: `bun run test:e2e` (in the `plugin/` directory).

`bun test` and `bun run test` do not run these tests. `bunfig.toml` ignores the `e2e/` directory.
The e2e files end in `.e2e.test.ts`, because `bun test` only finds files that end in `.test.ts`.

Environment variables:

| Variable | Meaning |
| --- | --- |
| `AGENT_COMMS_BIN` | Path of the server binary. Default: `../target/debug/agent-comms`. |
| `E2E_RUST_LOG` | `RUST_LOG` value for the server. Default: `info`. |
| `E2E_VERBOSE=1` | Print opencode log lines to stderr. |
| `E2E_KEEP=1` | Do not delete the temp directories. |

## Files

| File | Purpose |
| --- | --- |
| `mock-model.ts` | The scripted OpenAI-compatible model server. |
| `server.ts` | Starts and stops the Rust server. |
| `irc-client.ts` | The operator IRC client. |
| `opencode.ts` | Embeds opencode with the SDK. |
| `smoke.e2e.test.ts` | One smoke test that uses all four parts. |

## Mock model

`createMockModel()` starts `Bun.serve` on port 0. It answers `POST /v1/chat/completions`
in streaming mode (SSE) and in non-streaming mode. It supports tool calls.

Use `model.url` as the provider `baseURL`.

Each request is matched to a script by a marker. The marker is a session tag,
for example `[[e2e:add-login]]`. The tag must be in the first user message or in the system prompt.
The helper `opencode.prompt(sessionID, text, { tag: "add-login" })` adds it.

```ts
const model = createMockModel()
model.title("add-login", "Add login")
model.script("add-login", [
  { toolCall: { name: "irc_send", arguments: { target: "#lobby", text: "hi" } } },
  (request) => ({ text: `saw: ${request.lastToolResult}` }),
  { text: "done" },
])
```

- The n-th matching request uses the n-th step.
- A step is `{ text }`, `{ toolCall }`, `{ toolCalls }`, or `{ error: { status, message } }`.
  Add `delayMs` to slow the answer.
- A step can be a function `(request, callIndex) => step`. The function sees the whole conversation.
  Use `request.allText`, `request.lastUser`, `request.lastToolResult`, and `request.messages`.
- After the last step, the script gives the default text (`ok`). Use `{ repeatLast: true }` to repeat the last step.
- A matcher is a tag string, a text fragment, a `RegExp`, or a function.
- The title-generation request of opencode never uses a script. It gets the text from `model.title(matcher, text)`.
  The default title is `E2E session`.
- `model.requests` records every request. Use `model.waitForRequest(predicate)` and `model.find(predicate)`.

## Server

`startServer()` does these steps:

1. It creates a temp config directory.
2. It writes `config.toml` with a free `bind` port, `data_dir`, `secrets_path`, `require_sasl = true`,
   and small limits (for example `claim_idle_secs = 60`).
3. It runs `agent-comms install --no-launchd --operator-password <pw>`.
   This writes `secrets.toml` (mode 0600) and the `link-token` file.
   The config file exists before this step. So `install` never writes to the real data directory.
4. It starts `agent-comms serve` and waits until the port accepts connections.

The process gets its own `HOME` and `XDG_*` directories. It never reads `~/.config/agent-comms`.

The result has `port`, `configDir`, `tokenPath`, `operatorPassword`, `stop()`, `restart()`,
`cleanup()`, and `log()`. `restart()` keeps the port and the data.

## IRC client

`IrcClient.connect({ host, port, password })` does `CAP LS 302`, `CAP REQ`
(`message-tags server-time echo-message batch labeled-response away-notify` and `sasl`),
then SASL PLAIN as `operator`. It waits for `001`.

Main methods: `join`, `part`, `privmsg`, `quote`, `send`, `names`, `waitFor`,
`waitForMessage`, `waitForMember`, `mark`, `close`.
`waitFor` also looks at lines that arrived earlier. Use `since: client.mark()` to ignore old lines.

## Embedded opencode

`startOpencode({ serverPort, tokenPath, mockUrl })` does these steps:

1. It sets `HOME`, `OPENCODE_TEST_HOME`, and `XDG_*` to a temp directory.
   Then it loads `@opencode/sdk` with a dynamic import. opencode reads these variables when it loads.
   The real `~/.config/opencode` stays untouched.
2. It creates a temp project directory and runs `git init`.
3. It builds an inline config (`config.content`):
   - `plugins`: this repository's `plugin/` directory, with the options
     `{ host, port, tokenPath, graceMs: 200, askTimeoutMs: 5000 }`.
   - `providers.e2e`: package `@opencode/ai/providers/openai-compatible`, `baseURL` = mock model URL.
   - `model`: `e2e/mock`.
   - `permissions`: allow all. Rules from `options.permissions` come after it. The last matching rule wins.
4. It calls `OpenCode.create(...)` with a temp database and a temp global config directory.
5. It records all events.

Helpers: `createSession`, `prompt`, `waitIdle`, `messages`, `events`, `waitForEvent`,
`permissionRequests`, `waitForPermission`, `replyPermission`, `loadedPlugins`, `stop`.
The field `sdk` is the full SDK host, for cases that the helpers do not cover.

`waitIdle` waits for the event `session.execution.started` after the last `prompt`.
Then it polls `sessions.active()` until the session is not active.
A wake-up that arrives later (for example from an IRC message) starts a new run.
Wait for a mock model request first, then call `waitIdle` again.

## Limits

- `@opencode/simulation` is not used. It needs the simulation control protocol of the opencode frontend.
  The OpenAI-compatible stub is simpler.
- All `startOpencode` calls in one test process share one temp `HOME`. opencode reads it only once.
  Each call has its own database, config directory, and project directory.
- The harness sets `process.env.HOME` in the test process. Do not depend on the real home directory in e2e tests.
- Plugin loading from an absolute path (`plugins: [{ package: "/abs/plugin" }]`) follows the V2 plugin docs.
  If opencode cannot load `plugin/` (it uses `exports["."] = "./src/index.ts"`), check `opencode.logs`
  and `opencode.loadedPlugins()`.
- The tests wait on real time (grace timers, SASL, argon2 hashing). Use generous timeouts.
