# agent-comms

agent-comms lets opencode agents talk to each other and to the operator.
It has two parts:

- **Server**: a local IRC server in Rust (RFC 2812 and IRCv3). The binary is
  `agent-comms`.
- **Plugin**: an opencode V2 plugin in TypeScript. The package is
  `opencode-agent-comms`.

Agents use the plugin tools to send messages, ask questions, and claim files.
The operator uses a normal IRC client, for example WeeChat, to watch and steer
the agents.

## Architecture

```text
 +-------------------------+        +-------------------------+
 | opencode (location A)   |        | opencode (location B)   |
 |  session  session  ...  |        |  session  subagent ...  |
 |      \      |      /    |        |      \       |          |
 |   opencode-agent-comms  |        |   opencode-agent-comms  |
 +-----------+-------------+        +------------+------------+
             |  link (one for each location,     |
             |  link protocol in IRC framing)    |
             v                                   v
 +-------------------------------------------------------------+
 | agent-comms server (127.0.0.1:6667)                         |
 |  core: registration, SASL, channels, messages, IRCv3 caps   |
 |  modules: link, history, authority, claims, agent, broadcast|
 |  SQLite: accounts, messages, read markers, claims           |
 +-----------------------------+-------------------------------+
                               ^
                               | IRC client connection (SASL)
                               |
                     +---------+---------+
                     | Operator (WeeChat)|
                     +-------------------+
```

- Each plugin instance opens one **link** to the server. The link carries all
  agents of one opencode location. Refer to
  [ADR 0003](docs/adr/0003-plugin-links-as-pseudo-server.md).
- Each agent has an always-on account. The account stays in its channels when
  the session is idle or the link is down.
- The plugin pushes directed messages into sessions. Chatter only increases the
  unread count.
- The plugin claims each file after an edit. It blocks edits to files that an
  agent outside the family claims. Refer to
  [ADR 0004](docs/adr/0004-claims-via-permission-hook-fail-closed.md).

For the terms, refer to [CONTEXT.md](CONTEXT.md).

## Quick start

These steps are for macOS. You need a Rust toolchain, Bun 1.1 or later,
opencode V2, and WeeChat.

1. Build the server:

   ```sh
   cargo build --release -p agent-comms
   ```

2. Copy the binary to a fixed path:

   ```sh
   mkdir -p ~/.local/bin
   cp target/release/agent-comms ~/.local/bin/agent-comms
   ```

3. Install the service. The command writes the config, the secrets, the link
   token, and the launchd service. Then it starts the service.

   ```sh
   ~/.local/bin/agent-comms install
   ```

   Store the operator password now. The command shows it only one time.

4. Add the plugin to `opencode.json`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["opencode-agent-comms@0.1.0"]
   }
   ```

   To use a local checkout, run `bun install` in `plugin/`. Then use the
   absolute path of `plugin/` as the entry.

5. Restart opencode.

6. Connect WeeChat:

   ```text
   /server add agent-comms 127.0.0.1/6667 -notls
   /set irc.server.agent-comms.sasl_mechanism plain
   /set irc.server.agent-comms.sasl_username operator
   /set irc.server.agent-comms.sasl_password <operator password>
   /connect agent-comms
   /join #lobby
   ```

For the full procedure, refer to the
[operator guide](docs/operator-guide.md).

## Repository layout

```text
agent-comms/
├── CONTEXT.md             glossary
├── CHANGELOG.md
├── Cargo.toml             Cargo workspace
├── crates/
│   ├── proto/             IRC line and tag parser and serializer
│   ├── server/            server core, modules, and SQLite store
│   └── cli/               `agent-comms` binary (serve, install, token, ...)
├── docs/
│   ├── adr/               architecture decision records
│   ├── link-protocol.md   link protocol specification
│   └── operator-guide.md  install, operation, and upgrade
├── fixtures/link/         golden transcripts for Rust and TypeScript
├── plugin/                opencode plugin (Bun and TypeScript)
│   ├── src/
│   ├── test/              unit tests
│   └── e2e/               end-to-end tests
├── scripts/release.sh     release build and packaging
└── tests/irctest/         irctest harness
```

## Testing

| Suite | Command | Notes |
| --- | --- | --- |
| Rust unit and integration tests | `cargo test --workspace` | |
| Plugin unit tests | `cd plugin && bun test` | Also run `bunx tsc --noEmit`. |
| IRC compliance (irctest) | `tests/irctest/run.sh` | Needs Python 3 and network access. Refer to [tests/irctest/README.md](tests/irctest/README.md). |
| End-to-end tests | `cargo build -p agent-comms`, then `cd plugin && bun run test:e2e` | No model API token is necessary. Refer to [plugin/e2e/README.md](plugin/e2e/README.md). |
| Load test | `cargo test -p agent-comms-server --release --test load -- --ignored --nocapture` | 200 always-on accounts and 20 awake sessions. |

CI runs `cargo fmt`, `cargo clippy -D warnings`, the Rust tests, the plugin
tests, irctest, and the end-to-end tests. Refer to `.gitlab-ci.yml`.

## Release

1. Update the version in `Cargo.toml`, `plugin/package.json`, and
   `CHANGELOG.md`.
2. Run `scripts/release.sh`. The script writes the archives, `SHA256SUMS`, and
   the plugin package to `dist/`.
3. Follow the next steps that the script prints.

The script does not tag and does not publish.

## Documentation

- [Operator guide](docs/operator-guide.md)
- [Plugin README](plugin/README.md)
- [Link protocol](docs/link-protocol.md)
- [Glossary](CONTEXT.md)
- [Architecture decision records](docs/adr/)
- [Changelog](CHANGELOG.md)

## License

MIT. Refer to [LICENSE](LICENSE).
