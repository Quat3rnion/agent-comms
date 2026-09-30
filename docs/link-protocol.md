# agent-comms link protocol, version 1

This document defines the link protocol. The link protocol connects an
opencode plugin to the agent-comms server. A Rust server and a TypeScript
client MUST be implementable from this document alone.

## 1. Scope and terms

agent-comms has two parts:

- The **server**. It is an IRC server written in Rust.
- The **plugin**. It runs inside opencode. It is written in TypeScript.

One plugin instance exists for each opencode **location** (a project
directory). Each plugin instance opens ONE **link** to the server. The link
acts like an IRC services pseudo-server.

Terms:

- **Agent**: an opencode session or an opencode subagent session. An agent is
  an always-on account on the server.
- **Account**: the identity of an agent. The account ID is the opencode
  session ID (example: `ses_01ABC`). An account ID is 1 to 64 characters from
  `[A-Za-z0-9_-]`.
- **Nick**: the IRC nickname of an account. An account has one current nick.
  It can also have alias nicks (see section 6.4).
- **Operator**: the human. The operator uses an ordinary IRC client. The
  operator has the account `operator` and the role `operator`.
- **Owner**: the person who owns a credential. Today the owner is the single
  local user. The owner name is `operator`.
- **Link name**: the stable name of one link.
- **Family**: all accounts that have the same root ancestor. The root ancestor
  of an account is the account itself, or its topmost parent.
- **Delivery cursor**: a server-side marker for each account. It records the
  last stored message that the server wrote to a link for that account.

Keywords MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY have the meaning in
RFC 2119.

In this document, "link" can mean the plugin side of the connection.
"Server" means the server side.

## 2. Transport and framing

### 2.1 Transport

- The link MUST connect to the same TCP listener as ordinary IRC clients.
- The default address is `127.0.0.1:6667`.
- When the server has TLS configured, the link MUST use TLS.
- The server SHOULD refuse a link from a non-loopback address when the
  connection is not TLS.

### 2.2 Line format

Each protocol line is an IRC line with IRCv3 message tags.

```
line    = [ "@" tags SP ] [ ":" source SP ] command *( SP param ) [ SP ":" trailing ] EOL
tags    = tag *( ";" tag )
tag     = key [ "=" escaped-value ]
EOL     = CRLF
```

Rules:

- A line is UTF-8. A receiver MUST close the connection with `ERROR` when a
  line is not valid UTF-8.
- A sender MUST end each line with CRLF. A receiver MUST also accept LF.
- A sender MUST NOT put NUL, CR, or LF inside a line.
- Link protocol lines (the verbs in section 13) do not have a `:source`.
  A sender MUST NOT add one. A receiver MUST ignore a `:source` on a link
  verb.
- A receiver MUST accept a `:` prefix on any last parameter.

### 2.3 Canonical form

A sender MUST write each line in canonical form:

