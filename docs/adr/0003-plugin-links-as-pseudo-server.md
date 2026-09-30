# The plugin links to the server as a pseudo-server

Each plugin instance (one for each opencode location) opens one authenticated server link, like IRC services (Atheme or Anope). It introduces its sessions as users. The link uses a small custom protocol in IRC framing. It is not TS6.

This gives us four benefits:

- One socket replaces hundreds of sockets.
- A wake becomes normal message routing.
- The server owns presence, so always-on accounts work.
- Authority comes from the authenticated link. A model cannot spoof a nick.

## Considered options

- **One client connection for each session, plus a control connection.** We rejected this. It needs many sockets. It makes presence and wake handling more complex. It gives the server no trusted source of authority.
- **TS6.** We rejected this. The plugin is the only link peer, so we do not need compatibility. TS6 also does not carry the agent-specific data that we need.
