# Decision record: the built-in secrets store embeds the Vault packages

Issue #594 (epic E37, #579). Owner's decision (2026-11-19): build the built-in store by reusing the `@marinoscar/vault-*` packages, not by writing a second secrets manager. This record is the spike of Phase A, written from a real installation of the published packages in this console (`0.1.0-next.4`, `next` dist-tag; the platform range they declare, `>=0.1.0-next.36 <=0.1.0-next.39`, includes this console's `0.1.0-next.39`). **Decision: go**, with the shape below and six upstream requests (marinoscar/vault#225 to #230) for what the console works around.

## What was tried

`@marinoscar/vault-api`, `vault-contract` and `vault-db` installed in `apps/api`; the Vault schema applied to a real PostgreSQL 16; every port the mounted slices ask for bound; the secrets and secret-types controllers served; the in-process agent release rules driven end to end; a login created, opened to the agent, looked up by exact origin and released one field at a time. `test/secrets-store.db.spec.ts` is that spike kept as a regression test. `vault-web` (the page) is covered in the pull request.

## Ports: what bound cleanly, what needed an adapter

| Port | Binding | |
|---|---|---|
| `prisma` | `PrismaService` | Clean. The packages filter by owner themselves; they do not use `forUser`. |
| `crypto` | `SecretsStoreCrypto` (envelope) | **Adapter with a workaround**: the port is synchronous and context-free (see Key handling and vault#227). |
| `audit` | `StoreAudit` over `audit_events` | Clean. A failed write fails the operation. |
| `settings` | `StoreSettings` | Clean. `agentAccess.enabled` is the deployment's `secrets.agentUse`; cards and identity stay off. |
| `notify` | no-op | Vault's agent notices need registered events and templates the console does not have; every use is audited. |
| `objectStore` | refuses | Attachments are out of scope; any use throws. |
| `jobs`, `objects`, `ai`, `aiConfig`, `aiKeyPresence`, `metrics`, `host`, `mcp` | **not bound** | Slices that are not mounted. |

Slices mounted: `secrets`, `secret-types` and the in-process `agent` release rules (`AgentReleasePort`). Not mounted, and said so in `secrets.md`: media, backups, card scanning (`ai`), card expiry, MCP, the agent HTTP API, the owner's card grant routes.

## Assumptions of Vault that got in the way

Each one is filed on `marinoscar/vault`.

1. **No slice selection** (vault#225). `VaultApiModule.forRoot` mounts every controller. Its `McpController` serves `POST /api/mcp`, which is this console's own MCP endpoint (a duplicate route stops Fastify at boot); its agent HTTP API would be one more way to read a value; media and backups would need ports for slices this issue does not mount. **The console therefore does not call `forRoot`**: it provides the packages' exported services over its own bindings and mounts only `SecretsController` and `SecretTypesController` (`secrets-store.module.ts`). That works because the services are exported from their subpaths; it depends on their constructor graph, which is not a documented contract.
2. **A type declaration closes the host's permission type** (vault#226). Importing any type of `vault-api` narrows `PermissionName` to Vault's ids and breaks every `@Auth({ permissions })` of the host. The console augments it with its own ids (`src/platform/permissions.ts`).
3. **The crypto port has no owner, item or field** (vault#227): envelope encryption per owner needs an `AsyncLocalStorage` scope; the associated data binds the owner only.
4. **Purge and administrator reach** (vault#228): `Secret.created_by_id` is `ON DELETE SET NULL` in a generated fragment, so the registry says `detach` and the console deletes through its user-data purge and an upkeep sweep; the three `*_any` permissions are simply not declared; the host conformance kit cannot run for a subset.
5. **The released value is a JS string** (vault#229): it cannot be wiped.
6. **Migration naming for a host with history** (vault#230): `--names after-host` (marked deprecated) is the only policy that works.

## Database: fragments, migrations, the lock

- `vault-db sync --names after-host` installs `prisma/fragments/vault.{secrets,media,backups}.prisma`, eleven migrations named `202611191402NN_vault_<slug>` (after the console's own newest migration at the time of the merge, so a fresh database runs them in order), `prisma/vault.lock`, and merges the two raw-SQL indexes and the eleven migrations into `prisma/platform.lock`. `platform db compose` then composes them as `app.vault.*` beside the console's fragments; the `User` and `StorageObject` back-relations come in as `extend model` blocks. `npm run db:check` now runs `platform db check && vault-db check`, so `npm run platform:check` covers both locks.
- The tables exist in every deployment (the schema is composed statically), whether the slice is on or not. **Every model is registered in the user-owned data registry and the user-data manifest without importing the packages** (`store.ownership.ts`), so the platform conformance suite passes with the slice off and a package upgrade that adds a table is caught by `test/secrets-store.packages.spec.ts`.
- The console's own tables are `secrets_store_data_keys` and `secrets_store_callback_tokens` (migrations `20261119140300` and `20261119140301`, after the Vault ones).
- Unmounted slices leave unused tables (backups, media, card grants): accepted; dropping them would fork the package's migration history.

## Cost

Measured on this tree: the three packages are 1.9 MB + 0.9 MB + 0.4 MB on disk, plus `@zip.js/zip.js` (8.6 MB installed, used only by Vault's export, which the console does not mount). The API image grows by that; no runtime cost with the slice off (the module is `require`d lazily, asserted by test). The web bundle cost is reported with the web change in the pull request.

## Key handling: confirmed, with one revision

Confirmed: a dedicated `SECRETS_STORE_KEY` (256-bit, required when the slice is on, the API refuses to start without it), a random data key per owner wrapped by it, AES-256-GCM, rotation by re-wrapping with `SECRETS_STORE_KEY_PREVIOUS` accepted meanwhile, a database backup that holds ciphertext only.

Revised: **the item and field are not in the associated data.** Vault's crypto port gives the adapter neither (vault#227). The owner is: it is written into the stored ciphertext and bound in the associated data, so a ciphertext copied to another owner's row fails authentication. A copy to another secret of the same owner would decrypt; that needs a database write and yields only a value the owner already holds.

## Go / no-go

**Go.** Nothing blocks the embed: the platform range matches, the schema and migrations compose with the console's flow, the slices needed are exported. The cost is the workarounds above, each bounded and each filed. The built-in store follows Vault's own rules because Vault's own code enforces them.