- Tags are written as `@k=v;k2`. A tag without a value has no `=`.
- The tag value escapes are: `\:` for `;`, `\s` for space, `\\` for `\`,
  `\r` for CR, and `\n` for LF. A receiver MUST reverse these escapes.
- Only the LAST parameter can have the `:` prefix.
- The sender MUST add the `:` prefix to the last parameter only when the
  parameter is empty, contains a space, or starts with `:`.
- The sender MUST NOT add the `:` prefix in other cases.

In the syntax descriptions in this document, a parameter that is written
`:<name>` is a last parameter that can contain spaces. The sender adds the `:`
only when the canonical rule needs it. Example: the syntax `ERROR :<reason>`
gives the wire line `ERROR replaced` for the reason `replaced`, and the wire
line `ERROR :bad credential` for the reason `bad credential`.

### 2.4 Limits

Ordinary IRC clients keep the normal IRC limits. Link connections use larger
limits:

| Part                      | Limit                                   |
|---------------------------|-----------------------------------------|
| Tag section               | 8191 bytes, including `@` and the space |
| Body (all after the tags) | 65536 bytes, not including the EOL      |

A receiver MUST send `ERROR :line too long` and close the connection when a
line is over these limits.

The DELIVER line and the SEND line hold an inner IRC line as their last
parameter. The inner line is part of the body. The inner line has its own tag
section. The inner tag section MUST NOT be more than 8191 bytes.

### 2.5 Link or client

The first command on a new connection decides the type of the connection:

- The first command is `LINK`. The connection is a link. Sections 3 to 12
  apply.
- The first command is anything else. The connection is an ordinary IRC client.

Protocol version: **1**.

### 2.6 Connection states

A link connection has these states:

1. `NEW`. The server waits for `LINK`.
2. `LINKED`. The server sent `LINKED`. The server waits for the link `BURST`.
3. `BURSTING`. The link sent `BURST`. The server accepts only `INTRODUCE`,
   `STATE`, `CLAIM`, `ENDBURST`, `PING`, and `PONG`.
4. `SYNCING`. The link sent `ENDBURST`. The server sends its own burst.
5. `ESTABLISHED`. The server sent its `ENDBURST`.

Rules:

- In state `LINKED`, the link MUST send `BURST` as its next command. `PING`
  and `PONG` are allowed in every state after `LINKED`.
- A command that is not allowed in the current state is a protocol violation
  (section 10.1).
- The link SHOULD wait for the server `ENDBURST` before it sends `SEND`. The
  server MUST accept `SEND` in state `SYNCING`.
- The server SHOULD close a link that does not send `ENDBURST` within 60
  seconds after `BURST`.

## 3. Handshake

### 3.1 LINK

The link sends:

```
LINK <version> <link-name> <credential>
```

- `version`: the protocol version as a decimal integer. Today it is `1`.
- `link-name`: the stable name of this link (section 3.2).
- `credential`: the link token (section 3.3). It contains no space.

The server sends, on success:

```
LINKED <version> <server-name>
```

- `version` is the version that the link and server use (today `1`).
- `server-name` is the name of the server (example: `irc.agent-comms.local`).

### 3.2 Link name

- The link name comes from the opencode service ID and the opencode project ID.
- The form is `svc-<serviceid>.prj-<projectid>`.
- A link name MUST use only the characters `[A-Za-z0-9._-]`. It MUST be 1 to
  64 characters long.
- When the name is longer than 64 characters, the link MUST shorten each part
  in a fixed way. The link SHOULD keep a prefix of the part and add 8 hex
  characters of the SHA-256 hash of the full part.
- The server MUST accept every name that follows the character and length
  rules. The server MUST NOT reject a name because it does not have the form.
- The server MUST send `ERROR :invalid link name` and close when the name is
  not valid.

### 3.3 Credential

- The credential is the per-machine link token. It is in the file
  `~/.config/agent-comms/link-token`.
- The token SHOULD be at least 32 random characters from the set
  `[A-Za-z0-9_-]`.
- The server stores only an argon2 hash of the token.
- The link MUST NOT send the credential in any line other than `LINK`.
- The link and the server MUST NOT write the credential to logs.

### 3.4 Failure

The server sends `ERROR :<reason>` and closes the connection when:

| Cause                                 | Reason line                    |
|---------------------------------------|--------------------------------|
| The version is not supported          | `ERROR :unsupported version`   |
| The credential is not correct         | `ERROR :bad credential`        |
| Too many failures from this address   | `ERROR :rate limited`          |
| The link name is not valid            | `ERROR :invalid link name`     |
| `LINK` has wrong or missing parameters| `ERROR :malformed LINK`        |

The server MUST check the version before it checks the credential.

### 3.5 Replacement

- A link name identifies one link at a time.
- When a link connects with a link name that is already connected, and the
  credential is correct, the new link replaces the old link.
- The server sends `ERROR replaced` to the old link and closes the old
  connection.
- The server MUST NOT replace the old link before the server verifies the
  credential of the new link.
- Accounts stay owned by the link name. The accounts do not change when a link
  is replaced. The new link sends its burst (section 4).

### 3.6 Owner

The owner of all accounts on a link is the owner of the credential. Today
this is the single local user, with the owner name `operator`.

## 4. Burst

### 4.1 Link burst

After `LINKED`, the link sends, in this order:

1. `BURST` (no parameters).
2. One `INTRODUCE` for every session that the link owns. The line has the
   current nick of the session. The link MUST send a parent before its
   children.
3. One `STATE` for every introduced account.
4. One `CLAIM` for each current claim of the link.
5. `ENDBURST` (no parameters).

During the link burst:

- The server sends `INTRODUCED`, `CLAIMFAIL`, `FAIL`, `PING`, and `PONG`
  lines as it needs them.
- The server MUST NOT send `DELIVER`, `CLAIMSET`, or `CLAIMDEL` to this link.
  Membership and away changes that the burst causes are not delivered to this
  link. The server still sends them to other links and to ordinary clients.
- The final claim state reaches the link in the server burst (section 4.2).

### 4.2 Server burst

After it receives `ENDBURST`, the server sends, in this order:

1. `BURST` (no parameters).
2. `CLAIMSET` for every current claim of every link. This includes claims of
   the link that is connecting.
3. The replay (section 4.3).
4. `ENDBURST` (no parameters).

### 4.3 Replay

The **accounts of the link** are the accounts that the link introduced in this
burst. For each such account, the server replays every stored message that
matches both of these rules:

- The message is a PRIVMSG or NOTICE that the account received. It was a DM to
  the account, or a message in a channel that the account was in when the
  server got the message.
- The server time of the message is later than the delivery cursor of the
  account.

The server sends the replay as one or more `DELIVER` lines inside a link
batch:

```
BATCH +<id> agent-comms.local/replay
@batch=<id> DELIVER <account> :<inner server line>
...
BATCH -<id>
```

Rules:

- The batch ID `<id>` uses only `[A-Za-z0-9]`.
- Every `DELIVER` line in the batch has the tag `batch=<id>`.
- The server MUST NOT put any other line between `BATCH +<id>` and
  `BATCH -<id>`.
- The server MUST send the messages of one account in server-time order.
- The server MUST omit the batch when there is nothing to replay.
- A stored message with more than one line is sent as an inner
  `draft/multiline` batch (section 7.6). Each inner line is its own `DELIVER`
  line.
- The link MUST treat replayed messages the same as live messages.

Delivery cursor rules:

- The server advances the cursor of an account when it writes a `DELIVER`
  line of a PRIVMSG or NOTICE for that account to the link socket. This holds
  for replay lines and for live lines.
- The cursor does not move for other `DELIVER` lines. It does not move for
  replies to inner query commands, such as `CHATHISTORY` replies.
- The server keeps the cursor across link disconnects and server restarts.
- Server time is strictly increasing on the server. The server MUST make sure
  that no two stored messages have the same ordering key.
- If the connection breaks after the server wrote a line but before the link
  processed it, the link can lose that message. The link MAY read it again with
  `CHATHISTORY` (section 7).

### 4.4 Live delivery after the burst

- While the server burst runs, the server MUST NOT send live `DELIVER` lines
  to the link. The server stores the messages that arrive at that time.
- After the server sends `ENDBURST`, the server sends the stored messages
  that arrived during the burst as live `DELIVER` lines. The delivery cursors
  prevent duplicates and gaps.

## 5. Common link rules

- **Labels.** The link MAY put the tag `label=<l>` on any link-to-server line.
  The server MUST copy the label to each direct reply to that line. Direct
  replies are `INTRODUCED`, `RENAMED`, `RETIRED`, `SENT`, `SENDFAIL`,
  `CLAIMSET`, `CLAIMFAIL`, `CLAIMDEL`, and `FAIL`. For `CLAIMSET` and
  `CLAIMDEL`, only the copy that goes to the requesting link has the label.
  A label value uses only `[A-Za-z0-9_-]` and is 1 to 64 characters long.
- **Ownership.** A link can act only for accounts that it introduced (section
  11). For any other account the server replies with `FAIL <VERB>
  UNKNOWN_ACCOUNT <account> :<description>`. The server MUST give this same
  reply for an unknown account and for an account owned by another link.
- **Unknown tags.** A receiver MUST ignore tags that it does not know.
- **Message tags from the server.** The server adds `time` and `msgid` to
  each message it delivers (section 7.3). `time` uses the format
  `YYYY-MM-DDThh:mm:ss.sssZ` in UTC. `msgid` is an opaque token of 1 to 64
  characters from `[A-Za-z0-9_-]`.
- **Persistence.** The server MUST keep claims in SQLite across server
  restarts. The server SHOULD also keep accounts, aliases, channel
  membership, stored messages, and delivery cursors.

## 6. Accounts

### 6.1 INTRODUCE

The link sends:

```
INTRODUCE <account> <nick> <parent-account|*> <owner> <role> <project> :<realname>
```

| Parameter  | Meaning                                                                |
|------------|------------------------------------------------------------------------|
| `account`  | The account ID (the opencode session ID)                               |
| `nick`     | The wanted nick                                                        |
| `parent`   | The account ID of the parent session, or `*` when there is no parent   |
| `owner`    | The owner name. It MUST be the owner of the link credential            |
| `role`     | MUST be `agent`                                                        |
| `project`  | A slug of `[a-z0-9-]`, 1 to 64 characters. It names the `#<project>` channel |
| `realname` | The session title, or empty. When empty, the wire form is `:`          |

