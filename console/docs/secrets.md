# Secrets: connecting a Vault, or the built-in store

Epic E37 (#579) lets an agent use the owner's saved logins and one-time codes **without ever seeing them**. This page is the console's half of the Vault provider (E37.2, #591): how an owner connects their Vault, what Hexactra stores, the kill switches, and what happens when the connection breaks. Looking up a login and typing a field is the fabric's job (E37.1, E37.3); **the console never receives a login, a password or a code**, and there is no console route that returns one.

Vault's own contract is `docs/agent-credential-api.md` and its operator runbook is `docs/runbooks/agent-access.md` in the `marinoscar/vault` repository. The shapes the console mirrors (and the version they follow: agent contract 1.2, beta) are in `apps/api/src/secrets/vault-contract.ts`.

## Register Hexactra as an OAuth client in Vault (administrator of the Vault)

Hexactra is a **confidential client** that runs OAuth 2.1 authorization code with PKCE (`S256`). Follow Vault's runbook, "Register an agent runtime":

1. In Vault, switch the OAuth server on (`/admin/settings/oauth-clients`) and **Agent access** on (`/admin/settings/agent-access`). Both are off by default; with Agent access off every call answers `403 AGENT_ACCESS_DISABLED`.
2. Create a client named "Hexactra" with these **redirect URIs** (the status route shows the exact value, `GET /api/secrets/status`, `redirectUri`):

   ```
   https://<your console>/api/secrets/vault/callback
   ```

3. Grant types: authorization code and refresh token. Allowed scopes: `vault:items_read`, `vault:items_fill`, `offline_access`, and `vault:items_write` only if the owner will let the agent save and change logins (E37.4).
4. Copy the client secret (shown once). The client authenticates with `client_secret_post`; a client registered for `client_secret_basic` also works (the console retries once with Basic and remembers it).
5. If Vault refuses the console's host, add it to Vault's client host allowlist.

Then, in Vault, each owner opens the logins the agent may use (**Allow agents to use this login**). Hexactra reaches only those.

## Connect (the owner)

1. **Set the client** (once): `PUT /api/secrets/vault/client` with the Vault's address (`https://vault.example.test`, its `APP_URL`), the client id and the client secret. The secret is write-only. An administrator may instead set a **deployment default** (`PUT /api/secrets/vault/default-client`, `system_settings:write`), so owners only press Connect; an owner's own entries take precedence.
2. **Connect**: `POST /api/secrets/vault/connect` returns `authorizeUrl`; the browser goes to Vault's own consent screen (the owner sees "Hexactra" and the scopes). Scopes asked: `vault:items_read vault:items_fill offline_access`. `{ "allowWrite": true }` adds `vault:items_write`: a **new consent**.
3. Vault redirects to `GET /api/secrets/vault/callback`; the console exchanges the code, calls `whoami`, stores the grant and sends the browser back to `/settings/secrets?vault=connected` (or `vault=<reason>`: `denied`, `expired`, `state_invalid`, `binding_invalid`, `issuer_mismatch`, `exchange_failed`, `no_refresh_token`, `whoami_failed`).
4. `GET /api/secrets/status` shows the connection.

How the flow is protected:

- The PKCE verifier is kept on the server (encrypted); `state` and a browser-binding value are kept only as SHA-256 hashes. The flow is **bound to the browser that started it** by an HttpOnly, `SameSite=Lax` cookie set on the `connect` response, so the callback must arrive in that browser within 10 minutes; a copied link is not enough. The pending fields are claimed atomically, so a code is used once.
- The `resource` indicator, `<Vault APP_URL>/api/agent/v1`, is sent on both the authorize and the token requests. If Vault announces `iss` on the authorization response (RFC 9207), it must be the Vault the flow started with.
- Discovery (`/api/oauth/.well-known/authorization-server`) may not point the console at another host: every endpoint must be on the Vault's own origin.
- The callback is a deliberate `@Public()` route (the browser arrives from Vault without our bearer token). It never answers with data, only a redirect. Its query (`code`, `state`) is kept out of the request log, out of traces and out of nginx's access log (`infra/nginx/app.d/locations/secrets-callback.conf`).

## What Hexactra stores

| What | Where | Notes |
|---|---|---|
| The OAuth **refresh token** | The encrypted credential store, user tier, purpose `secrets_vault_grant`, name `refresh` | Only the console ever holds it. Rotated on use. **Never sent to the fabric.** |
| The short-lived **access token** | Same purpose, name `access` | The only token the fabric is handed. |
| The PKCE verifier of a Connect in progress | Same purpose, name `pending` | Deleted when the callback arrives or the flow expires. |
| The **client secret** | User tier, purpose `secrets_vault_client`, name `default`; the administrator's default is the system tier of the same purpose | Write-only. |
| The connection | `secrets_connections`: the address, client id, granted scopes, status, Vault user id, whether Vault's agent access is on, connected / last used / last success times, the last error **code** | Never a token or a message. Deleted with the user and part of the data export. |

**Never stored: a login, a password, a one-time code or a seed.** Hexactra holds no secret of the owner's Vault items. The credential purposes `secrets_vault_client` and `secrets_vault_grant` are permanent: add one, never rename one.

## Tokens: rotation, and what the fabric gets

Vault's refresh tokens **rotate on use**, and replaying a used one **revokes the whole grant**. So the console, not the fabric, owns the refresh token, and it never lets two refreshes of one connection run at once:

- one refresh at a time per process (callers share it) **and** per connection across API instances (a database lease on the row, taken with a compare-and-set, so a second instance waits for the first's result instead of calling Vault);
- the new refresh token is stored (replacing the old) **before** the new access token is used; if it cannot be stored the connection is marked `needs_reconnect` rather than carrying on with a token Vault already retired;
- a Vault that cannot be reached changes nothing (status stays, nothing is consumed); the caller is told it is unavailable.

The fabric is handed, per owner, `{ kind: 'vault', baseUrl, accessToken, expiresAt }` through the `FabricSecretsRegistry` port (`src/secrets/fabric-secrets-registry.ts`) and keeps it in memory only. The port is bound to `FabricSessionSecretsRegistry`, which calls the fabric's `PUT/DELETE /v1/secrets-providers/{owner}/vault` (`kind: "vault"`, `base_url`, `access_token`, `expires_at`); a fabric that is not configured, not reachable or that refuses is reported as `unavailable` and never carries the token. The fabric (`hexactra-control`) holds the token in memory only, calls the owner's Vault itself and drops the registration at `expires_at`. The console replaces it before it expires while a run is live: the queue job `secrets.vault.keep_fresh` (server-only; a per-minute cron only decides whether to enqueue it) renews the token for every owner with a live run. `SecretsProviderRegistrar.ensureRegistered(userId)` is what the runner calls when a run starts (E37.3).

## The kill switches

There are three, and each alone stops the agent:

| Switch | Where | Default |
|---|---|---|
| Vault's agent access | Vault, `/admin/settings/agent-access` | off (`403 AGENT_ACCESS_DISABLED`) |
| **The deployment's** | system setting `secrets.agentUse.enabled` (`PATCH /api/system-settings`, `system_settings:write`) | **off** |
| **The owner's** | user setting `secrets.agentUse.enabled` (`PATCH /api/user-settings`) | **off** |

With either of Hexactra's two off, `secrets_lookup` answers "not enabled", the fabric is told to hold nothing for the owner, and nothing is released, whatever Vault allows. Both are read on every registration (the deployment's with a five-second cache).

## Status, errors and reconnecting

`GET /api/secrets/status` (`secrets:read`):

```jsonc
{ "data": {
  "agentUse": { "deployment": false, "user": false, "effective": false },
  "providers": { "vault": {
    "provider": "vault",
    "status": "connected",          // not_configured | disconnected | connected | needs_reconnect
    "configured": true, "source": "user", "baseUrl": "https://vault.example.test",
    "clientId": "…", "hasClientSecret": true,
    "redirectUri": "https://<console>/api/secrets/vault/callback",
    "scopes": ["vault:items_read", "vault:items_fill", "offline_access"],
    "vaultUserId": "…", "agentAccess": "on",   // on | off | unknown: Vault's own switch, from whoami or the last 403
    "connectedAt": "…", "lastUsedAt": "…", "lastSuccessAt": "…",
    "lastErrorCode": null,           // a stable code (GRANT_REVOKED, ORIGIN_MISMATCH, …), never a message
    "connecting": false } } } }
```

When Vault answers `401` (the owner removed Hexactra in Vault's Connected apps, the refresh token expired or was replayed, the client secret was rotated), the grant is gone: the connection becomes `needs_reconnect`, the stored tokens are deleted, the fabric forgets the provider, the owner gets **one** notification ("Reconnect your Vault", event `secrets.needs_reconnect`) and a run falls back to asking the owner (E37.3). Connecting again clears it. The fabric (or the runner) reports outcomes with `VaultConnectionService.recordOutcome(userId, { ok: true } | { ok: false, code })`; `UNAUTHORIZED` is the 401.

Administrators see it in **Doctor**, `secrets.vault_connections` (a warning while any connection needs reconnecting; counts only, no owner), and the Vault hosts in the egress inventory.

## Disconnect

`POST /api/secrets/vault/disconnect` revokes the grant at Vault (`/api/oauth/revoke`), deletes the stored tokens, tells the fabric to forget the provider and marks the connection `disconnected`. `revoked: false` in the answer means Vault could not be asked: remove Hexactra in Vault's **Connected apps** (the tokens here are deleted either way). `{ "forgetClient": true }` also forgets the owner's own address, client id and client secret. **Live runs** lose the provider at once and fall back to asking the owner. Deleting the user removes the connection and the stored tokens, but not the grant at Vault: the owner removes the app there.

## The address of the Vault (SSRF)

The address is checked when it is saved, when Connect starts and on **every** call, the same way the console validates webhook URLs (the platform's egress guard): `https` only, no user name or password, a port of 80, 443, 8443 or 1024 and up, and **no private, loopback, link-local (cloud metadata included) or carrier-grade-NAT address**, for a name or a literal, checked again at send time against what the name resolves to now (DNS rebinding). The connection is pinned to the checked address, no redirect is followed, bodies are bounded and nothing is logged. The refusal is `422 SECRETS_VAULT_URL_REFUSED` with `details.reason`.

- Development (`NODE_ENV` not `production`): `http` and loopback targets are allowed so a Vault on the developer's machine works.
- A Vault on a private network (an on-premises Vault): an administrator lists its exact host name in system setting `secrets.vault.allowedHosts`; `https` is still required.

## Routes

| Route | Permission | |
|---|---|---|
| `GET /api/secrets/status` | `secrets:read` | Status of the providers and the two switches |
| `PUT /api/secrets/vault/client` | `secrets:write` | The owner's address, client id and (write-only) client secret; `409 SECRETS_VAULT_DISCONNECT_FIRST` while connected |
| `POST /api/secrets/vault/connect` | `secrets:write` | `{ allowWrite?, returnTo? }` → `{ authorizeUrl, expiresAt }`; sets the binding cookie |
| `GET /api/secrets/vault/callback` | public (state + cookie) | Redirects to the return page |
| `POST /api/secrets/vault/disconnect` | `secrets:write` | `{ forgetClient? }` → `{ revoked, status }` |
| `GET\|PUT\|DELETE /api/secrets/vault/default-client` | `system_settings:read` / `:write` | The administrator's default address, client id and client secret |

`secrets:read` goes to contributors, viewers and organization admins; `secrets:write` to contributors and organization admins. There is no MCP tool and no CLI command: a hosted AI app or a personal access token must not rewire the owner's secrets provider (`packages/shared/capabilities.json`, [parity.md](parity.md)). The Secrets page is E37.4.

## Testing: the fake Vault

`apps/api/test/support/fake-vault.ts` is a small HTTP server that implements Vault's documented OAuth server and agent API: discovery, authorize (PKCE, `resource`, redirect URI, auto-consent), token (authorization code and **rotating** refresh tokens; a replayed refresh token revokes the whole grant), revoke, `whoami`, lookup, fill, TOTP, exact origin binding, the one identical `404`, scopes (`insufficient_scope`), the kill switch (`403 AGENT_ACCESS_DISABLED`), `429` with `Retry-After`, `Cache-Control: no-store`. It holds only invented data (`Person A`, `*.example.test`) and random canary values, and refuses to start in production. Controls: `setAgentAccess`, `revokeAllGrants`, `throttleNext`, `denyNextAuthorization`, `failNextRefresh`, `setLoginOpen`, `refreshDelayMs`.

```bash
cd console/apps/api
npx ts-node --transpile-only test/support/fake-vault.main.ts --grant   # prints one JSON line: baseUrl, client, logins, and a ready access + refresh token
```

From jest: `const vault = await startFakeVault({ clientSecret, redirectUris })`. When Vault's conformance kit (marinoscar/vault#196) is published, a follow-up replaces this fake with it. The tests: `test/secrets-vault.spec.ts` (PKCE, the SSRF guard, the OAuth client, the fake itself) and `test/secrets-vault.db.spec.ts` (the flow, rotation across two instances, a replayed refresh token, the switches, a seeded-marker scan of every response, audit row, notification, row and log line).

# The built-in store (E37.5)

Someone who runs Hexactra without a separate Vault still gets saved logins. The console embeds **Vault's own domain packages** (`@marinoscar/vault-api`, `vault-contract`, `vault-db`; decision record: [decisions/secrets-embedding.md](decisions/secrets-embedding.md)) and offers them to the agent as a second provider, `builtin`. The rules are Vault's, enforced by Vault's code: a login is visible to the agent only if its owner opened it (**per-item opt-in**), a release is bound to the **exact origin** of the page, **one field per call** (`username` or `password`; a one-time code is its own call), a login that is closed, missing or somebody else's gives **one identical not-found**, every call is **audited** (`agent.credential.*`, credential `embedded`, label `hexactra-agent`), calls are **rate limited** per minute, and Vault's **kill switch** is the deployment's `secrets.agentUse.enabled`. On top, the console's two switches apply (the deployment's and the owner's, both off by default).

## Which one to use

| | Built-in store | Your own Vault |
|---|---|---|
| Needs | This deployment and its key | A running Vault (an OAuth client registered there) |
| Where the logins are | This console's database, encrypted | Your Vault |
| Types | Saved logins (the `Credential` type) | Whatever your Vault holds (cards and identity come later) |
| A value crosses | **The console's Node process** (see the limit below) | Only the fabric: the console never sees it |
| Choose it for | One person or a small team, logins only | Anything more than logins; passwords you also use outside Hexactra |

**One provider is active per owner**, set in the owner's user setting `secrets.provider` (`vault`, the default, or `builtin`). Switching does not move data (an export and import path is a follow-up) and takes effect on the next call: the provider that is not chosen answers `disabled`. We recommend the remote Vault for anyone who stores more than logins.

## Switch it on

Deployment configuration, off by default (`infra/compose/app.env.example`; read at boot, restart the API after changing):

| Variable | |
|---|---|
| `SECRETS_STORE_ENABLED` | `true` loads the slice. Unset or false: **no Vault package is loaded**, the app starts without the key, every existing route and test is unchanged. |
| `SECRETS_STORE_KEY` | Required when on: 32 random bytes as 64 hex characters or base64 (`openssl rand -base64 32`). Missing or malformed, the API **refuses to start** with one error naming the variable (never the value). The deploy wizard never generates it for you. |
| `SECRETS_STORE_KEY_PREVIOUS` | Only during a rotation. |
| `SECRETS_STORE_CALLBACK_URL` | The address of the API as the fabric reaches it (default `http://api:3000`). |

The slice needs the credential store and notifications slices, like the Vault connection. These are deployment secrets, not runtime configuration: a key that protects a database cannot live in it (the "never an environment variable" rule is for runtime-configured features such as storage and AI). Enabling it also needs `npm run prisma:migrate` (the Vault tables and `secrets_store_data_keys` ship in every build) and a restart; the `Credential` secret type is created at start-up.

Then: the deployment switch `secrets.agentUse.enabled` (Administration), and per owner: choose the built-in store, turn on "let the agent use my saved logins", save a login and tick **Allow agents to use this login**.

## Key handling

```
SECRETS_STORE_KEY (environment)  --wraps-->    one random data key per owner (database, wrapped only)
data key                         --encrypts--> that owner's values (AES-256-GCM)
```

- Values exist only as ciphertext (`secret_versions`), written as `ss1.<owner id>.<base64>` with the owner bound as associated data. A database dump holds ciphertext and wrapped keys only: **it cannot be decrypted without `SECRETS_STORE_KEY`**. The tests scan the database for a seeded marker and print an excerpt.
- The store key is **not** `SECRETS_ENCRYPTION_KEY` (the credential store's) and not derived from it. It is never logged, never in a Doctor output, never sent to the fabric, and in no API response.
- A wrong key **fails closed**: nothing is returned, the request is an error.
- Associated data binds a value to its owner; it does **not** bind the item or field (Vault's crypto port does not provide them: vault#227).

### Backups

The console's database backup contains only ciphertext. **The key must be backed up separately, somewhere other than the database backup** (a password manager, an offline copy). **Losing the key loses every saved login for good.** Restoring the database without the key gives a working app with unreadable logins (Doctor `secrets.store_key` fails: "wrapped under a store key this deployment no longer has").

### Rotating the store key

1. Generate the new key. Keep the old one.
2. Set `SECRETS_STORE_KEY` to the new key and `SECRETS_STORE_KEY_PREVIOUS` to the old one; restart the API. Everything keeps working: rows still wrapped under the old key are read with it. Doctor `secrets.store_key` warns "a rotation is unfinished".
3. Run **Re-wrap**: `POST /api/admin/secrets-store/rewrap` (`system_settings:write`), which queues the job `secrets.store.maintain` (also queued hourly when there is work). It re-wraps every owner's data key under the new key; **the values are not re-encrypted**. It is safe to repeat.
4. When Doctor passes ("every owner key is wrapped under it"), remove `SECRETS_STORE_KEY_PREVIOUS` and restart. Keep the old key until you hold a backup taken after step 3.

The same job removes expired fabric credentials and secrets that lost their owner (a user removed by a path that skipped the user-data purge: their data key goes with them, so the ciphertext is unreadable anyway).

## How the fabric reaches it

The store has no address of its own, so the fabric **calls back**. When a run starts, `SecretsProviderRegistrar.ensureRegistered(userId)` registers the provider with the fabric as `kind: console` with `base_url = <SECRETS_STORE_CALLBACK_URL>/api/internal/secrets-store/v1` and, as the access token, a credential `sct_...` the console minted for that owner (kept only as a SHA-256 hash, valid for an hour, replaced on every registration, revoked when the owner leaves the built-in store or a switch is turned off). **This is the path used**, not an HTTP call to Vault's agent API: there is no Vault server in the picture.

| Route (POST, JSON in) | Answer |
|---|---|
| `/lookup` `{ owner_id, origin, kind?: "login" }` | `{ items: [{ id, name, username, origins, match_kind, has_code, updated_at }] }`, never a value |
| `/release` `{ owner_id, item_id, field, origin, purpose, run_id?, client_label? }` | the field's bytes, `application/octet-stream` |
| `/code` `{ owner_id, item_id, origin, purpose, ... }` | the code's bytes, `X-Expires-At` |

Errors are `{ "code": "<provider error code>" }`: `not_found` 404, `origin_mismatch` 403, `disabled` 403, `rate_limited` 429 (`Retry-After`), `unauthorized` 401, `refused` 403, `unsupported` 422, `unavailable` 503. Every answer is `Cache-Control: no-store`. The route is **only** for the fabric: a session, a personal access token and an AI app's OAuth token all get the same `401`; the credential names one owner and a request that names another is refused; the owner must have a live run; nginx answers 404 for `/api/internal/` on the public side (`infra/nginx/app.d/locations/secrets-store-internal.conf`), so the fabric calls the API directly over the private network. The fabric accepts the callback address only as https, or as http on a private path (loopback, a private address, a single-label name such as the compose service `api`, `.internal`, `.local`): the console's address is on the deployment's own network, unlike a Vault's, which must be https. The fabric half is `ConsoleProvider` (`crates/hexactra-credential-resolver/src/console.rs`), registered with `PUT /v1/secrets-providers/{owner}/builtin` as kind `console`.

### What the built-in store cannot do (a limit the Vault path does not have)

**The value crosses the console's Node process.** On the Vault path only the fabric ever holds a value. Here the console decrypts it and writes it to the response. It is reduced, not removed: Vault's service returns a JavaScript string, which is converted to a `Buffer` at once, written straight to the response, and the buffer is zeroed when the response has finished or the socket closed; it is never logged (the request log prints the method and path only, and the tests scan the logs for the seeded marker). But the string Vault's code decrypted lives until the garbage collector frees it and cannot be wiped (vault#229). Someone who can read the console's process memory can read the logins of owners who used one recently: a reason to prefer your own Vault for anything more than logins.

Also not included: cards, identity items, attachments, backups and the zip export, card scanning, card expiry reminders, media, Vault's MCP, Vault's agent HTTP API, custom secret types, the owner notices of Vault's agent slice (every use is audited instead), migrating between providers. Those routes answer 404 or do not exist; their tables exist and stay empty. No AI app's token can reach this store (`/api/secrets/*` is not part of any protected resource).

## Routes, permissions and who can read what

Vault's own controllers are mounted under `/api/secrets` and `/api/secret-types` (the page's API) with `secrets:read`, `secrets:write`, `secrets:delete` and `secret_types:read` (contributors and organization admins, and viewers for the read ones, as for the Vault connection; deleting: contributors and organization admins). `secret_types:write` and `:delete` are declared and granted to nobody. **No role can read another owner's secret values**: the `secrets:read_any`, `:write_any` and `:delete_any` permissions that Vault gives its administrators are **not declared**, so no role can hold them (`test/secrets-store.db.spec.ts` walks every role). A personal access token can manage the owner's own logins only with `secrets:write` and **can never release a value through the agent route** (the release route accepts nothing but the fabric's credential). `GET /api/secrets/store/status` (`secrets:read`) tells the owner which provider is chosen and how many logins are open.

Vault's `agentAccess` settings namespace is answered by the console (`enabled` is the deployment switch, per-minute limits at Vault's defaults, cards and identity off). There is no `secretsStore.*` namespace yet because nothing needs configuring.

## Testing

`test/secrets-store.spec.ts` (the slice off loads no package, key parsing, the envelope fails closed), `test/secrets-store.packages.spec.ts` (the console's ownership and permission copies against the packages), `test/secrets-store.db.spec.ts` (a real database: the whole flow, the identical not-found, the origin refusal, the switches, every role, ciphertext only, rotation, a wrong key, the internal route with every kind of credential, user deletion, a seeded-marker scan). Vault's own host conformance kit (`runVaultHostConformance`) cannot run for a host that mounts a subset (vault#228); the same assertions are in the db spec, in process.
