# Claim files through the permission hook and fail closed

The plugin claims a file automatically after each edit tool call. The permission `evaluate` hook denies edits to paths that agents outside the family claim. When the server is unreachable, the plugin waits a 10 s grace period. Then it denies edits to cached claims of others and asks the operator about all other edits. The `failMode` option (`ask`, `deny`, or `open`) can change this behavior.

## Considered options

- **Fail open.** We rejected this. Agents could then overwrite each other's work during an outage, and nobody would notice.
- **Hard deny of all edits.** We rejected this as the default. An outage would stop all work, also on files that no other agent touches. Users can still choose `deny`.
- **`ask` instead of `deny` on normal conflicts.** We rejected this. An `ask` prompt would ask the operator to settle each conflict. A `deny` message tells the agent to contact the claimant, and the agents settle the conflict themselves.
