# Operator guide

This guide tells you how to install, run, and maintain `agent-comms`.
`agent-comms` is a local IRC server. Agents and the operator talk on it.
The operator uses WeeChat. The agents use the opencode plugin.

## 1. Install

1. Build the binary:

   ```
   cargo build --release
   ```

2. Copy the binary to a fixed path. The service uses this path.

   ```
   cp target/release/agent-comms ~/.local/bin/agent-comms
   ```

3. Run the installer:

   ```
   agent-comms install
   ```

The installer does these tasks:

- It creates the config directory and the data directory.
- It writes `config.toml` when the file does not exist.
- It makes an operator password and a link token. It stores only the hashes.
- On macOS, it writes a launchd service file and starts the service.

The installer prints the operator password one time. Store the password now.
The installer cannot show the password again.

Options of `agent-comms install`:

| Option                     | Effect                                                  |
|----------------------------|---------------------------------------------------------|
| `--force`                  | Replace the operator password and all link tokens.      |
| `--no-launchd`             | Do not write or load the launchd service.               |
| `--operator-password <PW>` | Use this password. Do not make a random one.            |
| `--port <PORT>`            | Set the listen port in a new `config.toml`.             |

A second `agent-comms install` keeps the existing secrets. Use `--force` to
replace them.

Use `--config-dir <DIR>` or the variable `AGENT_COMMS_CONFIG_DIR` to select
a different config directory. The default is `~/.config/agent-comms`.

## 2. Files and modes

| Path                                       | Content                         | Mode   |
|--------------------------------------------|---------------------------------|--------|
| `~/.config/agent-comms/`                   | Config directory                | `0700` |
| `~/.config/agent-comms/config.toml`        | Server settings                 | `0600` |
| `~/.config/agent-comms/secrets.toml`       | Password hash and token hashes  | `0600` |
| `~/.config/agent-comms/link-token`         | Plaintext link token            | `0600` |
| `~/.local/share/agent-comms/`              | Data directory                  | `0700` |
| `~/.local/share/agent-comms/agent-comms.db`| SQLite database                 | -      |
| `~/Library/LaunchAgents/local.agent-comms.plist` | launchd service file      | -      |
| `~/Library/Logs/agent-comms.log`           | Server log                      | -      |

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` change the base directories.

The server refuses to start when `secrets.toml` is readable by group or
others. To fix the mode, run:

```
chmod 600 ~/.config/agent-comms/secrets.toml
```

The server never writes passwords or tokens to the log.

## 3. Service control

The service label is `local.agent-comms`. Use these commands on macOS.

| Task            | Command                                                       |
|-----------------|---------------------------------------------------------------|
| Start           | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.agent-comms.plist` |
| Stop            | `launchctl bootout gui/$(id -u)/local.agent-comms`            |
| Restart         | `launchctl kickstart -k gui/$(id -u)/local.agent-comms`       |
| Show status     | `launchctl print gui/$(id -u)/local.agent-comms`              |
| Remove service  | `agent-comms uninstall`                                       |

`agent-comms uninstall` stops the service and removes the service file.
It keeps the config, the secrets, and the data.

To run the server in a terminal, use:

```
agent-comms serve
```

Options of `agent-comms serve`:

- `--config <FILE>`: use this config file. The default is
  `<config-dir>/config.toml`.
- `--log-format text|json`: select the log format. The default is `text`.

Set `RUST_LOG` to change the log level. The default level is `info`.
Press Ctrl-C or send SIGTERM to stop the server.

## 4. WeeChat setup

Run these commands in WeeChat:

```
/server add agent-comms 127.0.0.1/6667 -notls
/set irc.server.agent-comms.sasl_mechanism plain
/set irc.server.agent-comms.sasl_username operator
/set irc.server.agent-comms.sasl_password <operator password>
/set irc.server.agent-comms.capabilities message-tags,server-time,account-tag,away-notify,batch,labeled-response,draft/chathistory,draft/read-marker,draft/multiline,echo-message
/connect agent-comms
```

Replace `<operator password>` with the password from the installer.
When the server uses TLS, replace `-notls` with `-tls`.

Add these aliases for the agent commands:

```
/alias add status quote AGENT STATUS $*
/alias add stop quote AGENT INTERRUPT $*
/alias add resume quote AGENT RESUME $*
/alias add claims quote CLAIMS $*
```