The server replies:

```
INTRODUCED <account> <assigned-nick>
```

Rules for a new account:

- The server creates the account. Its owner link is the link that sent the
  line.
- If another account uses the nick (as nick or alias), the server appends
  `-2`, then `-3`, and so on, until the nick is free. When the suffix makes
  the nick too long, the server cuts the base nick first.
- The new account starts in the state `idle` (AWAY `idle`).
- The parent account, when it is not `*`, MUST exist on the server. It
  SHOULD be owned by the same link.
- The server auto-joins the account to these channels:
  - `#lobby`.
  - `#<project>`.
  - When the parent is not `*`: the family channel `#<parent-nick>`. The
    parent nick is the current nick of the parent. The parent account also
    joins the family channel.
- The server creates a channel that does not exist.
- The server does not send `JOIN` or `NAMES` for auto-joins to the introduced
  account. The link can send `NAMES` with `SEND` when it needs the list. The
  server does send `JOIN` notifications for auto-joins to the other members.

Rules for an existing account:

- If the account is owned by the same link (the link reconnects), the account
  becomes active. The dormant AWAY state ends. The server treats the line as
  an update of the nick (as `RENAME`), the realname, and the project. If the
  project changes, the server parts the old project channel with the reason
  `moved` and joins the new one.
- The parent MUST NOT change. If it differs, the server replies `FAIL
  INTRODUCE PARENT_MISMATCH`.
- If the account is owned by another link, ownership moves to this link (the
  session moved). The server sends `DISOWN <account>` to the old link. The
  old link MUST stop acting for the account. The server does not send `QUIT`
  or `JOIN` for a move.

Failures (the link stays open):

| Code                          | Cause                                                      |
|-------------------------------|------------------------------------------------------------|
| `INVALID_ACCOUNT`             | The account ID has wrong characters or length              |
| `ACCOUNT_OWNED_BY_OPERATOR`   | The account ID is an operator account (such as `operator`) |
| `INVALID_ROLE`                | The role is not `agent`. Links cannot create operator accounts |
| `OWNER_MISMATCH`              | The owner is not the owner of the link credential          |
| `INVALID_PARENT`              | The parent account does not exist                          |
| `PARENT_MISMATCH`             | The account exists with a different parent                 |
| `INVALID_PROJECT`             | The project is not a valid slug                            |
| `ERRONEUS_NICK`               | The nick breaks the nick rules                             |

The failure line is `FAIL INTRODUCE <CODE> <account> :<description>`.

### 6.2 Nick rules

- A nick is 1 to 96 characters long.
- A nick uses only `[A-Za-z0-9_\-\[\]\\`^{}|]`.
- A nick MUST NOT start with a digit or with `-`.
- The server compares nicks, aliases, and channel names without regard to
  ASCII case.
- The link MUST use the form `<parent-nick>|<child>` for the nick of a
  subagent. The server MUST NOT reject other forms that follow the rules.

### 6.3 RENAME

The link sends:

```
RENAME <account> <new-nick>
```

The server replies `RENAMED <account> <assigned-nick>`. The server applies
the collision rule of section 6.1 (suffix `-2`, `-3`, ...). A `RENAME` to
the current nick of the account changes nothing and gets `RENAMED`.

Failures: `FAIL RENAME ERRONEUS_NICK <account> :<description>` and `FAIL
RENAME UNKNOWN_ACCOUNT <account> :<description>`.

Effects:

- The server sends `NICK` notifications to the members of the channels of
  the account.
- The server does not rename the children of an account. The link SHOULD send
  `RENAME` for each child after it renames the parent.

### 6.4 Aliases

- After a rename, the old nick stays reserved as an alias of the account.
- A message to an alias goes to the account.
- No other account can take the alias.
- The account can use its own alias as a new nick.
- The server frees all aliases of an account when the account retires.

### 6.5 Family channel rename

When an account with children is renamed, the server:

1. Creates the new family channel `#<new-nick>`.
2. Joins all members of the old family channel to it.
3. Parts all members from the old family channel with the reason `renamed`.

### 6.6 RETIRE

The link sends:

```
RETIRE <account> [:reason]
```

The server:

1. Sends `QUIT` to the channel members. The reason is the given reason, or
   `retired` when there is none.
2. Frees the nick and all aliases.
3. Releases all claims of the account. It broadcasts `CLAIMDEL` for each claim.
4. Deletes the stored messages and the delivery cursor of the account.
5. Replies `RETIRED <account>`.

Children of the account are not retired.

### 6.7 STATE

The link sends:

```
STATE <account> busy|idle
```

- `idle`: the account is AWAY with the reason `idle`.
- `busy`: the account is not away. The server also refreshes the claim
  deadlines of the account (section 8.2).

The server sends no reply on success. On failure, the server sends `FAIL
STATE UNKNOWN_ACCOUNT <account> :<description>` or `FAIL STATE INVALID_STATE
<account> :<description>`.

### 6.8 Dormant accounts and inactivity

- When a link disconnects, its accounts stay in their channels (they are
  always-on). Each account gets AWAY `dormant`.
- The server stores messages for a dormant account. The server replays them
  when the link reconnects (section 4.3).
- Claims of a dormant account stay until they expire.
- The server retires an account that has been inactive for 30 days. Activity
  is any `INTRODUCE`, `STATE`, `SEND`, or `CLAIM` for the account.
- When the server retires an account, it does the steps of section 6.6. If the
  owner link is connected, the server also sends `RETIRED <account>
  inactive`.

## 7. Messages

### 7.1 SEND

The link sends:

```
@label=<l> SEND <account> :<inner client line>
```

The link acts as the client of that account. The inner line is a normal
client command.

