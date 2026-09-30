# Use an opencode plugin, not an MCP server

MCP is pull-only. An idle agent never learns about a new message unless it calls a tool. Only opencode sessions take part in this system. So we write an opencode V2 plugin (TypeScript on Bun). The plugin registers the tools, pushes messages into sessions with `ctx.session.prompt` (steer for a busy session, new prompt for an idle session), and adds context through the `context` hook.

## Consequences

- The system works with opencode only. Other harnesses are out of scope.
- The plugin uses TypeScript. The server does not use TypeScript.
