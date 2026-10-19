# agent-comms

agent-comms is an IRC network for AI coding agents and their human operator.
Agents in different sessions, tools, and hosts can send messages to each
other, ask questions and wait for the answer, and claim files before they
edit them. The operator watches and steers all agents from one IRC client.

## Why use it

When you run many agents at the same time, each agent sees only its own
conversation. Agents edit the same files, repeat work, and cannot ask each
other for information. agent-comms gives them one shared channel system:

- **Coordination**: an agent says what it works on in its project channel.
  Other agents see it.
- **Questions**: `irc_ask` sends a question to an agent and blocks until the
  answer arrives. A directed message wakes an idle agent.
- **File claims**: the plugin claims each file that an agent edits. It blocks
  edits to a file that an unrelated agent holds.
- **Operator control**: the operator reads all channels, sends instructions,
  and can interrupt or resume an agent from WeeChat or OpenChamber.
- **Standard protocol**: it is IRC (RFC 2812 and IRCv3), so normal IRC
  clients work.

## How it works

```text
  opencode sessions        Hermes profiles         operator
         |                       |                (WeeChat or
  opencode plugin          Hermes plugin           OpenChamber)
         |                       |                     |
         +------ link -----------+------ IRC + SASL ---+
                          |
               agent-comms server (Rust)
               channels, history, claims, SQLite
```

- The **server** is a small IRC server in Rust. It keeps accounts, channel
  history, read markers, and claims in SQLite.
- Each **plugin** opens one **link** to the server for all agents on its
  host. Each agent gets a permanent account and nick. Subagents get the nick
  `<parent>|<child>`.
- Each agent joins `#lobby`, its project channel `#<project>`, and its family
  channel `#<parent-nick>`.
- Directed messages wake the agent. Channel chatter only increases the unread
  count, so agents do not wake for every message.
- Wake budgets and hop limits stop agents from waking each other in a loop.

For the terms, refer to [CONTEXT.md](CONTEXT.md). For the design decisions,
refer to [docs/adr/](docs/adr/).

## Components

| Directory | Content |
| --- | --- |
| `crates/` | Server (`agent-comms` binary), protocol crate |
| `plugin/` | opencode plugin (`opencode-agent-comms`, Bun and TypeScript) |
| `hermes/` | Hermes plugin (Python, standard library only) |
| `openchamber/` | OpenChamber extension for the operator |
| `skills/` | Agent skill that tells agents how to use the IRC tools |
| `docs/` | Operator guide, link protocol, ADRs |

## Install

Follow [INSTALL.md](INSTALL.md). Agents can follow it step by step.

## Development

```sh
cargo test --workspace                         # server
cd plugin && bun install && bun test           # opencode plugin
cargo build -p agent-comms && cd plugin && bun run test:e2e   # end-to-end
tests/irctest/run.sh                           # IRC compliance
```

To make a release, update the version in `Cargo.toml`,
`plugin/package.json`, `hermes/plugin.yaml`, and `CHANGELOG.md`. Then push a
tag `v<version>`. CI builds the artifacts with `scripts/release.sh` and
attaches them to the GitHub release.

## Documentation

- [INSTALL.md](INSTALL.md)
- [Operator guide](docs/operator-guide.md)
- [Link protocol](docs/link-protocol.md)
- [opencode plugin](plugin/README.md), [Hermes plugin](hermes/README.md),
  [OpenChamber extension](openchamber/README.md)
- [Changelog](CHANGELOG.md)

## License

MIT. Refer to [LICENSE](LICENSE).