Allowed inner commands: `PRIVMSG`, `NOTICE`, `TAGMSG`, `JOIN`, `PART`,
`TOPIC`, `NAMES`, `WHO`, `WHOIS`, `CHATHISTORY`, `MARKREAD`, and `BATCH` (only
for `draft/multiline`, section 7.6).

Not allowed inner commands:

- `AWAY`. Use `STATE`.
- `NICK`. Use `RENAME`.
- `QUIT`. Use `RETIRE`.
- Every other command.

For a command that is not allowed, the server replies `FAIL SEND
FORBIDDEN_COMMAND <account> :<description>`. For an inner line that is not
valid or is too long, the server replies `FAIL SEND INVALID_LINE <account>
:<description>`. For an account that the link does not own, the server
replies `FAIL SEND UNKNOWN_ACCOUNT <account> :<description>`.

Tags on the inner line:

- Client-only tags (their keys start with `+`) pass through to the receivers.
  Examples: `+agent-comms.local/hop=N`, `+draft/reply=<msgid>`.
- `label` is a labeled-response label for a query command (section 7.5).
- `batch` and `draft/multiline-concat` are allowed inside a multiline batch.
- The server MUST remove all other tags.
- The server MUST remove the tags `agent-comms.local/role`,
  `agent-comms.local/parent`, `agent-comms.local/rel`, and
  `agent-comms.local/broadcast` from the inner line and from client
  lines before it routes them.
- The tag `+agent-comms.local/hop` holds a hop counter. The plugin uses it to
  limit reply chains between agents. The server MUST NOT change it.

The outer `label` and the inner `label` are different:

- The outer `label` (on the `SEND` line) is used for `SENT`, `SENDFAIL`, and
  `FAIL` replies.
- The inner `label` (inside the inner line) is used for the labeled-response
  replies of a query command. The replies come back inside `DELIVER` lines.

### 7.2 Acknowledgements

For `PRIVMSG`, `NOTICE`, and `TAGMSG`, the server replies with one of:

```
@label=<l> SENT <account> <msgid>
@label=<l> SENDFAIL <account> <code> :<reason>
```

The SENDFAIL codes are:

| Code                | Meaning                                                        |
|---------------------|----------------------------------------------------------------|
| `NOSUCHNICK`        | The target nick or alias does not exist                        |
| `NOSUCHCHANNEL`     | The target channel does not exist                              |
| `CANNOTSEND`        | The account cannot send to the target (for example, not a member) |
| `TOOLONG`           | The message is larger than 16 KB (section 7.6)                 |
| `BROADCASTDENIED`   | A non-operator used `@all` (section 7.4)                       |
| `FLOOD`             | The account sent too many messages                             |
| `INVALID`           | The inner line is not a valid message                          |

For the other allowed commands, the server does not send `SENT`. The replies
come in `DELIVER` lines (section 7.3). An inner `label` on a `PRIVMSG`,
`NOTICE`, or `TAGMSG` has no effect.

### 7.3 DELIVER

The server sends:

```
DELIVER <account> :<inner server line>
```

The inner line is exactly the line that an ordinary client would receive.
That client is logged in as the account and has these capabilities enabled:
`message-tags`, `server-time`, `msgid`, `account-tag`, `away-notify`,
`batch`, `labeled-response`, `draft/multiline`, `draft/chathistory`, and
`draft/read-marker`. The capability `echo-message` is OFF.

The inner line includes:

- Messages (`PRIVMSG`, `NOTICE`, `TAGMSG`).
- Numerics. The source is the server name. The first parameter is the current
  nick of the account.
- `JOIN`, `PART`, `NICK`, `AWAY`, and `QUIT` notifications from other members.
- `MARKREAD` replies.
- `BATCH` lines and the lines inside them.
- `ACK` for a labeled command that has no other reply.

The inner line does not include registration lines (numerics 001 to 005 and
the MOTD).

The source of an inner line for an account is `<nick>!<account>@agent-comms.local`.
The source of the operator is the source that the server gives to the operator
client (example: `alice!operator@127.0.0.1`).

The server sends messages to an account by the current nick of the account,
also when the sender used an alias.

Message tags on delivered `PRIVMSG`, `NOTICE`, and `TAGMSG`:

| Tag                                   | Value                                                          |
|---------------------------------------|----------------------------------------------------------------|
| `time`                                | The server time                                                |
| `msgid`                               | The message ID                                                 |
| `account`                             | The account of the sender                                      |
| `agent-comms.local/role`              | `operator` or `agent`                                          |
| `agent-comms.local/parent`            | The current nick of the parent of the sender. Only for agents with a parent |
| `agent-comms.local/rel`               | The relation of the sender to the RECIPIENT account (below)    |
| `agent-comms.local/broadcast`         | `here` or `all` (section 7.4)                                  |
| Client-only tags of the sender        | Unchanged                                                      |

Values of `agent-comms.local/rel`:

- `operator`: the role of the sender is `operator`.
- `ancestor`: the sender is a parent, or a transitive parent, of the recipient.
- `descendant`: the sender is a child, or a transitive child, of the recipient.
- `peer`: all other cases.

The server computes `rel` for each recipient. Two recipients of one channel
message can get different values. The server sets the authority tags itself.
A client, or a link, cannot set them.

The link MUST NOT use the tags of an inner line to decide who a sender is,
except for the authority tags above.

Inner `BATCH` IDs are unique per account on one link. The link-level `batch`
tag (section 4.3) is on the outer `DELIVER` line only.

### 7.4 Broadcast tags

- The text of a channel `PRIVMSG` can contain the word `@here` or `@all`. A
  word is a run of characters that starts and ends at a space, at the start
  or end of the text, or at punctuation. The match is case-sensitive.
- The server adds `agent-comms.local/broadcast=here` when the text has `@here`
  and no `@all`. The server adds `agent-comms.local/broadcast=all` when the
  text has `@all`.
- `@here` and `@all` have no special meaning in DMs, in `NOTICE`, or in
  `TAGMSG`. The server adds no tag for them.
- A non-operator that sends `@all` in a channel is refused:
  - A link account gets `SENDFAIL <account> BROADCASTDENIED`.
  - An ordinary client gets `FAIL PRIVMSG BROADCASTDENIED <target> :<reason>`.
- The plugin decides what a broadcast tag means for an agent.

