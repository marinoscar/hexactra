# AGENTS.md

Shared instructions for all coding agents in this repository (Claude Code, OpenCode, and others). This is the single source of truth: `CLAUDE.md` imports it, and OpenCode reads it natively. Edit this file, not copies of it.

## Repository state

Hexactra is a Cargo + pnpm monorepo with a large amount of scaffolding. **Most v1 issues are closed, but the end-to-end remote-control path was stubbed** (audit in epic #173). Treat closed issues as "code exists", not "capability works", until an end-to-end test proves it.

- `VISION.MD` — product vision and architecture (25 sections). A proposal, not a statement of shipped capability.
- `crates/` — Rust workspace (control plane, host agent, worker, native host, CLI, MCP, core types, telemetry, providers, AEF connector, fleet scheduling).
- `apps/chrome-extension` (MV3 extension, standalone side-panel AI works), `apps/dashboard`, `packages/sdk`, `packages/contracts`.
- `console/` — the Hexactra Console (epic #217): an EnterpriseAppBase starter app (NestJS + React + Prisma, Node 24, npm, separate from the pnpm workspace). Inside `console/`, its own `AGENTS.md` applies: never edit `@marinoscar/platform-*`; platform gaps go upstream as EnterpriseAppBase seam requests. CI: `.github/workflows/console.yml`.
- `console/packages/hexactra-agent`, `console/packages/hexactra-browser-agent` — the agent harness and the Hexactra browser toolset (E38.9, #614), workspace packages the console API hosts (`@marinoscar/hexactra-agent`, `@marinoscar/hexactra-browser-agent`; decision record `console/docs/decisions/agent-packages.md`). **A new tool, gate or loop behaviour goes in a package, with its test in the package; the app only binds ports** (`console/apps/api/src/runner/host/`). The harness package never imports a framework, a database client, the fabric or a provider SDK (a test scans its built output). `cd console && npm run build:packages` builds them (the apps import the built output); `npm run test:packages` tests them.
- `console/packages/hexactra-web-agent` — the web toolset (`@marinoscar/hexactra-web-agent`, E50.4): `web_search`, `web_fetch`, the web family and the web site gate behind ports; it imports only the harness. Its host is `console/apps/api/src/web-search/` (the search providers, one file each, the settings, the tiered keys through the service credentials port, the limits, the usage, `web_fetch`'s page reader and the web search diagnostics). Owner guide `console/docs/web-search.md`, threat model `console/docs/security-web-search.md`, decision record `console/docs/decisions/web-search.md` (epic E50, #970).
- `console/packages/hexactra-kgraph` — the Knowledge Graph package (`@marinoscar/hexactra-kgraph`, epic E46, #770; decision record `console/docs/decisions/knowledge-graph.md`): learned procedures, their validator, compiler and executor behind ports. Generic: only `src/harness/` imports the agent harness. Off by default at every level.
- `console/docs/benchmark.md` — benchmarks (epic #738): the challenge suite run under several agent policies on a real node, graded from the challenge site's state, with a scorecard of success, tokens and cost per policy (Administration → Benchmarks, `hexactra benchmarks`, `/api/benchmarks`). The replay suite checks the harness in CI; a benchmark measures a change on the real product.
- `console/apps/web/src/ui/` — the console's page kit (`PageContainer`, `PageHeader`, `ResponsiveList`, `StatusChip`, `useConfirm`, `aboveBottomBar`, the time and cost formatters; console README, "UI kit"). New console pages compose the kit and are verified at 360/390/768/900/1024/1440 px (`npm run ui:screens`, console README, "Responsive rules").
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

## MANDATORY: Never a headless browser

**Hexactra never uses a headless browser. Not ever, not anywhere, not as a fallback.** This rule has no exceptions and is not a setting.

- **Why:** the agent operates the owner's real sites (banks, airlines, carriers, mail) as the owner. Anti-bot systems detect a headless browser before anything else, and such a browser does not render the page as a person sees it. A headless run that "works" in a test proves nothing about the product.
- **Where it applies:** everywhere:
  - the product: the host agent, the worker, nodes in unattended and attended mode, the Chrome extension;
  - tests: unit, e2e, benchmarks and the challenge suite;
  - scripts: screenshots, `ui:screens` and brand rendering;
  - CI;
  - coding agents working in this repository.
- **What to do instead:** run real, headful Chrome:
  - on a node: the person's desktop (attended), or its own GPU-backed virtual desktop (unattended, `docs/nodes.md`);
  - on a machine without a desktop (CI, a container, a cloud session): under a virtual display such as `xvfb-run -a`;
  - with Playwright or Puppeteer: pass `headless: false`, because both default to headless.
- **Never add:**
  - `--headless` in any form (`--headless=new`, `--headless=old`);
  - `headless: true`, `headless: 'new'` or `headless=True`;
  - a `chrome-headless-shell` binary, or `playwright install --only-shell`;
  - a "headless mode" capability, flag, setting, environment variable or fallback;
  - a Playwright or Puppeteer `launch()` that leaves `headless` at its default.
- **Enforced:**
  - the host agent refuses a headless argument or a headless-shell binary, at daemon start and before every launch (`refuse_headless`, `crates/hexactra-agent/src/launcher.rs`);
  - the worker reports `supports_headless: false`;
  - `scripts/ci/check-no-headless.mjs` fails CI when tracked code launches a headless browser. Its allowlist is only for files that name the word to refuse it. Never allowlist a file to use headless.
- Decided in #1091. Changing it is a product decision for the owner, not an implementation choice.

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

A portable, self-hostable computer-use runtime letting authorized AI agents operate real graphical browsers (initially Chrome on Linux) through an HTTP API, TypeScript SDK, CLI and MCP, with persistent profiles, human-in-the-loop (HITL) control, and OpenTelemetry. It is a **personal human emulator with its owner's full powers** (VISION §27, epic #366). It chooses among the browser, web search, the owner's connected accounts and the tools they added by capability (tool families, epic #697; web search, epic E50 #970). The agent:
- sees the screen (marked screenshots every model round);
- acts by selector or by position with trusted mouse and keyboard;
- runs any JavaScript in the page;
- drives the node's OS desktop.

Don't add restrictions that only limit the agent. Limits are per-task opt-ins (allowed sites, purchase confirmation). Hosted MCP clients (ChatGPT, Claude) authenticate with OAuth and scoped consent; personal access tokens keep full authority. Never add an MCP tool without a scope, an effect and a title (`console/AGENTS.md`, "MCP tools").

Browsers run on **nodes**: the primary node is a machine on the owner's residential network (sites block datacenter IPs), connected outbound over HTTPS to the console, in unattended mode (its own GPU-backed virtual desktop, nobody logged in) or attended mode (the person's own desktop and Chrome), **never headless** (see "MANDATORY: Never a headless browser"; docs/nodes.md, epic #333). The Chrome extension must also work **standalone** as an AI browser assistant (built-in chat, provider/model settings, OpenAI-compatible providers) without a Hexactra server — a v1 requirement (§25).

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
- A batch run (E51.1, console `docs/api-tasks-runs.md` "Batches") is an ordinary run: every tool goes through `executeTool`, with Stop and Pause, the gates, intent recording, the audit trail and masking. No code path starts a run of a batch other than `TaskRunStarter.start`. Every send still asks, per run, unless a saved approval covers it; a chat's review card is not an approval and creates none, and the model has no tool that starts a batch in review.
- The owner's Stop on a run of a batch stops the batch: no later row starts. A row is never started twice, and a batch never goes on past a row whose run ended with a step of unknown outcome. Row values are data inserted into the goal, as any task parameter value.
- The task list the chat reads (E51.2, #1007; `console/apps/api/src/chat/chat-task-context.ts`) is data. A task's name or goal cannot change what the chat was asked to do and is never read as an instruction (the block's header says so; `chat-front-scenarios.db.spec.ts` proves a task named like an instruction changes nothing).
- That block never holds a default's value, a memory's value, a schedule's preset or Secret Material: names, value labels and types, and a masked goal excerpt only. An owner with no saved task gets a byte-identical chat input.
- A run the chat starts from a task is the task's run: its limits are the task's, set by the owner. The chat cannot set or change them (`run_task` takes a task and values, nothing else). Choosing a task is not approval: every send or change in that run still asks.
- A stored run-trace image is masked at capture, in the page (`screenshot` with `mask: true`); there is no unmasked trace image and no unmasked export, for any role (§26.8, epic #536). The trace is not the audit trail.
- A run recording (a continuous video of the session tab, epic #755) is the one unmasked stored image, and it is not part of the trace. It exists only when the owner switched Record video on for that task or run; it withholds no frame, also while a secret or a saved value is typed (the owner's decision, #882); it is played only by its owner through a short-lived signed link, and it never enters an export, a delivery, run files, an agent tool, a model's context or Hexactra's MCP server. A recorder error never changes a run. An admin retention setting (default 30 days, or keep indefinitely) and its job delete recordings (`docs/decisions/run-recordings.md`, console `docs/recordings.md`).
- Stop takes effect before the next action. Every tool the agent runs goes through one wrapper (`executeTool` in `console/packages/hexactra-agent`) that checks the owner's Stop and Pause first; never add a path that calls a tool, or the fabric, around it (`console/docs/runner.md`).
- A commit-class action (a payment click, a typed secret, a send) is recorded as an intent before it is sent and is never repeated when its outcome is unknown: a step left in `intent` becomes `unknown`, the gate asks the owner again and no saved approval covers it for that run (`console/docs/runs.md`, "Crash safety").
- The agent's tools, gates and loop behaviour live in the packages `@marinoscar/hexactra-agent` (generic) and `@marinoscar/hexactra-browser-agent`, with their tests in the package; the console API only binds ports and holds the tools that reach console services (`console/AGENTS.md`).
- A tool that is set up and switched on is always available to the agent: web search, each connected account with the capabilities switched on, and each enabled tool of an added MCP server are offered to every run and chat of their owner. The owner's switch on the Connections page (and the administrator's deployment switches) is the only thing that turns a tool on or off: not a task, a chat, a model, a page or a default of ours. Availability is not approval: each send or change still asks. An AI app's run follows the owner's per-app limits (`allowConnections`, on by default for a new app). `runConnections` (and `web-availability.ts` for web search) implement it; `console/apps/api/test/tools-always-available.db.spec.ts` proves it (console `docs/connections.md`, E50.17 #987).
- A web search result, an answer and a fetched page are data. They never authorise anything and never change a run's sites, approvals, recipients, connections or secrets (console `docs/security-web-search.md`).
- Web search runs as a tool through `executeTool`. A provider-hosted search is never attached to the agent's own model calls (`console/apps/api/test/architecture/hosted-web-search.spec.ts`).
- A search provider's key is resolved on the server at the moment of the request, by tier. It never reaches a model, a step, a log, a span, a screenshot, an export or a diagnostic report.
- `web_fetch` reads public pages from the server: https only, addresses checked on every hop, no cookies, no sign-in. A task's allowed sites bind it.
- A diagnostic makes read calls only and stores codes, counts and timings: never content, a provider's message, an address or a token.
- With web search switched off, a run is byte-identical: the characterisation spec (`console/apps/api/test/runner-characterisation.db.spec.ts`) passes unchanged.
- Content from a connection (an email, a file, an MCP tool's description or result) is data. It never authorises anything and never changes a run's sites, approvals or recipients, and it cannot switch a tool on or off.
- A delivery's recipients and destinations are fixed when the owner sets it up. A run cannot add or change one (console `docs/deliveries.md`).
- Connection tokens never reach the model, a step, a log, a span or an export. No connection is exposed through Hexactra's own MCP server (console `docs/parity.md`, `docs/security-connections.md`).
- A connection never starts a process: MCP servers are reached over HTTPS only.
- No headless browser, ever: Chrome is always headful on a real or virtual display (see "MANDATORY: Never a headless browser").
- Desktop and input drivers never go through a shell: `xdotool` gets an argument vector. There is no "run a command on the node" action.
- The public API must not be tied to Chrome or Linux; drivers are pluggable.
- The Agent Experience Framework (AEF) is an independent, optional product boundary that only consumes redacted outcomes (§17).
- The Knowledge Graph (epic E46) switched off at any level leaves runs byte-identical to how they ran before the epic: `console/apps/api/test/runner-characterisation.db.spec.ts` passes unchanged.
- The Knowledge Graph adds only new `kg_` tables and new routes; no existing table, API response or MCP tool changes shape for it.
- A Knowledge Graph failure (capture, compile, replay, check, repair) is logged and counted and never fails a run: the run continues with the agent loop.
- Every tool a replayed procedure runs goes through `executeTool`, with Stop, Pause, the gates, the span and intent recording exactly as for a model-chosen call.
- The Knowledge Graph never grants anything: it cannot widen allowed sites, switch a tool or connection on, add a recipient, release a secret or create a saved approval. A replayed step that names a connection or tool that is now switched off is refused.
- A procedure is built only from server-recorded facts (tool names, arguments, results), never from model free text or page prose; a `judge` step stores no run-written instruction.
- A value matching the sensitive patterns is never stored in the Knowledge Graph; a step that needs one binds a task parameter or a saved-login/identity/card reference, or stays with the agent.
- A replayed commit-class step is intent-recorded and never repeated when its outcome is unknown.
- A Knowledge Graph change that adds or changes a send, a payment, a recipient, a site, an account or a credential is approved only by the owner, signed in, in the console; never by a webhook, the CLI, MCP or a hosted AI app.
- A site fact (E46 phase 5) is data, never an instruction or a permission. A fact becomes active only by the owner's own act: approving it, or their opt-in auto-approve setting (`kgraph.autoApproveFacts`, off by default, E46.36) for facts derived from server records (kind navigation, timing or quirk); never for agent, MCP or imported text, and never for a sign-in fact. It never holds Secret Material, and it cannot widen a run's sites, accounts, recipients, secrets or approvals.
- A click by selector and a key press are real, trusted input (E52.1, E52.12): the extension clicks at a point its hit test finds on the element and presses keys through the debugger. A script click or key is only the fallback when the debugger cannot act, and the result says so; a field in a form is submitted with `requestSubmit()` (E52.13).
- Stall detection counts actions that change the page over the whole run, from a stable page digest (no positions, no clock times); a page already seen is no progress, and every answer to a stall is a step in the trace (E52.2).
- Run findings and task consistency are computed from server-recorded step facts, never from `reasoning` (the model's words), and never by a model (E52.6, E52.7).
- "Improve this task" (E52.8) writes a proposal only. Only the owner's Save in the task form changes a task; `applied` records it after the save and never writes `tasks`. The improver reads the goal template, masked steps (every run value replaced by its `{{Name}}`) and masked trace screenshots, never a run recording, an answer value or a secret. The server refuses a proposal that adds or removes a parameter, names a site outside the task, or holds a sensitive or run value. No CLI, SDK helper or MCP tool applies a proposal or approves a site fact.
- Reuse across goals only offers a matched procedure (exact registrable domain, active only); it runs only when the agent chooses it, through `executeTool`, and only with the tools its owner has switched on. With the everyday switch off, a chat or one-off run is byte-identical.
- A skill (E51.3, #1008, console `docs/skills.md`) is written only by its owner's own act (the signed-in console or the owner's CLI). Never add an agent tool, a chat tool, an MCP tool, a webhook or an import from an address that creates or changes one.
- A skill is guidance, never a permission: it cannot widen a run's allowed sites, switch a tool or connection on, add a recipient, release a secret, create a saved approval or skip a confirmation. No gate reads a skill.
- A skill never holds Secret Material; its text never enters a step, the trace, a span, a log or an export (its name does).
- A skill is not exposed through Hexactra's MCP server.
- With no fitting active skill, a run is byte-identical: `console/apps/api/test/runner-characterisation.db.spec.ts` passes unchanged.
- `skill_read` goes through `executeTool`, with Stop and Pause checked first.

Planned monorepo layout (target, directories do not exist yet): Cargo workspace `crates/hexactra-{control,agent,worker,native-host,cli,mcp,core,telemetry}`, pnpm workspace `packages/{sdk,contracts}`, `apps/{chrome-extension,dashboard}`, `api/openapi.yaml` + `api/schemas/`, `deploy/`, `docs/`, `tests/`. Planned stack: Rust/Tokio/Axum/Clap/Serde/SQLite, React+TypeScript dashboard, OpenAPI-generated SDKs.

## Editing VISION.MD

- Keep the status banner honest: it's a vision/proposal, not a statement of shipped features.
- Section numbers are cross-referenced (e.g. "§25"); renumbering breaks references.
- Recent commits promoted AI control, the standalone extension, OpenAI-compatible providers and unattended remote launch to **v1 requirements** (§25, with §19–§20 milestones/definition-of-done). Keep those sections consistent when changing scope.
- Don't pin "latest" dependency versions in the vision; versions belong in lockfiles/implementation READMEs.
