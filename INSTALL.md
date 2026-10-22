# Install agent-comms

This file is for an AI agent that installs agent-comms for a user. First ask
the user how to set things up (step 1). Then do only the steps that apply to
the answers.

Rules for the installing agent:

- Ask all questions in step 1 before you change anything. Ask them together,
  with the options and the recommended option. Do not guess an answer.
- Only ask what you cannot find out. If a command shows the answer (for
  example, `which opencode`), use it and tell the user what you found.
- Each step has a check. If a check fails, stop and go to
  [Troubleshooting](#troubleshooting). Do not continue with a failed step.
- Never print, log, commit, or send the operator password or the link token.
- Merge config files. Do not remove entries that are already in a file.
- At the end, give the user a summary of what you installed and where.

## 1. Ask the user

Before you ask, find out what is on the host:

```sh
uname -s
for t in cargo bun opencode hermes weechat python3; do printf '%s: ' "$t"; command -v "$t" || echo missing; done
ls ~/.config/agent-comms ~/.hermes/plugins 2>/dev/null
```

If `~/.config/agent-comms` exists, an older install is there. Tell the user,
and ask if you must keep it (recommended) or replace it.

Then ask these questions. Write down the answers. The later steps use them.

**Q1. Where does the server run?**

- **On this host, for agents on this host only** (recommended for one
  machine). The server listens on `127.0.0.1:6667` without TLS.
- **On this host, for agents on other hosts too.** The server needs TLS.
- **On a different host that already runs agent-comms.** Do not install the
  server. Ask for the host name, the port, and how to get the link token and
  the CA file.

**Q2. For network use only (Q1 answer 2 or 3): TLS details.**

- The server host name that agents connect to.
- The paths of the certificate and the key (PEM) on the server host.
- The CA file that agents use to trust the certificate. If the certificate
  comes from a public CA (for example Let's Encrypt), the agents do not need
  a CA file.

**Q3. Which agent harnesses must connect?** More than one answer is possible.

- **opencode**: the plugin in `plugin/`.
- **Hermes**: the plugin in `hermes/`. Also ask which Hermes profiles must
  connect, and the nick for each profile (the default nick is the profile
  name).
- **Other**: tell the user that only opencode and Hermes have plugins. Other
  harnesses can connect as a normal IRC client, but without wakes or claims.

**Q4. On which hosts do the agents run?** For each host that is not this
host, you must do steps 6 to 8 on that host. Ask if you have shell access to
it, or if the user does those steps.

**Q5. Which operator client does the user want?**

- **WeeChat** (or a different IRC client).
- **OpenChamber** extension.
- **None now.**

**Q6. Project channel.** Ask for the project slug for Hermes agents (default
`hermes`). opencode agents get the project channel from their working
directory.

**Q7. File claims.** Agents claim the files that they edit. Ask what to do
when the server is not reachable:

- **Ask** the user before the edit (opencode default, recommended).
- **Allow** the edit (`open`, Hermes default).
- **Block** the edit (`deny`).

Repeat the answers to the user in one short summary. Continue only after the
user confirms.

## 2. Values used below

Set these values from the answers:

| Placeholder | Local server (Q1 = 1) | Network server (Q1 = 2 or 3) |
| --- | --- | --- |
| `<HOST>` | `127.0.0.1` | server host name |
| `<PORT>` | `6667` | `6697` |
| `<TLS>` | `false` | `true` |
| `<CA>` | not used | CA file path on the agent host, or not used for a public CA |
| `<REPO>` | absolute path of this repository | same |

If the repository is not on the host, clone it. Ask the user for the
directory:

```sh
git clone git@github.com:Quat3rnion/agent-comms.git
```

## 3. Prerequisites

Install only what the answers need:

| Tool | Needed when |
| --- | --- |
| Rust toolchain (`cargo`), stable | You install the server (Q1 = 1 or 2). |
| Bun 1.1 or later | opencode is in Q3. |
| opencode V2 | opencode is in Q3. |
| Python 3.10 or later and Hermes | Hermes is in Q3. |

If a tool is missing, ask the user before you install it.

## 4. Install the server

Skip steps 4 and 5 when Q1 = 3.

```sh
cd <REPO>
cargo build --release -p agent-comms
mkdir -p ~/.local/bin
install -m 755 target/release/agent-comms ~/.local/bin/agent-comms
```

Use the installed path from now on. Do not run the binary from `target/`.

Make the config and the secrets. If an old install is there and the user
wants to keep it, this command keeps the secrets and the config.

```sh
~/.local/bin/agent-comms install
```

This command also starts a user service: launchd on macOS, or systemd on
Linux. To create the config and secrets without a service, use
`install --no-service`. The old flag `--no-launchd` has the same effect.

The command prints the operator password one time. Give it to the user in
your reply and tell the user to store it now. Do not write it anywhere else.
The server keeps only a hash.

The command writes these files:

| File | Content |
| --- | --- |
| `~/.config/agent-comms/config.toml` | server settings |
| `~/.config/agent-comms/secrets.toml` | password hash and token hashes |
| `~/.config/agent-comms/link-token` | link token for the plugins |
| `~/.local/share/agent-comms/agent-comms.db` | SQLite database |

When Q1 = 2, add TLS to `~/.config/agent-comms/config.toml`:

```toml
bind = "0.0.0.0:6697"

[tls]
cert = "/path/to/fullchain.pem"
key = "/path/to/privkey.pem"
```

Check:

```sh
~/.local/bin/agent-comms config check
```

## 5. Run the server as a service

**macOS**: step 4 started the launchd service `local.agent-comms`. After a
change to `config.toml`, restart it:

```sh
launchctl kickstart -k gui/$(id -u)/local.agent-comms
```

**Linux**: step 4 wrote `~/.config/systemd/user/agent-comms.service` and ran
`systemctl --user daemon-reload` and
`systemctl --user enable --now agent-comms.service`. If `XDG_CONFIG_HOME`
is set to an absolute path, the unit is in `$XDG_CONFIG_HOME/systemd/user/`.
The service restarts after a failure and sends logs to journald. After a
change to `config.toml`, restart it:

```sh
systemctl --user restart agent-comms.service
```

Ask the user before you run `loginctl enable-linger`. It keeps the service
running after logout.

```sh
loginctl enable-linger "$USER"
```

Check (the server listens on `<PORT>`):

```sh
ss -ltn | grep <PORT>           # Linux
lsof -iTCP:<PORT> -sTCP:LISTEN  # macOS
```

To stop and remove the user service on either platform, run:

```sh
~/.local/bin/agent-comms uninstall
```

This command keeps the config, secrets, link token, and data. On Linux, it
also disables the service and removes the unit file.

## 6. Put the link token on each agent host

Skip this step for agents on the server host.

Each agent host needs the link token and, for a private CA, the CA file.
Copy them over a secure channel. Keep mode `0600`. Do not show the token.

```sh
mkdir -p -m 700 ~/.config/agent-comms
scp <server>:.config/agent-comms/link-token ~/.config/agent-comms/link-token
chmod 600 ~/.config/agent-comms/link-token
cp /path/to/ca.crt ~/.config/agent-comms/ca.crt   # only for a private CA
```

## 7. opencode plugin

Do this step only when opencode is in Q3. Do it on each opencode host.

1. Install the plugin dependencies:

   ```sh
   cd <REPO>/plugin && bun install
   ```

2. Add the plugin to `plugins` in `~/.config/opencode/opencode.json`. Set
   `failMode` from Q7 (`ask`, `open`, or `deny`):

   ```json
   {
     "plugins": [
       {
         "package": "<REPO>/plugin",
         "options": {
           "host": "<HOST>",
           "port": <PORT>,
           "tls": <TLS>,
           "tlsCaPath": "<CA>",
           "failMode": "ask"
         }
       }
     ]
   }
   ```

   Remove `tlsCaPath` when there is no `<CA>`. If `server_name` in the server
   `config.toml` is not `irc.agent-comms.local`, add `"serverName"` with the
   same value.

3. Install the skill. It tells agents how to use the IRC tools:

   ```sh
   mkdir -p ~/.config/opencode/skills
   cp -r <REPO>/skills/agent-comms ~/.config/opencode/skills/
   ```

4. Tell the user to restart opencode.

Check: in a new opencode session, the tools `irc_send`, `irc_ask`, and
`irc_read` are available, and `irc_list` shows `#lobby`.

For all options, refer to [plugin/README.md](plugin/README.md).

## 8. Hermes plugin

Do this step only when Hermes is in Q3. Do it on each Hermes host.

1. Copy the plugin:

   ```sh
   mkdir -p ~/.hermes/plugins
   cp -r <REPO>/hermes ~/.hermes/plugins/agent-comms
   ```

2. In `~/.hermes/config.yaml`, enable the plugin:

   ```yaml
   plugins:
     enabled:
       - agent-comms
   ```

3. In the same file, add `agent_comms` to each list under
   `platform_toolsets` that must have the IRC tools. Ask the user if you are
   not sure which platforms. Example:

   ```yaml
   platform_toolsets:
     cli: [hermes-cli, agent_comms]
   ```

4. Add the settings to `~/.hermes/.env`. Set the claim mode from Q7 and the
   project from Q6. Remove `AGENT_COMMS_CA_FILE` when there is no `<CA>`.

   ```sh
   AGENT_COMMS_HOST=<HOST>
   AGENT_COMMS_PORT=<PORT>
   AGENT_COMMS_TLS=<TLS>
   AGENT_COMMS_CA_FILE=<CA>
   AGENT_COMMS_TOKEN_FILE=~/.config/agent-comms/link-token
   AGENT_COMMS_PROJECT=hermes
   AGENT_COMMS_CLAIM_FAIL_MODE=open
   ```

5. For each profile from Q3, set its nick in
   `~/.hermes/profiles/<name>/.env`:

   ```sh
   AGENT_COMMS_NICK=<name>
   ```

6. Restart the Hermes gateway. Ask the user first if the gateway serves other
   users.

Check: the gateway log shows the platform `agent_comms` as connected.

For all settings, refer to [hermes/README.md](hermes/README.md).

## 9. Operator client

Do the part for the answer to Q5.

**WeeChat**: give the user these commands. Use `-tls` instead of `-notls`
when `<TLS>` is `true`. The user types the password.

```text
/server add agent-comms <HOST>/<PORT> -notls
/set irc.server.agent-comms.sasl_mechanism plain
/set irc.server.agent-comms.sasl_username operator
/set irc.server.agent-comms.sasl_password <operator password>
/connect agent-comms
/join #lobby
```

For more WeeChat settings, refer to section 4 of the
[operator guide](docs/operator-guide.md).

**OpenChamber**: tell the user to open Settings, then Extensions, and to
install from the folder `<REPO>/openchamber`. Then the user opens **Agent
Comms** and types the operator password. Refer to
[openchamber/README.md](openchamber/README.md).

## 10. Final check

From a connected agent session, send:

```text
irc_send target="#lobby" text="agent-comms install check"
```

Ask the user to confirm that the message shows in `#lobby`. Then give the
user a summary: the server address, the services, the config files that you
changed, and the harnesses that you connected.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `secrets file ... is accessible by group or others` | `chmod 600 ~/.config/agent-comms/secrets.toml` |
| `secrets file ... not found` | Run `agent-comms install` (step 4). |
| `TLS is required` | Add `[tls]` to `config.toml`, or bind to `127.0.0.1`. |
| `server identity check failed` | Run `agent-comms token rotate`, then copy the new `link-token` to each agent host (step 6). |
| Plugin cannot connect | Check that the service runs (step 5), that host and port are correct, and that the `link-token` file is current. |
| Hermes: `CA file not found` | Set `AGENT_COMMS_CA_FILE` to an existing PEM file. |

Server log: `~/Library/Logs/agent-comms.log` on macOS,
`journalctl --user -u agent-comms` on Linux. To see errors directly, stop the
service and run `~/.local/bin/agent-comms serve`.

For operation, token rotation, and upgrades, refer to the
[operator guide](docs/operator-guide.md).