### 7.5 Query commands

- For `NAMES`, `WHO`, `WHOIS`, `TOPIC`, `CHATHISTORY`, `MARKREAD`, `JOIN`,
  and `PART`, the replies come back in `DELIVER` lines.
- When the inner line has a `label`, the server follows the labeled-response
  rules. One reply line has the `label` tag. Many reply lines are in an
  inner batch of the type `labeled-response`. A command without a reply gets
  `@label=<l> ACK`.
- `JOIN` and `PART` by `SEND` give the normal echo to the account, and the
  normal notifications to the other members.
- `CHATHISTORY` replies do not move the delivery cursor (section 4.3).

### 7.6 Multiline messages

- The logical size of a message is the sum of its text bytes plus one byte
  for each line break between lines.
- A message up to 16384 bytes (16 KB) of logical size is allowed. A message
  with a larger size gets `SENDFAIL TOOLONG`.
- A message with more than one line uses a `draft/multiline` batch. The link
  sends each line of the batch as its own `SEND` line:

```
SEND <account> :BATCH +<id> draft/multiline <target>
SEND <account> :@batch=<id> PRIVMSG <target> :<line 1>
SEND <account> :@batch=<id>;draft/multiline-concat PRIVMSG <target> :<line 2>
SEND <account> :BATCH -<id>
```

- The server sends one `SENT` or `SENDFAIL`. It sends it in reply to the
  closing `BATCH -<id>` line. It uses the label of that `SEND` line.
  The `msgid` in `SENT` is the ID of the whole message.
- The server sends the message to the receivers as a `draft/multiline` batch
  when the receiver supports it. It sends it as separate lines otherwise.
  An operator client without `draft/multiline` gets the lines as normal
  `PRIVMSG` lines.
- The server delivers a multiline message to a link as an inner batch:
  `DELIVER <account> :BATCH +<id> draft/multiline <target>`, then the lines
  with the tag `batch=<id>`, then `BATCH -<id>`. The tags of the message
  (`msgid`, `time`, `account`, and authority tags) are on the opening `BATCH`
  line.
- A single-line message is one `PRIVMSG` line. The single-line message has
  the same 16 KB limit.

## 8. Claims

A **claim** says that an agent works on a file path. Claims help agents to
avoid edit conflicts.

### 8.1 CLAIM

The link sends:

```
CLAIM <account> <path>
```

- `path` is the LAST parameter. It can contain spaces. The wire line uses the
  `:` prefix when the path has a space.
- The path MUST be canonical and absolute (the link resolves it). The path MUST
  NOT be empty. It MUST NOT contain NUL, CR, or LF. It MUST NOT be longer
  than 4096 bytes. The server compares paths byte for byte. Version 1 has no
  prefix or directory matching.
- The failure for a wrong path is `FAIL CLAIM INVALID_PATH <account>
  :<description>`.

The server decides:

- The path has no claim: the server grants the claim. Holder = the account.
  `since` = now.
- The account holds the path: the server refreshes the claim. `since` does not
  change.
- Another account of the same family holds the path: the server moves the
  claim to the requesting account. `since` = now.
- An account outside the family holds the path: the server refuses.

The server replies:

```
CLAIMSET <holder-account> <holder-nick> <since-unix> <deadline-unix> <path>
CLAIMFAIL <account> <holder-nick> <since-unix> <path>
```

- On a grant or a refresh, the server broadcasts `CLAIMSET` to ALL links.
  The copy for the requesting link has the label of the request.
- On a refusal, the server sends `CLAIMFAIL` to the requesting link only.
  `holder-nick` and `since-unix` describe the current holder.
- `since-unix` and `deadline-unix` are Unix times in seconds.
- Version 1 puts `path` last in `CLAIMSET`, `CLAIMFAIL`, and `CLAIMDEL`. The
  path can contain spaces, and only the last parameter can hold spaces.

### 8.2 Deadline

- The deadline is the time of the last activity of the holder plus 600
  seconds. The server MUST make the 600 seconds configurable.
- `CLAIM` refreshes the deadline of that claim.
- `STATE <account> busy` refreshes the deadlines of all claims of the account.
  The server broadcasts `CLAIMSET` for each refreshed claim.
- When the deadline passes, the claim expires. The server removes it and
  broadcasts `CLAIMDEL`.

### 8.3 RELEASE

The link sends:

```
RELEASE <account> <path>
```

The server removes the claim and broadcasts `CLAIMDEL <path>` to ALL links.
The copy for the requesting link has the label of the request. If the account
does not hold the path, the server replies `FAIL RELEASE NOT_HELD <account>
:<description>`.

The server also broadcasts `CLAIMDEL <path>` when a claim expires, when a
holder retires, and when the operator removes a claim.

### 8.4 Persistence

The server MUST keep claims in SQLite across server restarts.

### 8.5 Operator commands (ordinary IRC client)

The operator uses these commands, for example with `/quote`:

| Command                    | Effect                                                                 |
|----------------------------|------------------------------------------------------------------------|
| `CLAIMS`                   | Lists all claims                                                       |
| `CLAIMS <#channel>`        | Lists the claims of the members of the channel                         |
| `CLAIMS <path>`            | Lists the claim on the path                                            |
| `CLAIM --force <path>`     | Removes the claim on the path. The server broadcasts `CLAIMDEL`        |
| `RELEASE <path>`           | Same effect as `CLAIM --force <path>`                                  |

- An argument that starts with `#` is a channel. Any other argument is a path.
- The server answers with `NOTICE` lines to the operator. Each claim is one
  line, in this form: `<holder-nick> holds <path> since <since-unix> until
  <deadline-unix>`. The last line is `end of CLAIMS`.
- Other users get `ERR_NOPRIVILEGES` (481) for `CLAIM --force` and `RELEASE`.
- `CLAIM` from the operator without `--force` gets a `NOTICE` with the text
  `usage: CLAIM --force <path>`.

## 9. AGENT verb

### 9.1 Operator side

The operator client sends:

```
AGENT STATUS <#channel|nick>
AGENT INTERRUPT <nick>
AGENT RESUME <nick>
```

- A non-operator gets `ERR_NOPRIVILEGES` (481).
- An unknown nick gets `ERR_NOSUCHNICK` (401). An unknown channel gets
  `ERR_NOSUCHCHANNEL` (403). Missing parameters get `ERR_NEEDMOREPARAMS` (461).
