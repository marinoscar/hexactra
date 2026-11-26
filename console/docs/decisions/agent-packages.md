# Decision record: the agent harness and the browser toolset are packages

Issue #614 (E38.9, epic #580). Owner's decision (2026-11-19): follow the packages-first architecture that EnterpriseAppBase and Vault use, starting with the agent harness. This record is written before the code moves, from the layering that #586 (E38.5) built (`apps/api/src/runner/{harness,browser,host}/`, ports and fakes, a characterisation spec) and from Vault's `docs/decisions/0001-packages-first.md` and `docs/PACKAGES.md`.

## Decision

The goal runner splits into two workspace packages and a host.

| Package | Folder | What it is |
|---|---|---|
| `@marinoscar/hexactra-agent` | `packages/hexactra-agent` | The generic agent harness: the loop, the tool registry, the one wrapper around every tool call, the gate pipeline, checkpoints and crash recovery, budgets, stall detection, the question interface, tracing hooks. Knows nothing about browsers, the fabric, Prisma or NestJS. |
| `@marinoscar/hexactra-browser-agent` | `packages/hexactra-browser-agent` | The Hexactra browser toolset on top of the harness: the browser and desktop tools, screenshots and marks, the site and risk gates, the browser instructions, a `BrowserPort`. |
| the host | `apps/api/src/runner/host/`, `goal-runner.service.ts` | Bindings of every port to console services, the app's own tool families, the job entry point. |

## Names and scope

`@marinoscar/hexactra-agent` and `@marinoscar/hexactra-browser-agent`, under `console/packages/`, matching Vault's `@marinoscar/vault-*` convention and the scope the platform packages are published under. The `@hexactra/*` scope of the repository's root packages is for the pnpm workspace (SDK, contracts, extension); the console is a separate npm workspace on the `@marinoscar` platform, so its domain packages sit with the platform's.

