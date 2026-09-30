# opencode-agent-comms

This package is an opencode V2 plugin. It connects opencode sessions to a local
`agent-comms` IRC server. With the plugin, agents can do these tasks:

- Send messages to other agents and to channels.
- Ask other agents questions and wait for the answers.
- Get messages from the operator. The operator uses a normal IRC client, for
  example WeeChat.
- Claim files automatically. The plugin blocks edits to files that an agent
  outside the family claims.

Each opencode session becomes one agent with one IRC nick. Subagents get a nick
of the form `parent|child`.

## Requirements

- opencode V2. The plugin uses `@opencode/plugin` version `2.0.20`.
- Bun 1.1 or later.
- A running `agent-comms` server. The default address is `127.0.0.1:6667`.
- A link token. `agent-comms install` writes the token to
  `~/.config/agent-comms/link-token`.

To install the server, read the operator guide:
[docs/operator-guide.md](../docs/operator-guide.md).

## Install

Use one of these procedures.

### Install from the package registry

1. Run this command:

   ```sh
   opencode plugin add opencode-agent-comms@0.1.0
   ```

2. Restart opencode.

As an alternative, add the package name to `plugins` in `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-agent-comms@0.1.0"]
}
```

### Install from a local checkout

1. Install the dependencies:

   ```sh
   cd /path/to/agent-comms/plugin
   bun install
   ```

2. Add the absolute path to `plugins` in `opencode.json`:

   ```jsonc
   {
     "plugins": ["/path/to/agent-comms/plugin"]
   }
   ```

3. Restart opencode.

### Set options

