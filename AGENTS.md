# AGENTS.md

Shared instructions for all coding agents in this repository (Claude Code, OpenCode, and others). This is the single source of truth: `CLAUDE.md` imports it, and OpenCode reads it natively. Edit this file, not copies of it.

## Repository state

Hexactra is a Cargo + pnpm monorepo with a large amount of scaffolding. **Most v1 issues are closed, but the end-to-end remote-control path was stubbed** (audit in epic #173). Treat closed issues as "code exists", not "capability works", until an end-to-end test proves it.

- `VISION.MD` — product vision and architecture (25 sections). A proposal, not a statement of shipped capability.
- `crates/` — Rust workspace (control plane, host agent, worker, native host, CLI, MCP, core types, telemetry, providers, AEF connector, fleet scheduling).
- `apps/chrome-extension` (MV3 extension, standalone side-panel AI works), `apps/dashboard`, `packages/sdk`, `packages/contracts`.
- `api/openapi.yaml`, `api/*.json` — contracts (CI checks they parse).
- `scripts/link-github-subissues.mjs` — idempotent script linking epics to sub-issues (`epicChildren` map); refuses any repo but `marinoscar/hexactra`.

Commands:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets      # deny-level lints fail; style warnings are tracked debt
cargo test --workspace --all-targets
pnpm install --frozen-lockfile && pnpm build
pnpm --filter @hexactra/sdk --filter @hexactra/chrome-extension test
python3 scripts/ci/validate-contracts.py
GITHUB_TOKEN=... node scripts/link-github-subissues.mjs --check   # dry run of sub-issue linking
```

CI (`.github/workflows/ci.yml`) runs all of the above. A workflow step must never report success for a test that does not exist.

## Work tracking

The backlog lives in GitHub issues (#1–#93, plus epic #173 and its children): 16 epics, each with 5–6 child tasks, linked as native sub-issues. Titles use `[EPIC Exx]` / `[Exx.n]`.

- **v1 (E00–E10):** E00 foundation/contracts/CI → E01 standalone Chrome driver → E02 standalone AI agent + side-panel chat → E03 unattended Linux host → E04 native messaging + worker → E05 remote control plane → E06 managed AI goal runner → E07 HITL → E08 SDK/CLI/MCP → E09 OTel/audit/security → E10 release.
- **post-v1 (E11–E14):** vault/notification providers, Windows/macOS hosts, AEF integration, fleet orchestration. Don't pull these into v1 work.
- **E15 (#173)** is the current priority: the remote-control vertical slice (control plane → agent → native host → extension) with a real e2e test.

## MANDATORY: Issue-driven development

All work is tracked in GitHub issues. Nothing is implemented, and no branch or worktree is created, until an issue exists. `gh` infers the repo from the git remote.

- **Find first.** Search existing issues (`gh issue list --state all --search "<terms>"`) and reuse a matching one rather than filing a duplicate. If the user names an issue, work that issue.
- **No issue? Create one, sized to the work:**
  - Small, single-PR change or bug → one child issue.
  - Multi-PR or multi-step work → an `epic`-labeled issue plus child issues, linked as native sub-issues (extend `epicChildren` in `scripts/link-github-subissues.mjs`, or use `gh api` sub-issue endpoints).
  - Match the existing issue format (see #2): Phase/Parent/Sequence/Prerequisites header, Objective, Implementation contract, Acceptance criteria (checkboxes), Verification/completion evidence. Label `v1` or `post-v1`; epics also get `epic`. Don't pull post-v1 work into v1.
  - Ask the user before filing if scope is ambiguous or it would need a new epic.
- **Respect prerequisites.** Don't start an issue whose prerequisites aren't closed; say so instead.
- **Update the issue as you go and when done:** comment with what changed, the exact commands run and their real pass/fail output, and tick the acceptance checkboxes that are actually met. Never claim a test passed that you did not run.
- **Finish through a PR, merged to `main`:** open a PR from the issue branch to `main` with `Fixes #<n>` in the body (plus `Relates to #<epic>`), implementation paths, design decisions and executed tests. When checks (if any exist) pass, squash-merge it (`gh pr merge <pr> --squash`), confirm the issue closed, and tick it off in the parent epic. Never push work directly to `main`. If checks fail or review is requested, fix them; don't merge around them.
- **Report status** after each issue as a table with columns Issue # | Issue Name | PR (full URL) | Status, where Status is one of `Not started`, `In progress`, `Open — awaiting review`, `Changes requested`, `Merged`, `Blocked — <reason>`. Show the whole epic's set, not only the last issue.
- Only an explicit user instruction (e.g. "commit and push to main") overrides this for a given change, and only for that change.

## MANDATORY: Branch-based development

Every issue is developed in its own Git branch. **The main checkout stays on `main` at all times.**

- Branch name: `issue/<issue#>-<slug>`, always created from an up-to-date `main`.
- Branches live in the main repository (no worktrees).

```bash
git -C <repo> fetch origin && git -C <repo> pull --ff-only          # from the main checkout
git checkout -b issue/2-bootstrap-monorepo origin/main               # create branch from main
# ...work, commit, push...
git push -u origin issue/2-bootstrap-monorepo
gh pr create --base main --fill   # body must contain "Fixes #2"
gh pr merge --squash              # run from the main checkout
# cleanup:
git checkout main && git pull --ff-only
git branch -D issue/2-bootstrap-monorepo && git push origin --delete issue/2-bootstrap-monorepo
```

Rules:
- Always create branches from `main`. Never check out an issue branch in the main checkout; use a separate checkout if needed.
- One issue → one branch → one PR. Never combine issues in a PR.
- If the branch already exists, work on it; don't recreate it.
- Run builds/tests from the branch checkout (uses the main `target/`).
- Rebase or merge `main` into a long-running branch rather than cherry-picking.
- Do not delegate to sub-agents for now; the session working the issue does the work itself in its branch.
- Remove the branch once the PR is merged. `git branch -a` shows what exists.

## Commits

Conventional Commits: `<type>(<scope>): <imperative summary>` (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`). Small, single-intent commits; behavior changes ship with their tests. Reference the issue (`#<n>`) in the PR, and in commits where useful.

## Local toolchain

Dev machine is Ubuntu 24.04 x86_64. Installed: Rust via rustup (stable, with clippy/rustfmt; run `. ~/.cargo/env` if `cargo` isn't on PATH), Node + npm, pnpm (global npm install; no corepack on Node 25), Docker, SQLite, Google Chrome, Xvfb/x11vnc. Not yet installed (need an interactive `sudo apt install`): `xdotool`, `openbox` (needed from E03/E04 desktop-input work), `podman` (optional). Test/build tooling such as nextest, an OpenAPI generator or a TS bundler is deliberately undecided until E00.1.

## Working with multiple agents

- Keep instructions in `AGENTS.md`; put only tool-specific notes in `CLAUDE.md` or `opencode.json`.
- Shared skills go in `.claude/skills/<name>/SKILL.md` (OpenCode also discovers this path; `name` must match the directory, lowercase-hyphenated). Don't duplicate them under `.opencode/skills/`.
- Slash commands/agents are not shared between tools (`.claude/commands` vs `.opencode/commands`); keep them thin and put real procedures in a skill or a script under `scripts/`.
- Agents work on separate branches (see above), so concurrent agents don't collide. `CLAUDE.md` and `AGENTS.md` are kept in sync by construction (`CLAUDE.md` only imports `AGENTS.md`); `node scripts/check-agent-sync.mjs` verifies it and runs in CI. Never paste `AGENTS.md` content into `CLAUDE.md`.

## Product in one paragraph

A portable, self-hostable computer-use runtime letting authorized AI agents operate real graphical browsers (initially Chrome on Linux) through an HTTP API, TypeScript SDK, CLI and MCP, with persistent profiles, human-in-the-loop (HITL) control, and OpenTelemetry. The Chrome extension must also work **standalone** as an AI browser assistant (built-in chat, provider/model settings, OpenAI-compatible providers) without a Hexactra server — a v1 requirement (§25).

## Architecture (see VISION.MD §5–§6, §18)

Three runtime domains: clients → Rust control plane → execution hosts.

- **Control plane** (Rust, Axum): identity/authz, policy, sessions, leases, HITL broker, durable audit/event store, artifact broker. Authoritative for everything.
- **Host agent** → **session worker** → **native messaging host** (all Rust) ↔ **Chrome MV3 extension** (TypeScript) in visible Chrome with a persistent profile. Worker↔native host over local IPC (Unix sockets); native host↔extension over Chrome Native Messaging.
- Clients (SDK/CLI/MCP/web UI) go only through the control plane API — never directly to Chrome debugging ports.
- Distribution changes topology, **not** client commands, session IDs, authorization rules, or behavior (control plane and host agent may be one process locally).

Design invariants to preserve when writing docs or code:

- Web pages, content scripts, memory recommendations and model output are **never** a source of authorization.
- Large artifacts move via short-lived authorized handles, not inside control messages.
- Telemetry (OTel) is not the audit trail; durable sanitized Execution Events are.
- Secret Material (passwords, OTPs, tokens) has stricter handling than ordinary task input (§11–§13).
- The public API must not be tied to Chrome or Linux; drivers are pluggable.
- The Agent Experience Framework (AEF) is an independent, optional product boundary that only consumes redacted outcomes (§17).

Planned monorepo layout (target, directories do not exist yet): Cargo workspace `crates/hexactra-{control,agent,worker,native-host,cli,mcp,core,telemetry}`, pnpm workspace `packages/{sdk,contracts}`, `apps/{chrome-extension,dashboard}`, `api/openapi.yaml` + `api/schemas/`, `deploy/`, `docs/`, `tests/`. Planned stack: Rust/Tokio/Axum/Clap/Serde/SQLite, React+TypeScript dashboard, OpenAPI-generated SDKs.

## Editing VISION.MD

- Keep the status banner honest: it's a vision/proposal, not a statement of shipped features.
- Section numbers are cross-referenced (e.g. "§25"); renumbering breaks references.
- Recent commits promoted AI control, the standalone extension, OpenAI-compatible providers and unattended remote launch to **v1 requirements** (§25, with §19–§20 milestones/definition-of-done). Keep those sections consistent when changing scope.
- Don't pin "latest" dependency versions in the vision; versions belong in lockfiles/implementation READMEs.