**The web toolset (E50.4, #974).** `@marinoscar/hexactra-web-agent` (`console/packages/hexactra-web-agent`) holds `web_search`, `web_fetch`, the web family with its research how-to, the `web_site` gate and the `WebSearchPort` and `WebFetchPort` it reaches the web through (`docs/decisions/web-search.md` §1). It is a third toolset beside the browser's, not a part of it: a run can have the web tools without a browser, and the browser toolset does not grow a dependency on search providers. It follows the same rules: CommonJS, built before the apps, imports only the harness, `zod` and `node:` built-ins (its own `test/imports.spec.ts` scans the built output), a tool imports no other tool and no loop code, and the host binds the ports (the search provider registry and the server-side page reader are console code, E50.5 and E50.6). It takes the allowed-sites predicate through `ctx.ext.web.sites` rather than importing the browser package, and the sensitive patterns through the harness's `PolicyPort.mask`. The cleaner of third-party text (`sanitizeText`) moved from the console's MCP text into the harness unchanged, so both clean the same way.

## Is the generic harness EnterpriseAppBase's?

It depends only on `zod`, `@opentelemetry/api` and ports a host implements, and is not Hexactra-specific. **Recommendation: build and prove it here first; propose moving it upstream once a second app uses it.** Today it has one real host (the console) and a second, minimal one in its own tests (`test/second-host.spec.ts`), which proves it is embeddable, not that its ports are right for an app that is not a browser agent. Moving it earlier would freeze the ports on one use. The move is a copy of a folder plus a rename, because the package imports nothing of the console; nothing here blocks it. This issue does not wait on it, and the packages state "experimental until a second host uses it".

## What is generic and what is not

Decided file by file from the #586 layout.

| From (`runner/`) | To | Why |
|---|---|---|
| `harness/*` (types, run-context, create-context, run-loop, outcomes, execute-tool, gate-pipeline, registry, tool-def, steps, budget, cost, stall, stall-policy, tiers, reconcile, intent, input-builder, instructions, activity, active-time, moments, redact, outcome-text, text, time, loop-profile, model-call, `ports/*`) | `@marinoscar/hexactra-agent` `src/` | Imports only itself, `zod`, `@opentelemetry/api`, `node:`. Already enforced by `runner-layering.spec.ts`. |
| `harness/testing/*` (fakes, `ScriptedModel`, `fakeRun`) | `@marinoscar/hexactra-agent/testing` | Shipped with the package, as Vault ships `./testing`. Gains `fakePolicy`, `fakeHarnessHost` and `runHarnessHostConformance`. |
| `browser/tools/*`, `browser/act.ts`, `click-through.ts`, `page.ts`, `request-human-spec.ts` | `@marinoscar/hexactra-browser-agent` | Browser and desktop tools. Import only the harness. |
| `browser/gates/{site-gate,risk-gate}.ts`, `browser/policy.ts` | `@marinoscar/hexactra-browser-agent` | The site and risk gates (#550) and the target classification; plug into the harness's `Gate` interface. |
| `browser/{vision,round,context,context-settings,instructions,browser-port}.ts` | `@marinoscar/hexactra-browser-agent` | Screenshots, marks, the screenshot window, the browser instructions, the `BrowserPort` over the fabric session. |
| `browser/testing/fake-browser.ts` | `@marinoscar/hexactra-browser-agent/testing` | The scriptable fake site (`FakeBrowser`) and a browser context over the harness fakes. |
| `host/*` ports: `prisma-run-store`, `model-port`, `question-port`, `control-port`, `approvals-port`, `policy-port`, `events-port`, `pictures-port`, `fabric-browser` | stays in `apps/api` | These are the bindings: they are the point of the split. |
| `host/tools/*` (saved logins, identity details, cards, `propose_memory`, `propose_saving_login`) | stays in `apps/api` for now | Tools, but they call console services (secrets providers, approvals, memories, the question broker, the fabric client). A package may not import those. Moving them needs a `SecretsPort` and a `MemoryPort`; a follow-up. `no-agent-logic.spec.ts` lets `defineRunnerTool` appear only here. |
| `goal-runner.service.ts`, `lease.ts`, `stop-signal.ts`, `agent-trace.ts`, `trace*.ts`, `fabric-session.ts`, `saved-*.ts`, `tier-request.ts` | stays in `apps/api` | The NestJS service, the lease over `runs.worker_token`, the stop signal over the event bus and the flag, the OpenTelemetry binding, the fabric client wrapper: host code. |
| `chat/chat-turn.service.ts` (the chat orchestrator) | stays | See below. |

The connection tools (#604, #606, not yet merged) are not browser tools. They go in their own package or stay in the app; that is decided when they land, against this record.

## Ports

The harness reaches the outside through `Ports` (`src/ports/`). The set is the one #586 built (`ModelPort`, `RunStorePort`, `QuestionPort`, `ControlPort`, `ApprovalPort`, `PolicyPort`, `EventsPort`, `TelemetryPort`, `PicturePort`, `ClockPort`, `IdPort`), kept as it is: a move changes no signature. Two differences from the issue's table, both deliberate:

- `TelemetryPort` stays required, as #586 wrote it, and the package exports `noopTelemetry`; a default over the OpenTelemetry API would change what the loop records and is a separate change.
- There is no `RunStorePort.load`: a run's state is read by the host before the loop starts (`host/start.ts`) and handed to `createRunLoop` as the memory and the counters. The loop only writes.

The browser toolset adds `BrowserPort` (`act`, `typeSecret`, `capture`, `captureTrace`), bound by the host to the run's fabric session.

## Module format and build

Following Vault's choices for an API package: **CommonJS** (`"type": "commonjs"`), `tsc -p tsconfig.build.json` to `dist/`, `dist/` git-ignored, `exports` map with `types` and `default` conditions, `files: [dist, README.md, CHANGELOG.md, LICENSE]`. The apps import the **built output**, so `npm run build:packages` runs before the apps' build, typecheck and tests (root `build`, `typecheck` and `test` call it first; CI runs it as a step of its own). The harness is built before the browser toolset, which depends on it. Relative imports are extensionless (NodeNext over a CommonJS package), like `apps/api`.

## Versioning and release

Both packages start at `0.1.0-next.0` and are versioned together. **Publishing is prepared and left off**: `npm run check:package-pack` (a dry run of `npm pack`) checks each tarball holds `dist/`, `README.md`, `LICENSE` and nothing else (no tests, no fixtures, no sources), and runs in CI. The Changesets configuration Vault uses (`fixed` group, `privatePackages` untouched) is added with publishing disabled; turning it on is a separate decision and a follow-up issue. The packages are `0.x` and say in their READMEs that they are experimental until a second host uses them.

## The chat orchestrator

`chat/chat-turn.service.ts` is a second, small agent: a model, a few tools, a Stop. It does **not** move onto the harness. It has no run, no steps, no checkpoint, no lease, no budgets and no crash recovery, which are what the harness is: it would bind a `RunStorePort` to nothing and stub most ports. It talks to the model through `AiService.runTools` directly with `AiDefinedTool`s. A follow-up issue records the idea (a chat turn as a one-chunk loop) for when the harness has a second real host; until then moving it would add ports without adding a guarantee.

## The rules the packages enforce

- The harness package imports only `zod`, `@opentelemetry/api` and `node:` built-ins. A test scans the **built output** and the sources and fails on `@nestjs/*`, `@prisma/*`, a provider SDK, a platform package, the fabric client or any path outside the package (`test/imports.spec.ts`).
- The browser package imports the harness and nothing else; a tool imports no other tool and no loop code; a gate imports no loop code (same scan).
- The app holds no agent logic: `apps/api/test/architecture/no-agent-logic.spec.ts` fails when a tool, a gate or loop code comes back into `src/`.
- A host proves its bindings with `runHarnessHostConformance`: a checkpoint survives a simulated crash, the worker token excludes a second job, a Stop is seen before the next tool, a question's answer is delivered once. The console runs it over its real bindings (`test/agent-host-conformance.db.spec.ts`); the package runs it over its in-memory host.

## Behaviour does not change

The characterisation snapshots of #586 (tool list and schemas, the model input of each round, the fabric actions, the step rows, the final run row) are the gate and are not edited. No prompt text, tool name, step text, route or database column changes. The old module paths of the pure helpers (`runner/budget.ts`, `stall.ts`, `cost.ts`, `reconcile.ts`, `policy.ts`, `vision.ts`, ...) stay as one-line re-exports of the packages, so no import elsewhere in the app, and no existing spec, changes.

## What this leaves for follow-ups

- Move the secrets tool families into the toolset behind `SecretsPort` and `MemoryPort`.
- The scenario suite and the shared test kit of #587 into `./testing` (when #587 lands).
- Turn publishing on (Changesets release workflow, npm provenance).
- Propose the harness to EnterpriseAppBase once a second app uses it.
- The chat orchestrator on the harness, if it grows a run.