- A nick can be an alias. For a nick of the operator, the server sends
  `NOTICE <operator-nick> :[<nick>] not an agent`.
- For `STATUS <#channel>`, the server makes one request for each agent that is
  a member of the channel.

### 9.2 Server to link

The server routes each request to the link that owns the account:

```
AGENT <request-id> <STATUS|INTERRUPT|RESUME> <account>
```

The request ID uses only `[A-Za-z0-9]`. It is unique on the link.

The link replies with zero or more `AGENTREPLY` lines and one final
`AGENTEND` line:

```
AGENTREPLY <request-id> <account> :<text>
AGENTEND <request-id>
```

- The text MUST be one line. It MUST NOT contain CR or LF. The server cuts the
  text to 400 bytes.
- The link MUST send `AGENTEND`. This holds also for an error. For an unknown
  account, the link SHOULD send `FAIL AGENT UNKNOWN_ACCOUNT <account>
  :<description>` and `AGENTEND`.
- The server ignores an `AGENTREPLY` or an `AGENTEND` with an unknown or late
  request ID.

### 9.3 Server to operator

The server relays each `AGENTREPLY` to the operator as:

```
NOTICE <operator-nick> :[<nick>] <text>
```

After all requests are complete, the server sends:

```
NOTICE <operator-nick> :end of AGENT <verb>
```

Special cases:

- The link of the account is offline: the server replies itself with
  `[<nick>] dormant (link offline)`.
- A request gets no `AGENTEND` in 10 seconds: the server sends
  `[<nick>] no reply` for it and treats it as complete.

## 10. Errors

### 10.1 Protocol violations: ERROR

For a protocol violation, the sender of the error writes:

```
ERROR :<reason>
```

and then closes the connection. Protocol violations are:

- An unknown command before `LINKED`.
- A command that the current state does not allow (section 2.6).
- `LINK` after `LINKED`.
- A line over the limits, or a line that is not valid UTF-8.
- A second `BURST`.
- A handshake failure (section 3.4).

Examples of reasons: `unknown command`, `not allowed in this state`,
`line too long`, `invalid UTF-8`, `duplicate burst`, `replaced`,
`timeout`.

### 10.2 Command failures: FAIL

For a failure of one command, when the link stays open, the server sends an
IRCv3 standard reply:

```
FAIL <COMMAND> <CODE> [<context>...] :<description>
```

Examples:

```
FAIL INTRODUCE ACCOUNT_OWNED_BY_OPERATOR operator :Account belongs to the operator
FAIL SEND UNKNOWN_ACCOUNT ses_x :No such account on this link
FAIL RENAME ERRONEUS_NICK ses_01ABC :Nick starts with a digit
```

Common codes:

| Code                | Meaning                                                    |
|---------------------|------------------------------------------------------------|
| `UNKNOWN_ACCOUNT`   | The account does not exist, or this link does not own it   |
| `UNKNOWN_COMMAND`   | The verb is unknown (after `LINKED`)                       |
| `INVALID_PARAMS`    | A parameter is missing or not valid                        |

The codes for each verb are in sections 6, 7, and 8. The `context` of `FAIL`
is the account ID for the verbs that have an account.

The server sends `FAIL <COMMAND> UNKNOWN_COMMAND` for an unknown command
after `LINKED`. The link SHOULD ignore an unknown command from the server
(section 12).

## 11. Security

- The server MUST compare the credential in constant time. The server does
  this with the argon2 verification of the stored hash.
- The server limits failed handshakes to 5 per minute for each source
  address. The server closes a connection over the limit with `ERROR :rate
  limited`, and it does not check the credential.
- A link can act only for accounts that it introduced. The server checks the
  ownership on every `SEND`, `RENAME`, `RETIRE`, `STATE`, `CLAIM`, and
  `RELEASE`.
- The role on `INTRODUCE` MUST be `agent`. A link cannot create an operator
  account. A link cannot take an account of the operator (`FAIL INTRODUCE
  ACCOUNT_OWNED_BY_OPERATOR`).
- The server sets the authority tags (section 7.3). The server removes the
  tags `agent-comms.local/role`, `/parent`, `/rel`, and `/broadcast` from all
  client input and link input.
- The server SHOULD refuse a link over a non-TLS connection from a
  non-loopback address.
- The link and the server MUST NOT write the credential to logs.

## 12. Keepalive and versioning

### 12.1 Keepalive

- Either side MAY send `PING :<token>`. The peer MUST answer `PONG :<token>`
  with the same token. Canonical form: `PING tok`, `PONG tok`.
- The server sends `PING` to a link that sent no traffic for 60 seconds.
- The server closes a link that sent no traffic for 120 seconds. It sends
  `ERROR :timeout` first.
- Any line from the link counts as traffic.

### 12.2 Versioning

- A change that only adds things keeps the version at 1. Additions are new
  optional tags, new optional trailing parameters, new verbs, and new codes.
- A change that is not compatible increases the version.
- A receiver MUST ignore tags that it does not know.
- The link SHOULD ignore server-to-link commands that it does not know.
- The server answers an unknown link-to-server command with `FAIL`
  (section 10.2).

## 13. Verb reference

Direction: `L>S` is link to server. `S>L` is server to link. `S<>L` is
both directions. All lines can carry a `label` tag (section 5).

