# Decision record: one agent loop, in the console

Issue #588 (epic E38, #580). Decided 2026-11-19, from a trace of the tree at `e8a143c`.

## Context

The repository held two agent loops. The one that runs every job is the console's TypeScript goal runner (`console/apps/api/src/runner/`, on the platform AI service). An older Rust loop from the original v1 plan (epic E06, "managed AI goal runner") stayed in the workspace and was still compiled and tested on every CI run: about 3,000 lines in four crates and 74 tests that proved a loop nothing ran.

## Usage table

Every row was traced before acting. "Dependents" are the other crates, binaries, packages or docs that use the piece; the commands are in the next section.

| Piece | Size | Dependents (before) | Reachable in the deployed fabric | Decision |
|---|---|---|---|---|
| `crates/hexactra-planning-loop` (observer, reasoner, action dispatcher, verifier, loop state) | 1,532 lines | Only `hexactra-execution`'s `Cargo.toml` (never imported in its source) | No: no binary, no route, no caller | **Remove** |
| `crates/hexactra-agent-run` (run state, policy, SQLite store) | 945 lines | `hexactra-planning-loop`, `hexactra-execution` (manifest only) | No | **Remove** |
| `crates/hexactra-model-adapter` (OpenAI-compatible client in Rust) | 561 lines | `hexactra-planning-loop`, `hexactra-execution` (manifest only) | No: the console calls models through the platform AI service | **Remove** |
| `crates/hexactra-execution` (execution policy, budgets, retries, takeover) | 1,053 lines | None. Its source imports none of the three loop crates; the manifest lists them. README grouped it with the loop. | No | **Remove** (the console enforces policy, budgets and stall detection itself: VISION §26.3, §26.6) |
| `crates/hexactra-control/src/routes/goals.rs` | 59 lines | `pub mod goals;` only | **No: `create_router` never merges it**, and its three handlers return fixed strings ("List goals") | **Remove**, with the `goals:read` and `goals:write` scopes and `ResourceType::Goal` (nothing checks them: the only readers were the `authorize` match arms) |
| `POST /goals`, `GET /goals`, `GET /goals/{goalId}` in `docs/api.md`; MCP tools `create_goal`, `get_goal_status`, `list_goals` listed there | | Docs only. `api/openapi.yaml` and `api/*.json` never described them; the Rust MCP server (`api/mcp-schemas.json`) has no such tools; the Rust CLI has no such command | No | **Remove** from `docs/api.md` and `docs/security.md` |
| `ControlPlaneClient.createGoal`, `Goal`, `CreateGoalRequest`, `CreateGoalResponse` in `packages/sdk`; the same two request types in `packages/contracts` | | Nothing: no other package, the extension or the dashboard imports them. They called `/goals`, which was never served | No | **Remove** |
| `Goal`, `GoalId`, `RunStatus` in `hexactra-core`; the `goals` table; `Database` goal helpers in `hexactra-control/src/state.rs` | | `operations` and durable actions carry a `goal_id`; core's tests use the types | Yes (types and schema) | **Keep as live data types.** Installed migrations are never edited, and an operation's `goal_id` is its target, not a loop |
| `hexactra-credential-resolver`, `hexactra-notification-delivery`, `hexactra-provider-sdk`, `hexactra-demo-provider`, `hexactra-provider-tests` | | `hexactra-control` (resolver); the others are the E11 provider contract and its tests | Yes | **Keep** (not part of the loop) |
| `hexactra-aef-connector`, `hexactra-benchmark` | | Optional AEF boundary (VISION §17) | Optional | **Keep** |
| `hexactra-worker` | | Not on the remote-control path (README) | Scaffolding | **Out of scope** |
| `packages/sdk/src/planning.ts` and `openai.ts` (TypeScript planning helper and OpenAI client) | | `packages/sdk/README.md` says the extension's loop uses them; no import in this tree | Not exported by the SDK index | **Out of scope**: the extension's standalone assistant is a separate, live feature (VISION §25) and must not be touched |
| `apps/chrome-extension` standalone agent | | | Live | **Untouched** |

No piece was quarantined: nothing named a future use, and `crates/experimental/` would keep the build and test cost for no caller. A future Rust loop would start from the console runner's contract (VISION §26.3), not from this code, which predates agent policies, vision rounds, handoffs and budgets.

## Trace commands

Run on `e8a143c`; each prints only the hits the table cites.

```bash
git grep -n -E "hexactra-(planning-loop|agent-run|model-adapter|execution)" -- '*Cargo.toml' ':!Cargo.lock' .github deploy scripts tests release
#   Cargo.toml (workspace members), the four crates' own manifests, and
#   crates/hexactra-execution/Cargo.toml:26-28  (the only dependent)
git grep -n -E "hexactra[-_]execution" -- . ':!Cargo.lock'
#   Cargo.toml, README.md, the crate's own manifest: no dependent
git grep -n -E "/goals|goals:|routes::goals|goals::router" -- crates packages apps api deploy tests scripts console .github
#   auth.rs scope arms, routes/goals.rs, packages/sdk (createGoal): no router, openapi, CLI or MCP hit
git grep -n "goals" -- crates/hexactra-control/src/lib.rs crates/hexactra-control/src/main.rs
#   lib.rs:11  pub mod goals;   (declared, never merged into create_router)
```

`.github/workflows` named none of the removed crates, so no workflow step changed; the Rust job runs `cargo test --workspace`, which now simply has fewer crates.

## Consequences

- Cold `cargo test --workspace --all-targets` build: 3 min 10 s before (this checkout, empty `target/`); see the pull request for the after figure. Tests: 492 before, 418 after (74 tests of the four crates).
- Public API change in the fabric: the `goals:read` and `goals:write` scopes and the unserved `/goals` routes are gone. A token that still carries either scope validates; `Scope::from_str` skips unknown scopes. SDK users lose `createGoal`, which called a route that did not exist. Recorded in `CHANGELOG.md` and `docs/api.md`.
- `AGENTS.md` ("Architecture") and VISION §6.1, §25.7, §25.9, §25.10, §25.11 and §26.3 now say where the loop is and that the Rust side has none. Closed issues of E06 are left as they are; one comment on the E06 epic links this issue.
