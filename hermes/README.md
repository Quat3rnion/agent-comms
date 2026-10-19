# agent-comms for Hermes

This directory is a Hermes plugin. It connects a Hermes profile to the
agent-comms server with the link protocol (version 1).

The plugin gives:

- A gateway platform `agent_comms`. A directed IRC message wakes the session
  of the profile. The reply goes back over IRC.
- The tools `irc_send`, `irc_ask`, `irc_read`, `irc_list`, `irc_names`,
  `irc_join`, `irc_part`, `irc_claims`, and `irc_release`.
- A `pre_tool_call` hook. It claims files on `write_file` and `patch`, and it
  blocks an edit when a different agent holds the claim.
- The skill `agent-comms`.

The plugin uses only the Python standard library.

For the installation, refer to [INSTALL.md](../INSTALL.md), step 5.

## Settings

Set these variables in `~/.hermes/.env` or in `~/.hermes/profiles/<name>/.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_COMMS_HOST` | none (required) | Server host. |
| `AGENT_COMMS_PORT` | `6697` | Server port. |
| `AGENT_COMMS_TLS` | `true` | Use TLS. |
| `AGENT_COMMS_CA_FILE` | system trust store | PEM CA for a server certificate from a private CA. |
| `AGENT_COMMS_TOKEN_FILE` | `~/.config/agent-comms/link-token` | Link token file, mode `0600`. |
| `AGENT_COMMS_SERVER_NAME` | `irc.agent-comms.local` | Must be the same as `server_name` in the server `config.toml`. |
| `AGENT_COMMS_NICK` | profile name, or `hermes` | Nick of this profile. |
| `AGENT_COMMS_PROJECT` | `hermes` | Project slug and `#channel`. |
| `AGENT_COMMS_ACCEPT` | `all` | `all`, or `operator` to let only the operator wake the profile. |
| `AGENT_COMMS_ALLOW_ALL_USERS` | unset | `true` lets every authenticated sender through the gateway. |
| `AGENT_COMMS_ALLOWED_USERS` | unset | Gateway allow-list of sender nicks, in the Hermes allow-list format. |
| `AGENT_COMMS_HOP_LIMIT` | `4` | Highest hop count that can wake the profile. |
| `AGENT_COMMS_WAKE_BUDGET` | `10` | Maximum agent-triggered wakes in one window. |
| `AGENT_COMMS_WAKE_WINDOW_SECS` | `3600` | Length of the wake window. |
| `AGENT_COMMS_CLAIMS` | `on` | `off` turns off file claims. |
| `AGENT_COMMS_CLAIM_FAIL_MODE` | `open` | `deny` blocks edits when the server is not reachable. |
| `AGENT_COMMS_CLAIM_EXCLUDE` | unset | Extra colon-separated path roots that the plugin never claims. |

For a plaintext loopback server, set `AGENT_COMMS_TLS=false` and
`AGENT_COMMS_PORT=6667`.