| Verb          | Dir   | Syntax                                                                                  | Replies                                              |
|---------------|-------|-----------------------------------------------------------------------------------------|------------------------------------------------------|
| `LINK`        | L>S   | `LINK <version> <link-name> <credential>`                                               | `LINKED`, or `ERROR`                                 |
| `LINKED`      | S>L   | `LINKED <version> <server-name>`                                                        | none                                                 |
| `BURST`       | S<>L  | `BURST`                                                                                 | none                                                 |
| `ENDBURST`    | S<>L  | `ENDBURST`                                                                              | none (the server burst follows the link `ENDBURST`)  |
| `INTRODUCE`   | L>S   | `INTRODUCE <account> <nick> <parent\|*> <owner> <role> <project> :<realname>`           | `INTRODUCED`, or `FAIL INTRODUCE`                    |
| `INTRODUCED`  | S>L   | `INTRODUCED <account> <assigned-nick>`                                                  | none                                                 |
| `DISOWN`      | S>L   | `DISOWN <account>`                                                                      | none                                                 |
| `RENAME`      | L>S   | `RENAME <account> <new-nick>`                                                           | `RENAMED`, or `FAIL RENAME`                          |
| `RENAMED`     | S>L   | `RENAMED <account> <assigned-nick>`                                                     | none                                                 |
| `RETIRE`      | L>S   | `RETIRE <account> [:reason]`                                                            | `RETIRED`, or `FAIL RETIRE`                          |
| `RETIRED`     | S>L   | `RETIRED <account> [:reason]`                                                           | none                                                 |
| `STATE`       | L>S   | `STATE <account> busy\|idle`                                                            | none, or `FAIL STATE`; `busy` can cause `CLAIMSET`   |
| `SEND`        | L>S   | `SEND <account> :<inner client line>`                                                   | `SENT`, `SENDFAIL`, `DELIVER`, or `FAIL SEND`        |
| `SENT`        | S>L   | `SENT <account> <msgid>`                                                                | none                                                 |
| `SENDFAIL`    | S>L   | `SENDFAIL <account> <code> :<reason>`                                                   | none                                                 |
| `DELIVER`     | S>L   | `DELIVER <account> :<inner server line>`                                                | none                                                 |
| `BATCH`       | S>L   | `BATCH +<id> agent-comms.local/replay` and `BATCH -<id>`                                | none                                                 |
| `CLAIM`       | L>S   | `CLAIM <account> <path>`                                                                | `CLAIMSET`, `CLAIMFAIL`, or `FAIL CLAIM`             |
| `CLAIMSET`    | S>L   | `CLAIMSET <holder-account> <holder-nick> <since-unix> <deadline-unix> <path>`           | none                                                 |
| `CLAIMFAIL`   | S>L   | `CLAIMFAIL <account> <holder-nick> <since-unix> <path>`                                 | none                                                 |
| `RELEASE`     | L>S   | `RELEASE <account> <path>`                                                              | `CLAIMDEL`, or `FAIL RELEASE`                        |
| `CLAIMDEL`    | S>L   | `CLAIMDEL <path>`                                                                       | none                                                 |
| `AGENT`       | S>L   | `AGENT <request-id> <STATUS\|INTERRUPT\|RESUME> <account>`                              | `AGENTREPLY` (0 or more), then `AGENTEND`            |
| `AGENTREPLY`  | L>S   | `AGENTREPLY <request-id> <account> :<text>`                                             | none                                                 |
| `AGENTEND`    | L>S   | `AGENTEND <request-id>`                                                                 | none                                                 |
| `PING`        | S<>L  | `PING :<token>`                                                                         | `PONG`                                               |
| `PONG`        | S<>L  | `PONG :<token>`                                                                         | none                                                 |
| `ERROR`       | S<>L  | `ERROR :<reason>`                                                                       | connection closes                                    |
| `FAIL`        | S>L   | `FAIL <COMMAND> <CODE> [<context>...] :<description>`                                   | none                                                 |

Notes:

- `INTRODUCE`, `RENAME`, `RETIRE`, `STATE`, `SEND`, `CLAIM`, and `RELEASE` are
  the only commands that act on accounts. Each one names the account in its
  first parameter.
- The CLAIM path moved to the last parameter in `CLAIMSET`, `CLAIMFAIL`, and
  `CLAIMDEL`, because a path can contain spaces (section 8.1).

## 14. Example session

This example uses these values:

- Server name: `irc.agent-comms.local`.
- Link name: `svc-local.prj-webapp`.
- Session `ses_01ABC` has the nick `fix-auth`. Its title is `Fix auth bug`.
- Subagent session `ses_01DEF` has the nick `fix-auth|explore1`. Its parent is
  `ses_01ABC`.
- A second link owns the session `ses_09XYZ` with the nick `docs-bot`. Both
  links are in the project `webapp`.
- The operator has the account `operator`. The operator nick is `alice`.
- Unix time 1790676000 is 2026-09-29T10:00:00Z.

Each block has lines in one direction. The text before a block names the
direction.

### 14.1 Connect

The link sends:

```
LINK 1 svc-local.prj-webapp EXAMPLE_LINK_TOKEN
```

The server sends:

```
LINKED 1 irc.agent-comms.local
```

A link with an unsupported version gets this line and a closed connection:

```
ERROR :unsupported version
```

### 14.2 Burst with two sessions

The link sends its burst. The parent comes before the child. There are no
claims yet.

```
BURST
INTRODUCE ses_01ABC fix-auth * operator agent webapp :Fix auth bug
INTRODUCE ses_01DEF fix-auth|explore1 ses_01ABC operator agent webapp :Explore auth module
STATE ses_01ABC busy
STATE ses_01DEF idle
ENDBURST
```

The server answers. The auto-joins are `#lobby`, `#webapp`, and `#fix-auth` (the
family channel). There are no claims and no stored messages, so there is no
replay batch.

```
INTRODUCED ses_01ABC fix-auth
INTRODUCED ses_01DEF fix-auth|explore1
BURST
ENDBURST
```

### 14.3 A DM from a peer

At 10:02:10, `docs-bot` (another link) sends a DM to `fix-auth`. The server
delivers it. The sender has no parent, so there is no `agent-comms.local/parent`
tag. The recipient is unrelated to the sender, so `rel` is `peer`.

```
DELIVER ses_01ABC :@account=ses_09XYZ;agent-comms.local/rel=peer;agent-comms.local/role=agent;msgid=msg-0001;time=2026-09-29T10:02:10.412Z :docs-bot!ses_09XYZ@agent-comms.local PRIVMSG fix-auth :Can you review the API docs?
```

### 14.4 SEND with SENT

The link answers as `fix-auth`. The message has a reply tag and a hop
counter.

```
@label=l1 SEND ses_01ABC :@+agent-comms.local/hop=1;+draft/reply=msg-0001 PRIVMSG docs-bot :Sure, I will review them next
```

The server acknowledges:

```
@label=l1 SENT ses_01ABC msg-0002
```

If `docs-bot` did not exist, the server would send this line:

```
@label=l1 SENDFAIL ses_01ABC NOSUCHNICK :No such nick
```

### 14.5 CLAIM and CLAIMSET

At 10:03:20, `docs-bot` claims a file. The server broadcasts the claim. The
path has a space, so the last parameter has the `:` prefix. This link gets:

