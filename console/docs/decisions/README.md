# Decision records

The console's decision records. Each one says what was checked, what was decided and why. The repository's own records are in [docs/decisions/](../../../docs/decisions/README.md).

| Record | Issue | Decision |
|---|---|---|
| [agent-packages.md](agent-packages.md) | #614 (E38.9, epic #580) | The agent harness and the browser toolset are workspace packages that the API hosts. The app only binds ports. |
| [connections-auth.md](connections-auth.md) | #598 (epic E39, #581) | How a self-hosted console connects Google and Microsoft accounts (provisional: derived from documentation, experiments pending). |
| [secrets-embedding.md](secrets-embedding.md) | #594 (epic E37, #579) | The built-in secrets store reuses the `@marinoscar/vault-*` packages instead of a second secrets manager. |
| [tool-families.md](tool-families.md) | epic E41 (#697) | Tool families, and how the agent chooses between the browser, connected accounts and added tools. |
| [benchmark.md](benchmark.md) | epic E44 (#738) | Benchmarks run on the real product and are graded from the challenge site's state. |
| [knowledge-graph.md](knowledge-graph.md) | #775 (epic E46, #770) | The Knowledge Graph: a private, per-owner graph of learned procedures, off by default at every level, stored in PostgreSQL behind a port, never a source of permission. Owner guide: [knowledge-graph.md](../knowledge-graph.md). |
| [skills.md](skills.md) | #1008 (E51.3, epic #1005) | Skills v1: owner-written playbooks the agent reads when a job fits, separate from tasks, memories and the Knowledge Graph; owner-only, no hub, no scripts, no grant. |
| [web-search.md](web-search.md) | #971 (E50.1, epic E50 #970) | Web search behind one provider interface (results and answers in one shape); OpenAI through the AI service's hosted `web_search` (no seam request needed); service keys as an `api_key` item released to the console only, user tier in Vault or the built-in store, other tiers in the credential store; Google and Microsoft gain an optional `diagnose`, no rewrite. |
