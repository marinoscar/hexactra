# Hexactra Console

Assign work to AI browser agents and watch them do it.

[![CI](https://github.com/marinoscar/hexactra/actions/workflows/console.yml/badge.svg)](https://github.com/marinoscar/hexactra/actions/workflows/console.yml)

This app was started from the platform starter. The platform (sign-in, users and organizations, settings, the job queue, the admin Doctor, the CLI, the Compose and nginx stack) comes from the published `@marinoscar/platform-*` packages. This repository holds only what is yours: the composition (`apps/api/src/platform/`, `apps/web/src/App.tsx`, `apps/cli/src/app.ts`), your domain code, and your appearance.

**Never edit platform code here.** There is none to edit: it lives in `node_modules`. When the platform lacks a seam you need, ask for it upstream with a [seam request](https://github.com/marinoscar/EnterpriseAppBase/issues/new?template=seam_request.yml); see [Changing the platform](#changing-the-platform).

## What the console adds

The console drives the **Hexactra Fabric**: the Rust control plane and its browser hosts (`../crates`, `../docs/remote-control-api.md`). Every capability is a REST operation, and lives on the web, CLI, TUI and MCP surfaces unless [packages/shared/capabilities.json](packages/shared/capabilities.json) says why not. That file is the parity registry: each surface's tests fail when a capability it names is missing there, or when a REST operation, command or MCP tool belongs to no capability.

| Capability | Web | API | CLI / TUI | Permission |
|---|---|---|---|---|
| Fabric connection (URL and `hxs_` service token, stored encrypted; Doctor checks `fabric.*`) | Administration → Fabric connection | `GET/PUT/DELETE /api/fabric/connection`, `POST …/test` | `hexactra fabric show\|set URL --token-stdin\|test\|clear --yes` | `fabric_config:read` / `:write` |
| Tasks: saved goals with a profile, optional allowed sites, step and time budgets, opt-in confirm-before-purchase | `/tasks` | `/api/tasks` | `hexactra tasks list\|create\|update\|run [--watch]\|delete` | `tasks:read` / `tasks:write` |
| Runs: the AI goal runner (`browser.goal.run` job): steps, handoffs, cancel | `/runs`, `/runs/:id` | `/api/runs`, `POST /api/tasks/:id/runs`, `POST /api/runs/:id/cancel` | `hexactra runs list\|start\|show\|watch\|cancel` | `runs:read` / `runs:write` |
| Inbox: what agents wait for (CAPTCHA, code, sign-in, confirmation); answers resume the run | `/inbox` | `GET /api/inbox`, `POST /api/inbox/:runId/respond` | `hexactra inbox list\|answer RUN --done\|--value\|--choice\|--secret-stdin\|--decline`; TUI **Agent ▸ Inbox** | `runs:read` / `runs:write` |
| Questions: an agent asks its user a typed question (text, choice, multi-choice, number, confirm, none, takeover; a secret only in a browser session) and waits for the typed answer; the person answers on any channel, the first answer wins ([docs/questions.md](docs/questions.md)) | `/inbox`, `/inbox/q/:id` | `/api/questions`, `POST /api/questions/:id/answer\|cancel\|answer-by-token` | `hexactra questions ask\|list\|show\|answer`; TUI **Agent ▸ Inbox** | `runs:read` / `runs:write` |
| Live run view: steps over SSE, live screenshot, take over | `/runs/:id` | `GET /api/runs/:id/stream\|screenshot\|viewer` | `hexactra runs watch`; TUI **Agent ▸ Runs** | `runs:read` |
| External agents: a browser session through the console, recorded as a run (trigger `external`); the user sees each step, can stop it, and answers its handoffs | `/runs` | `POST /api/browser/sessions`, `…/:runId/actions\|handoffs\|artifacts/:id`, `DELETE …/:runId` | via MCP | `runs:read` / `runs:write` |
| MCP server for agent frameworks: delegate goals or drive browsers, with every call going through the REST API as the user ([docs/mcp.md](docs/mcp.md)) | — | `POST /api/mcp` (Streamable HTTP) | `hexactra mcp serve` (stdio) | the tools' routes |
| Fleet: hosts, enrollment, drain, revoke, profiles | `/fleet` | `/api/fleet/…` | `hexactra fleet hosts\|enroll\|drain\|undrain\|revoke\|commands`, `hexactra fleet profile create\|delete\|restart\|close`; TUI **Agent ▸ Fleet** | `fleet:read` / `fleet:write` |
| Remote desktop of a host: a viewer session bound to the host, the person and the organization; every connect re-checks the permission (docs/nodes.md) | `/fleet/hosts/:id/desktop` (Fleet → Open desktop) | `POST/DELETE /api/fleet/hosts/{id}/viewer-session` | `hexactra fleet desktop <host>`; TUI **Agent ▸ Fleet** key `o` | `fleet:desktop` |
| Take over a host's desktop: the agent's next steps wait until you release it; keyboard and mouse pass only while you hold the lease | Desktop page **Take over** / **Release** | `/api/fleet/hosts/{id}/takeover` (GET, POST, renew, DELETE) | `hexactra fleet takeover\|release <host>` | `fleet:desktop` |
| Alerts: a browser host offline (or the fabric unreachable), a schedule failing 3+ runs in a row, a user's runs over their token or budget limits; incidents fire, notify the holders of `alerts:read` (and `alerts.alert.*` webhooks) and resolve on their own | Administration → Alerts | `/api/admin/alerts/…` (the platform slice) | — | `alerts:read` / `alerts:write` |

Run it all on a VPS (console, fabric and an optional browser host in one stack): [docs/runbooks/vps-stack.md](docs/runbooks/vps-stack.md). Run the browsers on **nodes** at home, which keep a residential IP and connect outbound over HTTPS: [../docs/nodes.md](../docs/nodes.md).

**The goal runner**:
- It uses the AI slice: feature `browser_agent`, a model with `tools`. Configure a provider at Administration → AI.
- The model never sees secrets: codes and passwords come from handoffs, and the fabric types them into the page (`type_secret`); the console never holds them.
- Steps store redacted arguments only.
- It works like a person at the computer, with your full powers (VISION §27, epic #366):
  - every model round starts with a screenshot of the page, with the interactive elements numbered;
  - it acts by selector, by mark or by position, with trusted mouse and keyboard;
  - it runs JavaScript in the page;
  - it uses the node's desktop for native dialogs and file pickers.
  A model without vision keeps working from the page's text and elements.
- New tasks get 100 steps and 30 minutes, and no confirmation before purchases. Two limits are opt-in per task: an allowed-sites list, and "Ask me before purchases".

The CLI's commands use the login from `hexactra login`, or `HEXACTRA_SERVER_URL` and `HEXACTRA_TOKEN`. Install it with one `curl | bash` line; the terminal UI groups its screens into Agent, Worker, Server, Developer and Account; the guide, with screenshots, is [apps/cli/README.md](apps/cli/README.md).

## Layout

```
apps/api/          NestJS API: src/platform/ binds the packages (slices/ + one folder per optional slice), src/notes/ is the sample feature
  prisma/          fragments/ (your models), schema/ (GENERATED), migrations/, platform.lock, seed.ts
apps/web/          React app: App.tsx (routes, the packaged shell), slices/ (one file per optional slice), config/ (the two settings registries, the navigation), theme.ts, pages/
apps/cli/          the CLI: createCli() with this app's identity
packages/shared/   identity.json: the ONE identity source (name, repository, CLI name, colours); slices.json: the ONE slice manifest
infra/             platform fragments GENERATED by platform-infra sync, plus your app.* overlays
scripts/rename.mjs rebrand this app (identity.json plus the few literal targets)
```

## Run it

Needs Node 24 and Docker.

```bash
git clone https://github.com/marinoscar/hexactra.git
cd hexactra
npm install
npm run setup                    # builds the CLI and writes infra/compose/.env
docker network create devnet     # once per host
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml up
```

Then, with the same `-f` files, migrate and seed (the API never migrates on startup):

```bash
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml exec api npm run prisma:migrate
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml exec api npm run prisma:seed
```

Three values nothing can generate go in `infra/compose/.env`: `INITIAL_ADMIN_EMAIL` (your Google account; it is always allowed in and becomes the administrator), `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The application is at http://localhost:3535.

Checks, as CI runs them (`.github/workflows/ci.yml`):

```bash
npm run platform:check     # installed migrations, composed schema and infra fragments equal the packages'
npm run typecheck
npm test                   # API (with runPlatformConformance), web and CLI
npm run build
npm run test:db --workspace=api   # the whole app against a migrated, seeded PostgreSQL
```

## Add your first feature

`apps/api/src/notes/` is a complete feature in seven small files. Copy its shape; each step below names the package documentation it follows.

1. **A model.** Write it in `apps/api/prisma/fragments/<feature>.prisma`, with an `extend model User { ... }` block for the back-relation, then:

   ```bash
   cd apps/api
   npm run db:compose                                    # platform fragments + yours -> prisma/schema/
   npm run prisma:generate
   npm run prisma:migrate:dev -- --name add_<feature>    # your migration sorts after the installed ones
   ```

   A model with a foreign key to `User` is registered in the user-owned data registry with its purge and export policy, and classified in the model ownership registry (`notes.ownership.ts`, registered after the platform's own models by `src/platform/registrations.ts`); the conformance suite, which checks the whole composed schema, fails until it is. Catalog: [`platform-db` extension points](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-db/README.md#extension-point-catalog), [scoped data access](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/core/README.md#extension-point-catalog).
2. **A permission.** Declare it as data (`notes.permissions.ts`), add the map to `app.permissions` in `src/platform/permissions.ts` (the registry and the seed both read it, after the platform's), and put `@Auth({ permissions: [...] })` on every route: there is no global guard, so a route without `@Auth()` is public. Validate every body with zod (`notes.schemas.ts`). Catalog: [identity](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/identity/README.md#extension-point-catalog).
3. **A settings namespace and its card.** Register the namespace before `SettingsModule.forRoot()` (`notes.settings.ts`); append its card to `apps/web/src/config/adminSections.tsx` or `userSettingsSections.tsx` with the exact permission string its route enforces. Never add a settings page as a tab of another. Catalog: [settings (API)](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/settings/README.md#extension-point-catalog), [settings (web)](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-web/src/settings/README.md#extension-point-catalog).
4. **A job.** Anything that outlives a request is a registered job handler (`notes-archive.job.ts`); a `@Cron` only decides whether work is due and enqueues it. A job `type` is permanent once jobs of it exist. Catalog: [jobs](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/jobs/README.md#extension-point-catalog).
5. **A Doctor check.** One read-only provider that registers itself (`notes.doctor-check.ts`); it appears at `/admin/settings/doctor`. Catalog: [doctor](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/doctor/README.md#extension-point-catalog).

Then add the module to `apps/api/src/app.module.ts`, its page to `apps/web/src/App.tsx`, and tests beside the notes ones.

## Optional slices

The core is always mounted: the API host (the event bus, the platform's app metrics, maintenance mode at `/api/admin/maintenance`, the `{ data }` envelope, request ids, the API reference at `/api/docs`: [host](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/host/README.md)), identity, settings, worker-node credentials, jobs, the Doctor and the data resets (the user Danger Zone at `/settings/danger-zone`, the admin factory reset and organization offboarding: [user-data](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/user-data/README.md)). Everything else the platform ships is an **optional slice**, and **which slices this app mounts is one list**: `enabled` in [`packages/shared/slices.json`](packages/shared/slices.json). The API and the web app both read it, so they cannot disagree.

| Slice | What you get | Requires | Notes |
|---|---|---|---|
| `credentials` | The encrypted credential store (deployment, user and organization tiers) | none | No pages. Needs `SECRETS_ENCRYPTION_KEY`. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/credentials/README.md) |
| `storage` | Uploads (`/api/storage`), profile pictures (Profile page), the storage admin page | `credentials` | Bucket, region and key are set at `/admin/settings/storage`, never in `.env`. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/storage/README.md) |
| `email` | SES and SMTP transports, templates, the email settings page | `credentials` | Set at `/admin/settings/email`. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/email/README.md) |
| `notifications` | The bell and live inbox, preferences, email delivery, **Web Push**, admin broadcasts; the identity notices stop being log lines | `email` | Web Push: an administrator generates a VAPID key pair at `/admin/settings/push`; the service worker is `apps/web/src/sw.ts`, served at `/sw.js`. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/notifications/README.md) |
| `sharing` | Groups, members, invites, grants, link shares and the public `/s` page, and a sample shareable record (`/api/documents`) | `notifications` | A shareable record belongs to an organization, so the sample is a `Document`, not the personal `Note`; the README has the other shapes. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/sharing/README.md) |
| `ai` | The provider gateway (keys at three tiers, models, usage) and its admin and key pages | `credentials`, `storage` | Off until an administrator enables it at `/admin/settings/ai`. Server-side only. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/ai/README.md) |
| `db-backup` | Scheduled and on-demand `pg_dump` to object storage, retention, a guarded restore | `storage`, `notifications` | Needs a direct database connection (no transaction-mode pooler); the API image carries the pinned client. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/db-backup/README.md) |
| `exports` | Signed, expiring exports of a user's or an organization's data | `storage`, `notifications` | The sample feature's notes source is the example. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/exports/README.md) |
| `onboarding` | The welcome dialog, Get started, the administrator's Setup guide, activation metrics | none | A step shows only when the page it links to exists in the enabled slices. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/onboarding/README.md) |
| `android-app` | Trusted-app asset links, hosted APK releases, the Android push channel | `storage`, `notifications` | The server half; the Kotlin shell is built by the CLI's `android` command. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/android-app/README.md) |
| `telemetry` | The OpenTelemetry export gate, the GreptimeDB connection, the SQL Explorer (with an AI assistant when `ai` is on), the Telemetry Dashboard and its metric groups, the `telemetry.*` Doctor checks | `credentials` | Off until an administrator saves a connection and turns collection on at `/admin/settings/telemetry`; the SDK starts only with `OTEL_ENABLED=true`. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/telemetry/README.md) |

Not in the starter yet: the web conformance call (`runPlatformWebConformance`); `src/__tests__/slices.test.ts` covers the registries.

**Turn a slice off** by deleting its line from `enabled`. Order does not matter, and a slice that requires one you removed fails at startup naming both, with the line to add or remove. Nothing else changes: its routes answer 404, its cards, pages, providers, banners and jobs are not mounted, its permissions are not seeded, and its `forRoot()` never runs. Its tables stay in the schema (the platform's migrations are one history), unused.

**Turn a slice on** by adding its id, then:

```bash
cd apps/api && npm run prisma:seed       # seeds the permissions its routes check (upserts only)
```

and restart. Nothing else is required in code: the slice's runtime configuration (a bucket, an email transport, an AI key, a VAPID key pair) is set in the admin UI, never in `.env`.

**Remove a slice's code for good** (not just switch it off): delete `apps/api/src/platform/<id>/`, `apps/web/src/slices/<id>.tsx`, their lines in `apps/api/src/platform/slices/definitions.ts` and `apps/web/src/slices/definitions.ts`, and the slice's entry in `catalog` and `enabled` of `slices.json`.

**Peer dependencies.** The platform packages mark every peer their always-mounted core does not need as *optional*, and npm never installs an optional peer, so this app declares the peers of the slices it imports itself (`apps/api/package.json`, `apps/web/package.json`). The lists come from [`packages/platform-slice-peers.json`](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-slice-peers.json) in the platform repository, and `node scripts/check-slice-peers.mjs --app apps/api` (the platform repository's check, run in CI against this starter) fails when an imported slice's peer is not declared. On the API every optional slice above runs on the peers of the always-mounted core (`@nestjs/*`, `fastify`, `passport`, `@prisma/client-runtime-utils`, `@opentelemetry/api`, `zod` and friends), so removing an API slice removes no dependency. On the web, two slices bring peers of their own, which you may remove together with the slice's code:

| Slice | Web peers only it needs |
|---|---|
| `ai` | `@mui/x-data-grid` (its lists use the packaged data table) |
| `telemetry` | `@mui/x-charts`, `@mui/x-data-grid`, `@uiw/react-codemirror`, `@codemirror/lang-sql` |

The root `package.json` carries `overrides: { "fastify": "^5" }` because `@nestjs/platform-fastify` pins one exact `fastify` and the API declares the peer range: without it npm installs two copies and the Fastify plugin types stop matching.

`@mui/x-data-grid` stays while either slice, or any other page of yours that uses the packaged data table, remains.

**Where a slice lives.** On the API, `src/platform/<id>/` holds `<id>.slice.ts` (what the slice mounts, replaces and contributes: its modules, host-port overrides, registrations, notifications, storage prefixes, settings namespaces), its `forRoot()` configuration (`*.config.ts`), its host-port adapters and its **minimal example**; `src/platform/slices/` is the loader. A slice definition runs nothing on import: everything lazy sits behind a function that is called for an enabled slice only. On the web, `src/slices/<id>.tsx` is the slice's routes, cards, providers and shell parts; `src/slices/manifest.ts` composes the enabled ones into `App.tsx` and the two registries in `src/config/`.

| Slice | Minimal example |
|---|---|
| `credentials` | `credential-purposes.ts`: a purpose the sample feature could keep a webhook secret under |
| `storage` | `storage-prefixes.ts`: the key prefix of files attached to a note |
| `email` | `templates/notes-archived.email.ts`: an app template, typed through `EmailTemplateDataMap` |
| `notifications` | `notes-archived.notification.ts`: an event raised by the sample archive job after its write commits |
| `sharing` | `documents/`: the `document` resource type (`document.resource-type.ts`), its service deciding every record with `AccessPolicy` and its controller; the `Document` model is an organization's row with row-level security (`prisma/fragments/documents.prisma`) |
| `ai` | `notes-summary.feature.ts`: a registered feature and a service calling `AiService.forUser` |
| `db-backup` | `restore-carry-over.ts`: a table whose rows survive a restore |
| `exports` | `notes.export-source.ts`: a shaped, filterable export of the notes |
| `onboarding` | `onboarding.manifest.ts`: a fact and a "write your first note" step |
| `android-app` | `device-source.ts`: the device source a native capability replaces |
| `telemetry` | `activity.metric-group.ts`: a Telemetry Dashboard section of the app's own (sign-ins and token refreshes by outcome), one option of `TelemetryModule.forRoot` |

**Tests.** `test/slices.spec.ts` and `src/__tests__/slices.test.ts` check the manifest rules; `test/slices-composition.spec.ts` and the web twin compose the core alone and each slice with only what it requires, and prove it mounts, the others are absent, its permissions are seeded only while it is on and the host ports it replaces are replaced; `test/slices.db.spec.ts` probes one route per slice against a real database, 404 when off. `test/conformance.spec.ts` runs the enabled slices' conformance suites; `test/ai-conformance.spec.ts` runs the five AI suites that boot the app (kill switch, RBAC matrix, secret egress, key policy, jobs server-only) over a mocked database, with the fixture in `test/ai-conformance/` (no PostgreSQL needed). `test/documents.db.spec.ts` proves the sharing slice's sample record end to end under row-level security.

## Rename

```bash
node scripts/rename.mjs --name "Kappa Hub" --repo kappa/kappa-hub --theme "#c62828" [--cli-name kappactl] [--dry-run]
```

It writes `packages/shared/identity.json`, edits the literal targets nothing can derive (the root `package.json` name, this README, `install.sh`, the two SVG fills, the CI test database, the CLI `bin` key), and re-renders `infra/` with `platform-infra sync`. It never commits.

## Upgrading the platform

Renovate (`renovate.json`) opens one pull request that moves every `@marinoscar/platform-*` package to the same version. After merging it:

```bash
npm install
cd apps/api && npm run db:sync && npm run db:compose && npm run prisma:generate   # new platform migrations and fragments
cd ../.. && npm run platform:infra:sync                                           # new infra fragments
npm run platform:check
```

Order matters for migrations: `db:sync` installs the package's new migrations first, then `prisma migrate dev` authors yours after them. Read each package's `CHANGELOG.md` for upgrade notes.

**The `next` channel.** Pre-releases are published under the `next` dist-tag. To try one, install it explicitly (`npm install @marinoscar/platform-api@next ...`, every platform package at the same version), or set `"followTag": "next"` on the platform rule in `renovate.json`.

## Changing the platform

The platform's code is not in this repository, on purpose: an app that edits a copy drifts from every other app. When you need something the packages do not offer (a port, a registry, an option):

1. [File a seam request](https://github.com/marinoscar/EnterpriseAppBase/issues/new?template=seam_request.yml) in the platform repository: what you need, where, and why the existing extension points do not cover it.
2. Work around it in your own code, behind your own interface, until the release that adds the seam.

## License

MIT — see [LICENSE](LICENSE).