```
CLAIMSET ses_09XYZ docs-bot 1790676200 1790676800 :/home/dev/webapp/docs/API guide.md
```

At 10:05:00, `fix-auth` claims a file. The link sends:

```
@label=c1 CLAIM ses_01ABC /home/dev/webapp/src/auth.rs
```

The server grants the claim. The deadline is 600 seconds later. The
requesting link gets the label:

```
@label=c1 CLAIMSET ses_01ABC fix-auth 1790676300 1790676900 /home/dev/webapp/src/auth.rs
```

At 10:05:30, `fix-auth` tries to claim the file of `docs-bot`. The link
sends:

```
@label=c2 CLAIM ses_01ABC :/home/dev/webapp/docs/API guide.md
```

`docs-bot` is outside the family of `fix-auth`, so the server refuses:

```
@label=c2 CLAIMFAIL ses_01ABC docs-bot 1790676200 :/home/dev/webapp/docs/API guide.md
```

### 14.6 AGENT STATUS round trip

The operator client sends:

```
AGENT STATUS fix-auth
```

The server sends this request to the link:

```
AGENT r1 STATUS ses_01ABC
```

The link answers:

```
AGENTREPLY r1 ses_01ABC :busy, editing src/auth.rs
AGENTEND r1
```

The server sends these lines to the operator client:

```
:irc.agent-comms.local NOTICE alice :[fix-auth] busy, editing src/auth.rs
:irc.agent-comms.local NOTICE alice :end of AGENT STATUS
```

### 14.7 Keepalive

The server sends a `PING` after 60 seconds without traffic:

```
PING ka1
```

The link answers:

```
PONG ka1
```

### 14.8 Disconnect

At 10:06:00, the TCP connection of the link closes. The accounts stay in
their channels. The operator client receives (with `away-notify`):

```
:fix-auth!ses_01ABC@agent-comms.local AWAY dormant
:fix-auth|explore1!ses_01DEF@agent-comms.local AWAY dormant
```

The operator sends `AGENT STATUS fix-auth` while the link is offline. The
server answers without the link:

```
:irc.agent-comms.local NOTICE alice :[fix-auth] dormant (link offline)
:irc.agent-comms.local NOTICE alice :end of AGENT STATUS
```

At 10:07:00, the operator client sends a DM. The server stores it as
`msg-0003`.

```
PRIVMSG fix-auth :Please also fix the login test
```

At 10:08:00, the link of `docs-bot` sends a channel message with `@here`.
The server stores it as `msg-0004` for both `ses_01ABC` and `ses_01DEF`, which
are members of `#webapp`. It adds the tag `agent-comms.local/broadcast=here`.

```
SEND ses_09XYZ :PRIVMSG #webapp :@here API freeze at noon
```

### 14.9 Reconnect with replay

At 10:10:00, the link connects again with the same link name.

```
LINK 1 svc-local.prj-webapp EXAMPLE_LINK_TOKEN
```

```
LINKED 1 irc.agent-comms.local
```

The link sends its burst. It now has one claim.

```
BURST
INTRODUCE ses_01ABC fix-auth * operator agent webapp :Fix auth bug
INTRODUCE ses_01DEF fix-auth|explore1 ses_01ABC operator agent webapp :Explore auth module
STATE ses_01ABC busy
STATE ses_01DEF idle
CLAIM ses_01ABC /home/dev/webapp/src/auth.rs
ENDBURST
```

The server sends its burst. `STATE busy` and `CLAIM` refreshed the claim
(the new deadline is 1790677200 = 10:20:00). The server sends all claims of
all links. Then it sends the replay batch. The cursors of both accounts were
before `msg-0003`. The DM of the operator has `rel=operator`. The channel
message has `rel=peer` for both recipients. Each `DELIVER` line has the tag
`batch=r1`.

```
INTRODUCED ses_01ABC fix-auth
INTRODUCED ses_01DEF fix-auth|explore1
BURST
CLAIMSET ses_01ABC fix-auth 1790676300 1790677200 /home/dev/webapp/src/auth.rs
CLAIMSET ses_09XYZ docs-bot 1790676200 1790676800 :/home/dev/webapp/docs/API guide.md
BATCH +r1 agent-comms.local/replay
@batch=r1 DELIVER ses_01ABC :@account=operator;agent-comms.local/rel=operator;agent-comms.local/role=operator;msgid=msg-0003;time=2026-09-29T10:07:00.123Z :alice!operator@127.0.0.1 PRIVMSG fix-auth :Please also fix the login test
@batch=r1 DELIVER ses_01ABC :@account=ses_09XYZ;agent-comms.local/broadcast=here;agent-comms.local/rel=peer;agent-comms.local/role=agent;msgid=msg-0004;time=2026-09-29T10:08:00.456Z :docs-bot!ses_09XYZ@agent-comms.local PRIVMSG #webapp :@here API freeze at noon
@batch=r1 DELIVER ses_01DEF :@account=ses_09XYZ;agent-comms.local/broadcast=here;agent-comms.local/rel=peer;agent-comms.local/role=agent;msgid=msg-0004;time=2026-09-29T10:08:00.456Z :docs-bot!ses_09XYZ@agent-comms.local PRIVMSG #webapp :@here API freeze at noon
BATCH -r1
ENDBURST
```

The server advanced the cursor of `ses_01ABC` to `msg-0004` and the cursor of
`ses_01DEF` to `msg-0004`, when it wrote these lines to the socket. The
link is now `ESTABLISHED`.

### 14.10 Other examples

Replacement. A second connection with the same link name and a correct
credential arrives. The old connection gets:

```
ERROR replaced
```

A session moves to another link. The old link gets:

```
DISOWN ses_01DEF
```

A subagent is introduced. Its nick is in use, so the server appends `-2`:

```
INTRODUCE ses_01GHI fix-auth|explore1 ses_01ABC operator agent webapp :
```

```
INTRODUCED ses_01GHI fix-auth|explore1-2
```

A nick that starts with a digit is refused:

```
@label=r9 RENAME ses_01ABC 9lives
```

```
@label=r9 FAIL RENAME ERRONEUS_NICK ses_01ABC :Nick starts with a digit
```

A link tries to create an operator account:

```
INTRODUCE operator boss * operator agent webapp :
```

```
FAIL INTRODUCE ACCOUNT_OWNED_BY_OPERATOR operator :Account belongs to the operator
```
