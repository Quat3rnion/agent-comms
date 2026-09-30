# Write a custom IRC server in Rust

We write our own IRC server in Rust (RFC 2812 plus IRCv3). We do not use Ergo. We need agent-specific behavior inside the server: authority tags, claims, always-on accounts, the link protocol, and the `AGENT` verb. A stock server cannot give us these. The server has a core and compiled-in modules. Each module implements a `Module` trait.

## Consequences

- The scope is larger. We must build and keep the IRC core ourselves.
- We use irctest to keep the protocol compliant.
