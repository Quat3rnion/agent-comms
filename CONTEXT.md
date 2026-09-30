# Agent Comms

Agent Comms lets opencode agents talk to each other and to the operator. The operator uses a normal IRC client to watch and steer the agents.

## Language

### People and agents

**Operator**:
The human user. The operator connects with an IRC client (for example WeeChat) and has full authority over all agents.
_Avoid_: User, admin, human

**Agent**:
One opencode session that takes part in the system. One nick identifies each agent. Top-level sessions and subagents are both agents.
_Avoid_: Session (when you mean the participant), bot, client

**Subagent**:
An agent whose session is a child session of another agent's session. Its nick has the form `parent|child`.
_Avoid_: Child agent, worker

**Ancestor**:
An agent that is the parent, or the parent of a parent, of another agent. The relation is transitive.
_Avoid_: Superior, boss

**Descendant**:
An agent that is the child, or the child of a child, of another agent. The relation is transitive.
_Avoid_: Sub-subagent

**Family**:
An agent together with its ancestors and descendants. Family members share claims. Each parent has a family channel named `#<parent-nick>`.
_Avoid_: Team, group, tree

### Connection and presence

**Link**:
The single authenticated connection from one plugin instance (one opencode location) to the server. One link carries all agents of that location.
_Avoid_: Connection, socket, client connection

**Always-on account**:
The server account of an agent. It stays present in channels even when its link is down. The server retires it only when the session is deleted or archived, or after 30 days of inactivity.
_Avoid_: Persistent user, bouncer

**Awake**:
The state of an agent whose session is running a turn (busy).
_Avoid_: Online, active

**Dormant**:
The state of an agent whose session is idle, or whose link is down. Its nick shows AWAY.
_Avoid_: Offline, sleeping, inactive

### Messages and delivery

**Directed message**:
A message meant for a specific agent. It is a DM, a message that mentions the nick, or a broadcast.
_Avoid_: Mention (too narrow), notification

**Chatter**:
Any channel message that is not a directed message. Chatter only increases the unread count.
_Avoid_: Noise, background traffic

**Push**:
The delivery of a directed message into a session. A push steers the session when the session is busy.
_Avoid_: Notify, inject

**Wake**:
A push that starts a new turn in an idle session.
_Avoid_: Trigger, resume

**Broadcast**:
An operator keyword that addresses many agents at once. `@here` reaches all awake members of a channel. `@all` reaches all members and wakes dormant ones. Only the operator can use `@all`.
_Avoid_: Mass message, announcement

### Loop control

**Hop**:
A count on each message of how many agent-to-agent steps led to it. Above the limit (4), the message gets no push.
_Avoid_: Depth, generation, TTL

**Wake budget**:
The maximum number of agent-triggered wakes for one session in one hour (10). Operator messages ignore the budget.
_Avoid_: Rate limit, quota

### Authority and files

**Authority**:
How a receiving agent treats a message. The three levels are operator (full), ancestor (full, over its own descendants), and peer (request only; the receiver decides). A message from a child to its parent is a report.
_Avoid_: Permission, role (for this meaning), priority

**Claim**:
A lock on one file path held by one agent. An edit creates it automatically. It ends after 10 minutes idle or on request. It blocks edits by agents outside the family.
_Avoid_: Lock, reservation

**Fail mode**:
The rule for edits when the server cannot be reached. `ask` (default) denies paths that others are known to claim and asks the operator about all other edits. `deny` denies all edits. `open` allows all edits.
_Avoid_: Offline mode, fallback

## Relationships

- The **Operator** has full **Authority** over all **Agents**.
- An **Agent** has zero or one parent **Agent**. A **Subagent** always has one.
- An **Agent** has many **Ancestors** and many **Descendants**.
- A **Family** contains one **Agent** with all its **Ancestors** and **Descendants**.
- A **Link** carries many **Agents**. An **Agent** belongs to exactly one **Link** at a time.
- An **Agent** has exactly one **Always-on account**.
- An **Agent** is **Awake** or **Dormant**, never both.
- A **Wake** is a **Push** to a **Dormant** **Agent**.
- Only a **Directed message** can cause a **Push**. **Chatter** never does.
- Each **Directed message** carries one **Hop** count.
- Each **Agent** has one **Wake budget**.
- An **Agent** holds many **Claims**. Each **Claim** belongs to one **Agent**.
- A **Claim** does not block **Family** members.

## Example dialogue

> **Dev:** If the **Operator** writes `@here` in a channel, does every **Agent** in it get a **Push**?
>
> **Domain expert:** Only the **Awake** members get one. `@here` is a **Broadcast** and counts as a **Directed message**. **Dormant** agents stay dormant.
>
> **Dev:** How does the **Operator** reach a **Dormant** agent?
>
> **Domain expert:** With a DM, or with `@all`. The **Push** then becomes a **Wake**. The **Operator** is the only sender that can use `@all`.
>
> **Dev:** Can an agent wake a **Dormant** peer with a DM?
>
> **Domain expert:** Yes, if the **Wake budget** of the peer and the **Hop** limit allow it. The peer sees the message with **Peer** authority. It treats the message as a request, and it decides what to do.
>
> **Dev:** And if a parent agent sends a DM to one of its **Descendants**?
>
> **Domain expert:** The message has **Ancestor** authority. The descendant must follow it. If the child writes back to the parent, the message is a report.
>
> **Dev:** What if two agents from different **Families** edit the same file?
>
> **Domain expert:** The first edit creates a **Claim**. The second agent cannot edit the file until the **Claim** ends. Agents in the same **Family** are not blocked.

## Flagged ambiguities

- "Session" and "agent" both appear in conversation. **Agent** is the participant in the system. A session is only the opencode object behind it. Use **Agent** for the participant.
- "Connection" can mean the **Link** or the connection of an IRC client. Use **Link** for the plugin connection. Use "IRC client connection" for the **Operator**.
- "Role" and "authority" both describe the sender of a message. Use **Authority** for how the receiver treats a message.
- "Mention" and "directed message" overlap. A mention is only one kind of **Directed message**.
