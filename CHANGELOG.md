# Changelog

All important changes to this project are in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Plugin: a session that moves to another directory no longer loses DMs. The
  old location sends the new link verb `DETACH`, so the server stops sending
  deliveries to a link that does not serve the session. A delivery for an
  unknown account is logged and causes a `DETACH`.
- Plugin: DMs between a parent and its subagents use a separate wake budget
  (`familyWakeBudget`, default 60 for each window). Subagent reports no longer
  stay unread when the normal wake budget is used up.
- Plugin: "Not pushed to you" in the session context shows held DMs first, and
  the newest first.

### Added

- Server: link verb `DETACH <account>` (link protocol section 6.9).

### Added

- Hermes plugin in `hermes/`: gateway platform, IRC tools, and file claims.
- `INSTALL.md`: an install procedure that agents can follow.
- GitHub Actions CI and release workflow.
- `scripts/release.sh` packages the Hermes plugin.

## [0.1.0] - 2026-09-29

### Added

#### Protocol crate

- IRC line parser and serializer with IRCv3 message tags and tag value escapes.
- Length limits: 512 bytes for the message body and 8191 bytes for tags.
- Typed numerics.
- Property tests and golden link fixtures in `fixtures/link/`.

#### Server core and IRCv3 capabilities

- TCP listener on `127.0.0.1:6667` with bounded outbound queues.
- Registration: `CAP` (version 302), `NICK`, `USER`, `PING`, `PONG`, `QUIT`.
- SASL PLAIN. The server rejects connections that do not authenticate.
- Channels: `JOIN`, `PART`, `TOPIC`, `NAMES`, `LIST`, `KICK`, and the minimum
  channel modes.
- Messages: `PRIVMSG`, `NOTICE`, `TAGMSG`.
- Queries: `WHO`, `WHOIS`, `AWAY`.
- Capabilities: `message-tags`, `server-time`, `msgid`, `account-tag`,
  `away-notify`, `echo-message`, `batch`, `labeled-response`, and
  `draft/multiline` (maximum 16 KB).
- Flood control for each connection.
- `Module` trait. The configuration can turn each module on or off.
- The server removes client-supplied server tags before it routes a message.
- Optional TLS through `rustls`. The server does not start on a non-loopback
  bind without TLS.

#### History

- SQLite store with schema migrations.
- `draft/chathistory` with `LATEST`, `BEFORE`, `AFTER`, `BETWEEN`, and
  `TARGETS`.
- `draft/read-marker`. Markers stay after a server restart.
- Stored messages for dormant accounts. The server replays them after the link
  connects again.
- Retention task (7 days) and account retirement task (30 days without
  activity).

#### Link protocol

- Link protocol version 1. Refer to `docs/link-protocol.md`.
- `LINK` handshake with a link credential, a link name, and a protocol version.
- `INTRODUCE`, `RETIRE`, `BURST`, `ENDBURST`, `DELIVER`, and `SEND`.
- Nick rename. The server keeps the old nick as a reserved alias.
- Always-on presence. When a link goes down, its users stay in their channels
  and show `AWAY`.
- Transfer of an account to a different link.
- Automatic join of `#lobby`, `#<project>`, and the family channel
  `#<parent-nick>`.
- Authority tags `agent-comms.local/role` and `agent-comms.local/parent` on
  each routed message. The server passes the hop tag
  `+agent-comms.local/hop` through without change.

#### Claims

- `CLAIM` and `RELEASE` with canonical absolute paths.
- Claims in SQLite with an idle deadline (10 minutes). Claims stay after a
  restart.
- The server sends claim changes to all links.
- `CLAIMS <#channel|path>` for the operator.
- `CLAIM --force <path>` for the operator only.

#### AGENT verb and broadcasts

- `AGENT STATUS`, `AGENT INTERRUPT`, and `AGENT RESUME`. The server routes them
  to the owner link. Only the operator can use them.
- `@here` and `@all` broadcasts. Only the operator can use `@all`.

#### CLI and launchd

- `agent-comms serve` with `--config` and `--log-format text|json`.
- `agent-comms install` with `--force`, `--no-launchd`,
  `--operator-password`, and `--port`. It writes the config, the secrets
  (mode `0600`), the link token, and the launchd service.
- `agent-comms uninstall`.
- `agent-comms token list|rotate|revoke|show-path`.
- `agent-comms operator-password` with `--password` and `--prompt`.
- `agent-comms config check`.
- Global option `--config-dir` and variable `AGENT_COMMS_CONFIG_DIR`.

#### Plugin

- opencode V2 plugin `opencode-agent-comms`. It pins `@opencode/plugin`
  version `2.0.20`.
- Link client with TLS and exponential backoff (maximum 30 s).
- One nick for each session. Provisional nick `<agent>-<shortid>`, then one
  rename to the title slug. Subagents use `parent|child`.
- Delivery: directed messages or chatter. A steer for a busy session, a wake
  for an idle session.
- Authority labels for operator, ancestor, descendant, and peer messages.
- Hop limit (4) and wake budget (10 wakes for each session in each hour).
- `context` hook with nick, channels, unread counts, budget, link state, and
  tool guidance.
- Tools: `irc_send`, `irc_ask`, `irc_wait`, `irc_read`, `irc_join`,
  `irc_part`, `irc_names`, `irc_release`.
- `/irc on`, `/irc off`, and `/irc status`. Children get the setting of their
  parent.
- Automatic claims after edits. The permission hook denies edits to files that
  an agent outside the family claims.
- Fail modes `ask` (default), `deny`, and `open`, with a grace period of 10 s.
- Handling of `AGENT STATUS`, `AGENT INTERRUPT`, and `AGENT RESUME`.

#### Tests and CI

- Rust integration tests with a fake link and fake clients.
- Plugin unit tests that replay the shared link fixtures.
- irctest harness in `tests/irctest/`.
- End-to-end tests with embedded opencode and a mock model.
- Load test with 200 always-on accounts and 20 awake sessions.
- GitLab CI jobs for checks, irctest, end-to-end tests, and releases.

[Unreleased]: https://github.com/Quat3rnion/agent-comms/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Quat3rnion/agent-comms/releases/tag/v0.1.0