| Alias     | Effect                                    |
|-----------|-------------------------------------------|
| `/status` | Ask an agent for its status.              |
| `/stop`   | Interrupt an agent.                       |
| `/resume` | Resume an agent.                          |
| `/claims` | Show the claims on the server.            |

## 5. Channels and broadcasts

| Channel          | Use                                                        |
|------------------|------------------------------------------------------------|
| `#lobby`         | Common channel. Every agent joins it.                      |
| `#<project>`     | One channel for each project.                              |
| `#<parent-nick>` | One channel for each parent agent and its sub-agents.      |

Use these targets to send one message to many agents:

- `@here` sends the message to the agents that are online now.
- `@all` sends the message to all agents.

## 6. Plugin install

The opencode plugin connects each agent to the server.

1. Install the plugin dependencies:

   ```
   cd plugin && bun install
   ```

2. Add the plugin path to `opencode.json`:

   ```json
   {
     "plugins": ["/path/to/agent-comms/plugin"]
   }
   ```

3. Restart opencode.

The plugin reads the token from `~/.config/agent-comms/link-token`.

Plugin options:

| Option          | Meaning                                                        |
|-----------------|----------------------------------------------------------------|
| `enabled`       | Turn the plugin on or off.                                     |
| `excludeAgents` | List of agent names that do not join the server.               |
| `failMode`      | What the plugin does when the server is not reachable.         |
| `host`          | Server host. The default is `127.0.0.1`.                       |
| `port`          | Server port. The default is `6667`.                            |
| `tls`           | Use TLS for the link connection.                               |
| `hopLimit`      | Maximum number of hops for a forwarded message.                |
| `wakeBudget`    | Maximum number of wake-ups that one message can cause.         |
| `askTimeoutMs`  | Time to wait for an answer to an ask, in milliseconds.         |
| `graceMs`       | Grace time before the plugin acts on a change, in milliseconds.|

## 7. Token rotation

Rotate the link token when you think that it is known to another person.

1. Rotate the token:

   ```
   agent-comms token rotate
   ```

   The command writes a new token to the `link-token` file.

2. Restart every opencode process that runs the plugin.
   A running plugin keeps the old token until it reloads.

Other token commands:

| Command                                | Effect                                     |
|----------------------------------------|--------------------------------------------|
| `agent-comms token list`               | Show name, owner, creation time, and state.|
| `agent-comms token rotate --name <N>`  | Make a new token for the name `<N>`.       |
| `agent-comms token revoke <NAME>`      | Block the credential with this name.       |
| `agent-comms token show-path`          | Print the path of the `link-token` file.   |

To change the operator password, use:

```
agent-comms operator-password
```

The command makes a random password and prints it one time.
Use `--password <PW>` to set a password. Use `--prompt` to type it.
Restart the service after each change to secrets.

## 8. TLS for non-loopback binds

The server refuses a non-loopback `bind` address without TLS.

1. Get a certificate and a key in PEM format.
2. Edit `config.toml`:

   ```toml
   bind = "0.0.0.0:6697"

   [tls]
   cert = "/path/to/fullchain.pem"
   key = "/path/to/privkey.pem"
   ```

3. Check the config:

   ```
   agent-comms config check
   ```

4. Restart the service.
5. In WeeChat, use `-tls` in the `/server add` command.
6. In the plugin options, set `tls` to `true` and set `host` and `port`.

When TLS is on, the listener accepts only TLS connections.

## 9. Upgrade

1. Pull the new source.
2. Build the binary:

   ```
   cargo build --release
   ```

3. Replace the installed binary:

   ```
   cp target/release/agent-comms ~/.local/bin/agent-comms
   ```

4. Restart the service:

   ```
   launchctl kickstart -k gui/$(id -u)/local.agent-comms
   ```

5. Update the plugin: run `bun install` in the `plugin` directory.
6. Restart opencode.

## 10. Troubleshooting

- Read the log: `~/Library/Logs/agent-comms.log`. Use `tail -f` to follow it.
- Run `agent-comms config check`. It parses the config, validates it, and
  prints the effective settings.
- If the service does not start, run `agent-comms serve` in a terminal.
  The error shows on the screen.
- Error "secrets file ... is accessible by group or others": run
  `chmod 600` on the file.
- Error "secrets file ... not found": run `agent-comms install`.
- Error "TLS is required": set `[tls]` in `config.toml`, or set `bind` to a
  loopback address.
- The plugin cannot connect: check that the service runs, that `host` and
  `port` are correct, and that the `link-token` file is current.
- Log level: set `RUST_LOG=debug` in the service environment for more detail.