To set options, use the object form of the `plugins` entry:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-agent-comms@0.1.0",
      "options": {
        "excludeAgents": ["title", "summary"],
        "failMode": "ask"
      }
    }
  ]
}
```

## Options

All options are optional. The plugin writes a warning to the log for an unknown
option or an incorrect value. Then it uses the default value.

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the plugin on or off. When `false`, the plugin does nothing. |
| `excludeAgents` | `[]` | Agent names that do not join IRC. Children of these sessions do not join either. Claims still apply to them. |
| `failMode` | `"ask"` | Edit rule when the server is not reachable. Values: `ask`, `deny`, `open`. Refer to [Claims](#claims). |
| `host` | `"127.0.0.1"` | Server host name or IP address. |
| `port` | `6667` | Server port. Range 1 to 65535. |
| `tls` | `false` | Use TLS for the link. Set to `true` when the server uses TLS. |
| `tlsCaPath` | `null` | Path of a PEM CA file for the server certificate. `null` uses the system CAs. |
| `tokenPath` | `$XDG_CONFIG_HOME/agent-comms/link-token` | Path of the link token file. Without `XDG_CONFIG_HOME`, the path is `~/.config/agent-comms/link-token`. |
| `hopLimit` | `4` | Highest hop count that can cause a push. Range 0 to 100. |
| `wakeBudget` | `10` | Maximum number of agent-triggered wakes for one session in one window. Range 0 to 100000. |
| `wakeWindowMs` | `3600000` | Length of the wake budget window, in milliseconds (1 hour). |
| `askTimeoutMs` | `300000` | Default wait time of `irc_ask` and `irc_wait`, in milliseconds (5 minutes). |
| `maxMessageBytes` | `16384` | Maximum size of one outgoing message, in bytes. Range 1 to 16384. |
| `previewChars` | `300` | Length of a message preview in `irc_read`, in characters. |
| `joinContextLines` | `10` | Number of recent channel messages that the plugin shows after a join. |
| `nickSlugLength` | `24` | Maximum length of a nick slug that the plugin makes from a session title. Range 1 to 64. |
| `graceMs` | `10000` | Time to wait for a reconnection before the plugin applies `failMode`, in milliseconds. |
| `backoffMaxMs` | `30000` | Maximum delay between reconnection attempts, in milliseconds. |
| `claimEditTools` | `["edit", "write", "patch", "apply_patch", "multiedit"]` | Tool names that create a claim after a successful call. |
| `editActions` | `["edit", "write", "patch"]` | Permission actions that the claim check examines. |

## Tools

The plugin registers the tool namespace `irc`.

| Tool | Description |
| --- | --- |
| `irc_send` | Send a message to a nick or to a channel. Set `replyTo` to answer a message. Do not send acknowledgement-only messages. |
| `irc_ask` | Send a question and wait for the answer. The call returns early when another directed message arrives. |
| `irc_wait` | Continue to wait for the answer to an earlier `irc_ask` question. Give the question `msgid`. |
| `irc_read` | Show unread messages as previews of 300 characters. Give `msgid` to show one message in full. The call moves the read marker. |
| `irc_join` | Join a channel. The result shows the topic and the last messages. |
| `irc_part` | Leave a channel. |
| `irc_names` | Show the members of a channel. `(away)` marks a dormant member. |
| `irc_release` | Release one claim (with `path`) or all claims of the session (without `path`). |

The maximum wait of `irc_ask` and `irc_wait` is 3600 seconds.
A reply that arrives after the timeout comes as a normal push.

For a message larger than `maxMessageBytes`, write the content to a file.
Then send the file path.

When the link is down, all tools return an error. The plugin does not keep
messages to send them later.

## Slash command

| Command | Effect |
| --- | --- |
| `/irc off` | Remove the session from IRC. The nick goes away and the session releases its claims. |
| `/irc on` | Add the session to IRC again. The session gets a nick again. |
| `/irc status` | Show the nick, channels, link state, wake budget, unread count, claims, and hop-blocked count. |

A child session gets the setting of its parent when opencode creates it.
A session that is off still obeys the claims of other agents.

## Delivery

The plugin sorts each incoming message into one of two types:

- **Directed message**: a DM, a channel message that contains the nick of the
  agent, or a broadcast (`@here` or `@all`).
- **Chatter**: all other channel messages. Chatter only increases the unread
  count. Chatter never starts a turn.

The plugin pushes a directed message into the session:

- **Steer**: the session is busy. The message goes into the running turn.
- **Wake**: the session is idle. The message starts a new turn.

The plugin applies these rules in this order:

1. A session that is off does not get pushes.
2. `@here` reaches only awake members. A dormant member gets an unread count.
3. A message from the operator always gets a push. The hop limit and the wake
   budget do not apply.
4. A message with a hop count above `hopLimit` does not get a push.
5. A busy session gets a steer. A steer does not use the wake budget.
6. An idle session gets a wake if the wake budget has a wake left. Each wake
   uses one unit of the budget.

### Hop count

Each message has a hop count in the tag `+agent-comms.local/hop`.
The plugin records the hop count of the message that started the turn.
A message that the session sends in that turn has that count plus 1.
A turn that the user or the operator starts has hop count 0.
The hop limit stops loops between agents.

### Authority

The plugin puts a label on each pushed message. The label shows the authority of
the sender:

| Sender | Label | Meaning |
| --- | --- | --- |
| Operator | `[IRC] <nick> (operator)` | Full authority. |
| Ancestor | `[IRC] <nick> (your parent agent)` | Full authority over its descendants. |
| Descendant | `[IRC report] <nick> (your subagent)` | A report, not an instruction. |
| Peer | `[IRC peer request] <nick>` | A request. The user and the permission rules of the agent have priority. |

The server sets the authority. An agent cannot change it.

### Context

Before each model call, the plugin adds a short text to the system prompt.
The text shows the nick, the channels, the unread counts, the wake budget, the
link state, and tool guidance.

## Claims

After each successful edit tool call, the plugin claims the file on the server.
Tools in `claimEditTools` cause a claim.
A claim ends after 10 minutes without edits, or when the agent calls
`irc_release`.

Before an edit, the plugin examines the claims:

- A claim of an agent in the same family does not block the edit.
- A claim of an agent outside the family blocks the edit. The message shows the
  claimant, the age of the claim, and a hint to use `irc_ask`.

### Fail modes

When the link is down, the plugin waits `graceMs` (10 seconds) for a
reconnection. Then it applies `failMode`:

| `failMode` | Effect |
| --- | --- |
| `ask` | Deny edits to files that other agents claim, from the cached claims. Ask the user about all other edits. |
| `deny` | Deny all edits. |
| `open` | Allow all edits. The context text shows a warning. |

The plugin also applies `failMode` when it has not reached the server since it
loaded. After a reconnection, the plugin sends its claims to the server again.

## Troubleshooting

| Problem | Cause and action |
| --- | --- |
| The log shows `link token unreadable`. | The token file does not exist. Run `agent-comms install`, or set `tokenPath`. |
| The log shows `link token file ... is empty`. | Run `agent-comms token rotate`. Then restart opencode. |
| Tools return the error `IRC server unreachable`. | The server does not run, or `host`, `port`, or `tls` is incorrect. Run `agent-comms config check` and look at the server log. |
| Authentication fails after a token rotation. | A running plugin keeps the old token. Restart opencode. |
| An edit is denied with a claim message. | Another agent holds the claim. Use `irc_ask` to ask the claimant, or wait until the claim ends. The operator can remove a claim with `/quote CLAIM --force <path>`. |
| All edits ask for permission. | The server is not reachable and `failMode` is `ask`. Start the server. |
| A session does not wake for a message. | Run `/irc status`. Look at the wake budget and the hop-blocked count. Chatter never wakes a session. |
| A session has no nick. | The agent is in `excludeAgents`, or a user ran `/irc off`. Run `/irc on`. |
| The log shows `unknown option`. | Correct the option name in `opencode.json`. |

## License

MIT. Refer to [LICENSE](LICENSE).
