# Decision records

Short records of decisions that change what the repository contains. Each says what was checked, what was decided and why. The console keeps its own in [console/docs/decisions/](../../console/docs/decisions/).

| Record | Issue | Decision |
|---|---|---|
| [one-agent-loop.md](one-agent-loop.md) | #588 (epic #580) | The agent loop is the console's goal runner. The Rust planning loop, its three support crates and the unmounted goals route are removed. |
| [run-recordings.md](run-recordings.md) | #756 (epic #755) | An owner-opted-in run recording is a continuous, unmasked video of the session tab, owner-only, outside the trace and every sharing path, deleted by an admin retention policy (default 30 days, or keep indefinitely). |
| [profile-signin-health.md](profile-signin-health.md) | #927 (epic #926) | Each profile's Google sign-in status is detected on the node (the `Preferences` file offline, `ListAccounts` from the extension live), reported over its own route, shown in full to `fleet:read` and never logged, traced or given to MCP. A failed check is `unknown`. |
| [passkey-provider.md](passkey-provider.md) | #939 (epic #925) | Hexactra is a passkey provider for the browser it drives: the extension answers WebAuthn only on a tab the fabric armed, the fabric makes and signs with ES256 keys kept in the owner's secrets provider, enrolment needs the owner's approval, and a payment assertion is never made. |
| [../../console/docs/decisions/knowledge-graph.md](../../console/docs/decisions/knowledge-graph.md) | #775 (epic #770) | The console's Knowledge Graph: a private, per-owner graph of learned procedures, off by default at four levels, stored in PostgreSQL behind a port, never a source of permission. |
