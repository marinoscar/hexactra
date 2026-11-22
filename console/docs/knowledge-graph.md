# Knowledge Graph

The Knowledge Graph (epic E46, [decision record](decisions/knowledge-graph.md)) learns how one of your saved tasks is done from your own runs and replays it without the model; the AI steps back in only when something no longer matches. It is off by default at every level (your administrator, you, each task, each run).

## Export and import (E46.23)

- **Export:** `GET /api/kgraph/export?procedureIds=` (`kgraph:read`) downloads `hexactra-kgraph-<yyyymmdd>.json` (`kind: "hexactra.kgraph"`, `formatVersion: 1`, schema in `packages/hexactra-kgraph/docs/schema.md`, "TransferFile"). Each procedure carries its task's name, goal, parameters and outputs, and its active version's steps, edges, checks and element fingerprints.
  - **Never exported:** ids of users, runs, tasks, chats, procedures or versions; connection ids or tokens (an account is its provider and a placeholder such as `account-1`); saved-login ids (a saved login is its label); evidence; traces; a literal that looks like a secret (it becomes a sensitive task parameter you fill in).
- **Import:** `POST /api/kgraph/import` (`kgraph:write`) with `{ file, accounts?, attach? }`.
  1. The file is validated (shape, format version, limits: 1 MB, 50 procedures, 500 steps each). A malformed file, a newer `formatVersion` or an over-limit file is refused with `400 KGRAPH_IMPORT_INVALID` and nothing is imported; an older format version is read.
  2. Each exported account must be mapped by you (`accounts: { "account-1": "<your connection id>" }`); nothing is matched by name. An unmapped procedure is skipped with its reason.
  3. It is attached to one of your tasks (`attach: { "0": "<task id>" }`), or a new task is created in `learn` mode with your defaults: an import never sets allowed sites, adds a connection to a task or creates a saved approval.
  4. It is stored as a candidate with `change_class: sensitive` and a review of the whole procedure. It is never replayed before you approve it (signed in to the console), and then its first run is a verification run that asks before every step that sends or pays.
