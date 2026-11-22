# AGENTS.md

Shared rules for AI assistants working on this app (loaded by OpenCode, and by Claude Code through `CLAUDE.md`). Start at [README.md](README.md).

## What this repository is

An app on the published `@marinoscar/platform-*` packages, started from the platform starter. Stack: React 19 + MUI (web), NestJS 11 on Fastify + Prisma 7 + zod (API), PostgreSQL 16, the platform CLI, nginx same-origin, Docker Compose, Node 24.

## MANDATORY: never edit platform code here

The platform lives in `node_modules/@marinoscar/platform-*`. Never edit, patch, copy or vendor it, and never add `patch-package`, `npm link` or a `file:`/`workspace:` dependency on it: an app that edits its copy drifts from every other app, and `npm link` breaks the single-instance packages (Nest, React, MUI, zod). **Change it in the platform repository instead:** when a seam is missing, file a seam request with the platform's template (`https://github.com/marinoscar/EnterpriseAppBase/issues/new?template=seam_request.yml`), and work around it in this app's own code until the release that adds it.

Generated files are never hand-edited either: `apps/api/prisma/schema/` (`npm run db:compose`), the installed platform migrations recorded in `apps/api/prisma/platform.lock` (`npm run db:sync`), and the platform files under `infra/` recorded in `infra/platform-infra.lock.json` (`npm run platform:infra:sync`). `npm run platform:check` fails on any edit. Your own changes to the stack are overlays: `infra/compose/app.*.compose.yml`, `infra/compose/app.env.example`, `infra/nginx/app.d/`.

## Where things are

| What | Where |
|---|---|
| The platform's composition (every `forRoot()`, the host-port adapters, the seeded permissions) | `apps/api/src/platform/` |
| Which optional platform slices are mounted (storage, email, notifications, sharing, AI, backup, exports, onboarding, Android, telemetry) | `packages/shared/slices.json` `enabled` (read by the API and the web app); a slice is `apps/api/src/platform/<id>/` plus `apps/web/src/slices/<id>.tsx`; README, "Optional slices" |
| The sample feature (model, permission, settings namespace, job, Doctor check) | `apps/api/src/notes/`, `apps/api/prisma/fragments/notes.prisma` (the sharing slice's sample record: `apps/api/src/platform/sharing/documents/`, `prisma/fragments/documents.prisma`) |
| The routes and the two settings registries | `apps/web/src/App.tsx`, `apps/web/src/config/` (the core's cards; an optional slice's cards and routes are in `apps/web/src/slices/<id>.tsx`) |
| The CLI composition | `apps/cli/src/app.ts` |
| The identity (name, repository, CLI name, colours) | `packages/shared/identity.json`; rename with `scripts/rename.mjs` |
| Each package's documentation and extension-point catalog | [platform-api](https://github.com/marinoscar/EnterpriseAppBase/tree/main/packages/platform-api/src) (one README per slice), [platform-web](https://github.com/marinoscar/EnterpriseAppBase/tree/main/packages/platform-web/src), [platform-contract](https://github.com/marinoscar/EnterpriseAppBase/tree/main/packages/platform-contract), [platform-db](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-db/README.md), [platform-cli](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-cli/README.md), [platform-infra](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-infra/README.md) |

README, "Add your first feature" is the recipe for a model, permission, settings card, job and Doctor check, copying `apps/api/src/notes/`.

## Working with a small context window

- Read package READMEs by section: `grep -n '^#' <file>` for headings, then read with `offset`/`limit`.
- Locate code with `grep -rn` before opening a file; read only the files a task names plus their direct neighbours.
- Use one subagent at a time and hand it the section to read, not the whole document.

## MANDATORY: Agent run policies

A run's models and limits come from its agent policy ([README, Agent policies](README.md#agent-policies)). The rules below keep that true.

1. **Every browser-agent model call goes through the snapshot's resolved tiers.** The runner builds each call's provider, model, reasoning effort and output cap with `tierRequest(snapshot, tier)` (`apps/api/src/runner/tier-request.ts`), or `fallbackRequest` for a tier's fallback model. Never hard-code a model, never read `task.model` or `ai.defaultModel` in the runner, and never leave the model to the platform default for a `browser_agent` call.
2. **The runner reads only `runs.policy_snapshot`.** It never re-reads the policy row, the user's settings or the ceilings during a run: the snapshot (written once at the run's first step by `policySnapshot` in `runner/host/policy-snapshot.ts`) holds the spec, the effective budget and the resolved tiers.
3. **A new budget is added in two places together:** a nullable field in `budgetSchema` of `agentPolicySpecSchema` (`apps/api/src/policies/agent-policy.schema.ts`, with `BUDGET_LIMIT_KEYS`) and a key in `BudgetTracker` (`packages/hexactra-agent/src/budget.ts`, with `BUDGET_KEYS`, its stop reason and the ceilings schema). `null` always means unlimited, and every budget stop writes a typed `stop_reason`.
4. **Stall detection stays on for every policy, including Unlimited.** Do not add a way to switch it off. `stall.ts` keeps only digests, never typed text, secrets or images.
5. **A policy never widens the task's opt-ins** (allowed sites, confirmation before purchases) and never holds a secret. Built-ins are code in `builtin-policies.ts`: change a value by bumping its `version`.
6. **The export format is versioned** (`hexactra.agent-policies`, `formatVersion`): a change to the spec that older files cannot satisfy bumps `schemaVersion` and keeps the importer reading the old one.

