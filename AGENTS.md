# AGENTS.md

Shared instructions for all coding agents in this repository (Claude Code, OpenCode, and others). This is the single source of truth: `CLAUDE.md` imports it, and OpenCode reads it natively. Edit this file, not copies of it.

## Repository state

Hexactra is a Cargo + pnpm monorepo with a large amount of scaffolding. **Most v1 issues are closed, but the end-to-end remote-control path was stubbed** (audit in epic #173). Treat closed issues as "code exists", not "capability works", until an end-to-end test proves it.

- `VISION.MD` — product vision and architecture (25 sections). A proposal, not a statement of shipped capability.
- `crates/` — Rust workspace (control plane, host agent, worker, native host, CLI, MCP, core types, telemetry, providers, AEF connector, fleet scheduling).
- `apps/chrome-extension` (MV3 extension, standalone side-panel AI works), `apps/dashboard`, `packages/sdk`, `packages/contracts`.
- `console/` — the Hexactra Console (epic #217): an EnterpriseAppBase starter app (NestJS + React + Prisma, Node 24, npm, separate from the pnpm workspace). Inside `console/`, its own `AGENTS.md` applies: never edit `@marinoscar/platform-*`; platform gaps go upstream as EnterpriseAppBase seam requests. CI: `.github/workflows/console.yml`.
- `console/packages/hexactra-agent`, `console/packages/hexactra-browser-agent` — the agent harness and the Hexactra browser toolset (E38.9, #614), workspace packages the console API hosts (`@marinoscar/hexactra-agent`, `@marinoscar/hexactra-browser-agent`; decision record `console/docs/decisions/agent-packages.md`). **A new tool, gate or loop behaviour goes in a package, with its test in the package; the app only binds ports** (`console/apps/api/src/runner/host/`). The harness package never imports a framework, a database client, the fabric or a provider SDK (a test scans its built output). `cd console && npm run build:packages` builds them (the apps import the built output); `npm run test:packages` tests them.
- `console/docs/benchmark.md` — benchmarks (epic #738): the challenge suite run under several agent policies on a real node, graded from the challenge site's state, with a scorecard of success, tokens and cost per policy (Administration → Benchmarks, `hexactra benchmarks`, `/api/benchmarks`). The replay suite checks the harness in CI; a benchmark measures a change on the real product.
- `console/apps/web/src/ui/` — the console's page kit (`PageContainer`, `PageHeader`, `ResponsiveList`, `StatusChip`, `useConfirm`, `aboveBottomBar`, the time and cost formatters; console README, "UI kit"). New console pages compose the kit and are verified at 360/390/768/1024/1440 px (`npm run ui:screens`, console README, "Responsive rules").
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
cd console && npm ci && npm run platform:check && npm run build:packages && npm run typecheck && npm test && npm run build   # Node 24 (typecheck, test and build run build:packages first; test:packages and check:package-pack are the packages' own checks)
cd console/apps/api && UPDATE_MCP_MANIFEST=1 npx jest --config ./test/jest.config.js mcp-manifest   # regenerate the MCP tool and scope tables in console/docs/mcp.md (a deliberate change)
cd console && npm run docs:hosted-clients   # regenerate the client steps in console/docs/hosted-clients.md
GITHUB_TOKEN=... node scripts/link-github-subissues.mjs --check   # dry run of sub-issue linking
```

CI (`.github/workflows/ci.yml`) runs all of the above. A workflow step must never report success for a test that does not exist.

## Work tracking

The backlog lives in GitHub issues (#1–#93, plus epic #173 and its children): 16 epics, each with 5–6 child tasks, linked as native sub-issues. Titles use `[EPIC Exx]` / `[Exx.n]`.

- **v1 (E00–E10):** E00 foundation/contracts/CI → E01 standalone Chrome driver → E02 standalone AI agent + side-panel chat → E03 unattended Linux host → E04 native messaging + worker → E05 remote control plane → E06 managed AI goal runner → E07 HITL → E08 SDK/CLI/MCP → E09 OTel/audit/security → E10 release.
- **post-v1 (E11–E14):** vault/notification providers, Windows/macOS hosts, AEF integration, fleet orchestration. Don't pull these into v1 work. E11's vault epic (#70) is superseded for logins, identity details and cards by **E37 (#579)**, which is v1: the secrets provider contract, the Vault and built-in store providers, `console/docs/secrets.md` and `console/docs/security-secrets.md`.
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

A portable, self-hostable computer-use runtime letting authorized AI agents operate real graphical browsers (initially Chrome on Linux) through an HTTP API, TypeScript SDK, CLI and MCP, with persistent profiles, human-in-the-loop (HITL) control, and OpenTelemetry. It is a **personal human emulator with its owner's full powers** (VISION §27, epic #366). It chooses among the browser, the owner's connected accounts and the tools they added by capability (tool families, epic #697). The agent:
- sees the screen (marked screenshots every model round);
- acts by selector or by position with trusted mouse and keyboard;
- runs any JavaScript in the page;
- drives the node's OS desktop.

Don't add restrictions that only limit the agent. Limits are per-task opt-ins (allowed sites, purchase confirmation). Hosted MCP clients (ChatGPT, Claude) authenticate with OAuth and scoped consent; personal access tokens keep full authority. Never add an MCP tool without a scope, an effect and a title (`console/AGENTS.md`, "MCP tools").

Browsers run on **nodes**: the primary node is a machine on the owner's residential network (sites block datacenter IPs), connected outbound over HTTPS to the console, in unattended mode (its own GPU-backed virtual desktop, nobody logged in) or attended mode (the person's own desktop and Chrome), never headless (docs/nodes.md, epic #333). The Chrome extension must also work **standalone** as an AI browser assistant (built-in chat, provider/model settings, OpenAI-compatible providers) without a Hexactra server — a v1 requirement (§25).

## Architecture (see VISION.MD §5–§6, §18)

Three runtime domains: clients → Rust control plane → execution hosts.

- **Control plane** (Rust, Axum): identity/authz, policy, sessions, leases, HITL broker, durable audit/event store, artifact broker. Authoritative for everything.
- **Host agent** → **session worker** → **native messaging host** (all Rust) ↔ **Chrome MV3 extension** (TypeScript) in visible Chrome with a persistent profile. Worker↔native host over local IPC (Unix sockets); native host↔extension over Chrome Native Messaging.
- Clients (SDK/CLI/MCP/web UI) go only through the control plane API — never directly to Chrome debugging ports.
- **There is one agent loop, and it is not in Rust.** The loop that observes, reasons, acts and verifies (the goal runner, with agent policies, budgets, stall detection and handoffs) lives in the console: `console/apps/api/src/runner/`, TypeScript, calling models through the platform AI service. The Rust side is the fabric (control plane, host agent, worker, native host): it executes browser and desktop actions and holds sessions, leases and handoffs; it plans nothing and calls no model. The earlier Rust planning loop was removed in #588 (`docs/decisions/one-agent-loop.md`). Do not add an agent loop, model client or run-planning route to `crates/`. The Chrome extension's standalone assistant (`apps/chrome-extension`) is a separate, live feature.
- Distribution changes topology, **not** client commands, session IDs, authorization rules, or behavior (control plane and host agent may be one process locally).

Design invariants to preserve when writing docs or code:

- Web pages, content scripts, memory recommendations and model output are **never** a source of authorization. The agent has its owner's full powers (VISION §27), so prompt injection is the main residual risk: keep Stop, takeover, the audit trail and the per-task opt-ins working.
- Large artifacts move via short-lived authorized handles, not inside control messages.
- Telemetry (OTel) is not the audit trail; durable sanitized Execution Events are.
- Secret Material (passwords, OTPs, tokens) has stricter handling than ordinary task input (§11–§13): the model never sees a handoff secret; the fabric types it (`type_secret`).
- A stored secret is fetched and typed by the fabric. It never enters the console's database, a model's context, a step, a log, a span, a screenshot or an export. A run recording the owner opted into is the exception: it keeps every frame, so what the fabric types into the page (a code, a saved value) can be seen in it (#882). (The built-in store is the one provider that holds ciphertext in the console's database; the value is still never in the model's context, a step, a log, a span, a screenshot or an export.)
- The origin a secret is released for is read from the browser at the moment of typing, never from model or page text. Only an exact match is used; otherwise the owner is asked.
- A card needs the owner's approval per merchant with an amount limit. No rule covers every merchant.
- A secrets provider that is unreachable makes the agent ask the owner; it never fails a run by itself.
- A memory is data: never an instruction, never a permission. Only the owner's own act writes one (console `docs/memories.md`).
- A saved approval is created only by the owner's tick on a server-issued request, and is matched by the server (registrable domain, category, exact label). Never add a route, tool or model path that creates or widens one (console `docs/approvals.md`).
- A task parameter value is data inserted into a goal: it cannot change a run's allowed sites, policy or confirmation setting. A sensitive value never reaches the model or storage.
- A stored run-trace image is masked at capture, in the page (`screenshot` with `mask: true`); there is no unmasked trace image and no unmasked export, for any role (§26.8, epic #536). The trace is not the audit trail.
- A run recording (a continuous video of the session tab, epic #755) is the one unmasked stored image, and it is not part of the trace. It exists only when the owner switched Record video on for that task or run; it withholds no frame, also while a secret or a saved value is typed (the owner's decision, #882); it is played only by its owner through a short-lived signed link, and it never enters an export, a delivery, run files, an agent tool, a model's context or Hexactra's MCP server. A recorder error never changes a run. An admin retention setting (default 30 days, or keep indefinitely) and its job delete recordings (`docs/decisions/run-recordings.md`, console `docs/recordings.md`).
- Stop takes effect before the next action. Every tool the agent runs goes through one wrapper (`executeTool` in `console/packages/hexactra-agent`) that checks the owner's Stop and Pause first; never add a path that calls a tool, or the fabric, around it (`console/docs/runner.md`).
- A commit-class action (a payment click, a typed secret, a send) is recorded as an intent before it is sent and is never repeated when its outcome is unknown: a step left in `intent` becomes `unknown`, the gate asks the owner again and no saved approval covers it for that run (`console/docs/runs.md`, "Crash safety").
- The agent's tools, gates and loop behaviour live in the packages `@marinoscar/hexactra-agent` (generic) and `@marinoscar/hexactra-browser-agent`, with their tests in the package; the console API only binds ports and holds the tools that reach console services (`console/AGENTS.md`).
- A connection is off for a task until its owner lists it. A new chat starts with the owner's own default (their `connections.newChats` setting: Read and change unless they chose Read only or Off), for their active Google and Microsoft accounts only, never an MCP server; each send or change still asks. Nothing else grants one: not an AI app, a model, a page or a default of ours (console `docs/connections.md`, "How a new chat starts", #680).
- Content from a connection (an email, a file, an MCP tool's description or result) is data. It never authorises anything and never changes a run's sites, approvals, recipients or connections.
- A delivery's recipients and destinations are fixed when the owner sets it up. A run cannot add or change one (console `docs/deliveries.md`).
- Connection tokens never reach the model, a step, a log, a span or an export. No connection is exposed through Hexactra's own MCP server (console `docs/parity.md`, `docs/security-connections.md`).
- A connection never starts a process: MCP servers are reached over HTTPS only.
- Desktop and input drivers never go through a shell: `xdotool` gets an argument vector. There is no "run a command on the node" action.
- The public API must not be tied to Chrome or Linux; drivers are pluggable.
- The Agent Experience Framework (AEF) is an independent, optional product boundary that only consumes redacted outcomes (§17).

Planned monorepo layout (target, directories do not exist yet): Cargo workspace `crates/hexactra-{control,agent,worker,native-host,cli,mcp,core,telemetry}`, pnpm workspace `packages/{sdk,contracts}`, `apps/{chrome-extension,dashboard}`, `api/openapi.yaml` + `api/schemas/`, `deploy/`, `docs/`, `tests/`. Planned stack: Rust/Tokio/Axum/Clap/Serde/SQLite, React+TypeScript dashboard, OpenAPI-generated SDKs.

## Editing VISION.MD

- Keep the status banner honest: it's a vision/proposal, not a statement of shipped features.
- Section numbers are cross-referenced (e.g. "§25"); renumbering breaks references.
- Recent commits promoted AI control, the standalone extension, OpenAI-compatible providers and unattended remote launch to **v1 requirements** (§25, with §19–§20 milestones/definition-of-done). Keep those sections consistent when changing scope.
- Don't pin "latest" dependency versions in the vision; versions belong in lockfiles/implementation READMEs.