## MANDATORY: The agent packages and the goal runner host

The agent harness and the browser toolset are workspace packages that the API **hosts** (E38.9, [decision record](docs/decisions/agent-packages.md), [docs/runner.md](docs/runner.md)): `@marinoscar/hexactra-agent` (`packages/hexactra-agent`, the generic harness) and `@marinoscar/hexactra-browser-agent` (`packages/hexactra-browser-agent`, the browser and desktop tools, the site and risk gates, vision). `apps/api/src/runner/` keeps only the host: the bindings of the ports, the app's own tool families and the job entry point.

1. **A new tool, gate or loop behaviour goes in a package, with its test in the package. The app only binds ports.** A tool for a console service (a provider, a mailbox, a memory) is the one exception and lives in `apps/api/src/runner/host/tools/`. `apps/api/test/architecture/no-agent-logic.spec.ts` fails when a tool, a gate or loop code comes back into `apps/api/src/`.
2. **The harness package never imports a framework, a database client, the fabric, a provider SDK, a platform package or console code.** It imports only itself, `zod`, `@opentelemetry/api` and `node:` built-ins, and reaches the outside through the ports of `@marinoscar/hexactra-agent/ports`. A test scans the built output (`packages/hexactra-agent/test/imports.spec.ts`). The browser toolset imports only the harness.
3. **A tool is a `RunnerTool`** (`defineRunnerTool`): one file per tool or small family, `execute(ctx, args)` returning the text the model reads, the step recorded through `ctx.record` (never a database call of its own). A tool imports **neither the loop nor another tool**. Every call goes through `executeTool`; nothing bypasses the gates or Stop.
4. **No change in behaviour hides in a move.** A prompt, a tool name or description, a step text or the order of the offered tools changes what the agent does: it needs its own issue, and `test/runner-characterisation.db.spec.ts` (tool list and schemas, the input of each round, fabric actions, step rows, the final run row) is updated deliberately and the diff read.
5. **A host proves its bindings** with `runHarnessHostConformance` (`@marinoscar/hexactra-agent/testing`); the console runs it in `apps/api/test/agent-host-conformance.db.spec.ts`. A change to a port or to a binding keeps it green.
6. **The apps import the packages' built output.** Run `npm run build:packages` (from `console/`) after `npm ci` and after any change in `packages/hexactra-*`; the root `build`, `typecheck` and `test` scripts do it first, CI runs `build:packages`, `typecheck:packages` and `test:packages` before the apps, and the API image builds them. `npm run check:package-pack` dry-runs `npm pack`; publishing is off.
7. **No runner file is over 400 lines**, and `goal-runner.service.ts` stays a thin service (under 250). Adding a tool: the checklist in [docs/runner.md](docs/runner.md#how-to-add-a-tool).

## MANDATORY: Knowledge Graph

The Knowledge Graph (epic E46, [owner guide](docs/knowledge-graph.md), [threat model](docs/security-kgraph.md), [decision record](docs/decisions/knowledge-graph.md)) learns a saved task's procedure from the owner's own runs and replays it. It is experimental and off by default at four levels (deployment, user, task, run; the run level is not yet offered on the start-run form or API, #794). The engine is the package `@marinoscar/hexactra-kgraph` ([README](packages/hexactra-kgraph/README.md)); the host is `apps/api/src/kgraph/` and `apps/api/src/runner/host/kgraph/`. A later change must keep:

1. **Off is byte-identical.** With the feature off at any level, `apps/api/test/runner-characterisation.db.spec.ts` passes unchanged: same instructions, tool list and schemas, round input, fabric actions, step rows and run row.
2. **New tables only.** Knowledge Graph data lives in new `kg_` tables (per-task and per-run settings keyed by `task_id` / `run_id`); no column of an existing table changes, and no existing route, response or MCP tool changes shape.
3. **A failure never fails a run.** An error in capture, compile, replay, check or repair is logged and counted, and the run continues with the agent loop.
4. **Nothing bypasses `executeTool`.** A replayed step runs through the same wrapper as a model-chosen call: Stop, Pause, the gates, the span and intent recording.
5. **The graph grants nothing.** The gates read the run's own limits, never the graph: no widened site, connection, recipient, secret or saved approval comes from it.
6. **Sensitive changes need the owner.** A change that adds or changes a send, a payment, a recipient, a site, an account or a credential is approved only by the owner, signed in, in the console.
7. **The package core imports no harness.** `@marinoscar/hexactra-kgraph` imports only itself, `zod`, `@opentelemetry/api` and `node:` built-ins; only `src/harness/` may import `@marinoscar/hexactra-agent` (a test scans the built output).

## MANDATORY: MCP tools

The console is an MCP server (`POST /api/mcp`). Hosted assistants (ChatGPT, Claude) sign in with OAuth and get only the scopes the owner ticked; personal access tokens and sessions keep every tool. Reference: [docs/mcp.md](docs/mcp.md); threat model: [docs/security-hosted-clients.md](docs/security-hosted-clients.md).

1. **One tool registry.** Every tool is an `McpTool` in `apps/api/src/mcp/mcp.tools.ts`; titles, scopes, annotations, schemas and card links are fields of it. Never keep a second list keyed by tool name outside the registry.
2. **A tool name is permanent.** Never rename or remove one; add. `apps/api/test/mcp-manifest.spec.ts` pins every name, hint and schema hash in `apps/api/test/__snapshots__/mcp-tools.json`.
3. **Every tool declares `title`, `scope`, `effect` (`read`, `write`, `destructive`) and `openWorld`.** A name is at most 64 characters and a description is narrow and accurate, with no instructions beyond what the tool does. No tool mixes reading and writing. A tool that needs no consent of its own still names the scope that offers it.
4. **Page-derived text is marked untrusted.** A result that carries text from a web page (page text, element labels, `browser_evaluate` values, tab titles, a run's answer and notes) starts with `UNTRUSTED_NOTICE` and sets `untrusted: true` (`apps/api/src/mcp/mcp.results.ts`).
5. **No tool returns a secret.** Not a token, a key, a handoff secret or the fabric token. Results pass the redaction in `mcp.redact.ts`, and the secret-egress test walks every tool for a personal access token and an OAuth app.
6. **Hosted callers never provide a secret.** `browser_type_secret` types what the owner entered on the signed-in console page; `inbox_answer` for an OAuth app refuses a secret and a high-risk confirmation (`answerable_here: false`). A card or tool links the owner to the console for a secret; it never collects one.
7. **Results respect the limits** (`apps/api/src/mcp/mcp.results.ts`): size, screenshots and the 220 s deadline for OAuth callers. Nothing long-running runs inline: a tool starts a queue job or a run and returns how to follow it (`run_wait`).
8. **A new tool is checked against the capability registry** (`packages/shared/capabilities.json`; a tool without a REST route behind it gets the route first, because tools call REST in-process) and, if it is new capability, has a row in [docs/parity.md](docs/parity.md).
9. **A new widget** (`apps/mcp-ui`) calls only the tools its bundle names in `scripts/check-bundle.mjs` (`WIDGETS`), makes no network request of its own, renders every string as text, and has no secret input ([docs/mcp-apps.md](docs/mcp-apps.md)).
10. **Update the manifest snapshot deliberately.** `UPDATE_MCP_MANIFEST=1 npx jest --config ./test/jest.config.js mcp-manifest` (from `apps/api`) rewrites the snapshot and the generated tables in `docs/mcp.md`; review the diff. Never hand-edit the text between the `mcp-scopes` and `mcp-tools` markers.
11. **The OAuth server and its scopes are the platform's.** The console only registers scopes and the protected resource (`apps/api/src/mcp/mcp.oauth.ts`, `mcp.scopes.ts`); a missing seam is an EnterpriseAppBase seam request.

## Platform invariants this app must still respect

The packages enforce these in their own code; your code must not undo them. `apps/api/test/conformance.spec.ts` (`runPlatformConformance()`) checks the first, third and fourth on every `npm test`.

1. **Every long-running activity is a queue job.** Anything that outlives the request or cron tick that started it is a registered `JobHandler` enqueued through `JobsService`. A `@Cron` only decides whether work is due and enqueues it (`enqueueHousekeepingJob`); a detached `void this.work()` or an `@OnEvent` that does I/O is a violation. A job declares `profile: { maxRuntimeMs, maxAttempts }` or takes the default. A job `type` string is permanent once jobs of it exist.
2. **AI.** Never import a provider SDK, never call AI from the browser, and never broker a key to a worker node: use the AI slice's `AiService.forUser(...)` server-side. AI jobs are server-only.
3. **Settings UI Pattern.** Every settings page is a card APPENDED to `apps/web/src/config/adminSections.tsx` or `userSettingsSections.tsx` (an optional slice declares its cards in `apps/web/src/slices/<id>.tsx`, composed into them, the Danger Zone staying last), rendered by the packaged `SettingsHub`; its `permission` is the exact string the API route enforces; a settings page is never a new tab on another page.
4. **Security by default.** Every route declares `@Auth()` (or a deliberate `@Public()`): there is no global guard. Validate every input with zod. A model with a foreign key to `User` is registered in the user-owned data registry with its purge and export policy, and read through `PrismaService.forUser(...)`.
5. **`notify()` after the commit.** A notification is sent after the triggering write commits, outside any `$transaction`.
6. **Environment variables.** Deployment secrets only (`infra/compose/.env.example` is generated: an app variable goes in `infra/compose/app.env.example`, then `npm run platform:infra:sync`). Storage, AI, SMTP and Web Push are configured at runtime in the admin UI and never get an environment variable. **Never add a commented `# KEY=value` line** to an `.env.example`: the CLI's env parser reads it as a declared variable and its conformance test fails.
7. **Migrations.** The platform's migrations are installed by `npm run db:sync` and never edited; yours are authored with `npm run prisma:migrate:dev` after them. The API never migrates on startup.

## Key commands

```bash
npm run setup                          # build the CLI and write infra/compose/.env
npm run platform:check                 # migrations, composed schema and infra fragments equal the packages'
npm run build:packages                 # the agent packages (packages/hexactra-*): first after npm ci; typecheck, test and build run it for you
npm run test:packages                  # their own tests; npm run check:package-pack dry-runs the tarballs
npm run typecheck                      # the packages and all three workspaces (or --workspace=api|web|cli)
npm test                               # API (with runPlatformConformance), web and CLI
npm run test:db --workspace=api        # real-Postgres tier (*.db.spec.ts)
npm run test:run --workspace=web       # Vitest, single run
npm run build
cd apps/api && npm run db:compose      # after editing a fragment in apps/api/prisma/fragments/; then prisma:generate
```

Run the dev stack with the Compose commands in README, "Run it". Use the `npm run prisma:*` scripts, never bare `npx prisma`.

## Commits

Conventional Commits (`<type>(<scope>): <summary>`), small and single-purpose, a behaviour change with its tests. Do not push or open a pull request unless asked.

**Version bump.** A pull request that changes what users get (a CLI command, a TUI screen, an API route, a page) bumps the console version in the same pull request:
- **Minor** for a new command or capability. **Patch** for a fix.
- **All four manifests together:** `apps/api`, `apps/web`, `apps/cli` and `packages/shared` `package.json`, plus `npm install --package-lock-only`. These are the files `hexactra deploy` bumps, so they never drift apart.
- **Why:** the installer shows the old and new CLI version, and `hexactra --version` is how people know they have a change. A deploy's own `chore(release): x.y.z` commit is a patch on top of that.
