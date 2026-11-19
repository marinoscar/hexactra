# Secrets: connecting a Vault, and signing in from a saved login

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

The fabric is handed, per owner, `{ kind: 'vault', baseUrl, accessToken, expiresAt }` through the `FabricSecretsRegistry` port (`src/secrets/fabric-secrets-registry.ts`) and keeps it in memory only. The console replaces it before it expires while a run is live: the queue job `secrets.vault.keep_fresh` (server-only; a per-minute cron only decides whether to enqueue it) renews the token for every owner with a live run. `SecretsProviderRegistrar.ensureRegistered(userId)` is what the runner calls when a run starts (E37.3).

## The kill switches

There are three, and each alone stops the agent:

| Switch | Where | Default |
|---|---|---|
| Vault's agent access | Vault, `/admin/settings/agent-access` | off (`403 AGENT_ACCESS_DISABLED`) |
| **The deployment's** | system setting `secrets.agentUse.enabled` (`PATCH /api/system-settings`, `system_settings:write`) | **off** |
| **The owner's** | user setting `secrets.agentUse.enabled` (`PATCH /api/user-settings`) | **off** |

A third setting, `secrets.defaultUseSavedLogins` (owner, default off), is not a switch: it only sets where new tasks and chats start. Each task, chat and AI app still has its own opt-in ([How the agent signs in](#how-the-agent-signs-in)).

With either of Hexactra's two off, `secrets_lookup` answers "not enabled", the fabric is told to hold nothing for the owner, and nothing is released, whatever Vault allows. Both are read on every registration (the deployment's with a five-second cache).

## How the agent signs in

E37.3 (#592). When a run reaches a sign-in page and the owner has a saved login for **exactly** that site, the agent signs in without asking: the username, the password, and an authenticator code when the site wants one. With no match, several matches or a provider that says no, it falls back to the sign-in card ("Sign-in needed"), as before. This is what lets a scheduled task run with nobody there.

**Who may use it.** A run uses saved logins only when all of these hold: the deployment switch and the owner's switch above are on, a provider is connected, and the run's **task or chat has `useSavedLogins`**. A run started by a hosted AI app over OAuth also needs the app's `allowSavedLogins` limit (default **off**, `PATCH /api/connected-apps/{clientId}/settings`; [security-hosted-clients.md](security-hosted-clients.md)). Anything else: the three tools below are not offered and the run asks as before.

| Where | Field | Default |
|---|---|---|
| Task | `useSavedLogins` (`POST`/`PATCH /api/tasks`) | the owner's `secrets.defaultUseSavedLogins`, else off |
| Chat | `useSavedLogins` (`POST`/`PATCH /api/chats`, Chat settings) | the owner's `secrets.defaultUseSavedLogins`, else off |
| Owner | user setting `secrets.defaultUseSavedLogins` (`PATCH /api/user-settings`) | off; new tasks and chats start from it |
| Connected AI app | limit `allowSavedLogins` | off |
| Task | `unattendedPayments` `ask` \| `allow` | `ask` |

**The three tools** (group `secrets`, offered only when the run may use saved logins):

| Tool | Parameters | What the model reads |
|---|---|---|
| `saved_logins` | none | For the page on screen: `none`, or `{ ref, name, username, exact, hasCode }` for each login. `ref` is a per-run reference (`login-1`), never the provider's id. A username is not secret; a password and a code never appear. |
| `sign_in_with_saved_login` | `ref`, `username_selector`, `password_selector`, `submit` | "Typed username and password…" or a failure in plain words. A site that splits the sign-in over two pages takes one selector per call. |
| `type_saved_code` | `ref`, `selector`, `submit` | "Typed the code" or a failure. Only for a login with `hasCode`, and only for an authenticator-app code: a code sent by text message or email is not in a vault and still asks the owner. |

**The rules** (enforced by the runner, not by the model's good will):

- **Only an exact match is usable.** A `ref` that is not exact ("saved for a different address of this site") is refused. No match, or a site-only match: the model asks the owner (`request_human`, kind `login`, input `credentials`). **Several exact matches:** the tool tells the model to ask with a choice card whose options are the logins' names and usernames; nothing is typed until the owner picks one, and then only that login.
- **The model never names a secret.** It passes a `ref` from the lookup of the page it is on. The fabric reads the page's origin itself when it types, asks the provider with it, types with trusted input and wipes the value. If the page changed since the lookup, nothing is typed and the model looks up again.
- **A mismatch stops everything.** `origin_mismatch` (a look-alike address) or a field in another site's frame: nothing was typed, the model is told "Stop. This page is not the site this login is saved for. Do not try another login. Tell the owner.", **the run asks the owner with a warning card** (kind `login`, input `takeover`, "Warning: …"), and saved logins are off for the rest of the run.
- **Errors become instructions.** `disabled`, `unauthorized`, `unavailable`, `rate_limited`, `not_found`: "Saved logins are not available right now. Ask the owner to sign in" (the sign-in card; the run continues after the answer). The outcome is reported to the connection's status: `unauthorized` makes it `needs_reconnect` (one notification), `disabled` turns `agentAccess` off.
- **A rejected password is not retried.** A login's password is typed at most once per run and site. A second request is refused and the model is sent to the owner: repeated failures lock accounts. A code is typed at most three times per login and site.
- **"Remember this device"** and similar options: unchanged from #527 (the owner's choice when asked; with a saved login the page's box is left as the page had it).

**What the run records.** Steps read "looked up saved logins: 1 match", "signed in with the saved login 'Shop login' (username p•••@example.test)" and "typed the authenticator code of the saved login …": the item's name and the **masked** username, never a value. `Run.usedSavedLogins` (`[{ provider, itemName, origin, at }]`, at most 20, one per login and site) is returned by `GET /api/runs/{id}` and shown on the run page ("Signed in with: Shop login"). A run holds no password, no code and no provider id in a step, its memory, the model's input or a tool result (`test/saved-logins.db.spec.ts`, marker test).

**When nobody is watching.** A run that used a saved login and was **not started from a chat** (a schedule, the API, MCP, a manual task run) keeps the confirmation before payments and other commitments **on** for that run, even when the task has it off, unless the task sets `unattendedPayments: allow`. The owner's saved approvals (see [approvals.md](approvals.md)) still apply as the owner defined them. A scheduled run that used a saved login sends **one** notification at its end, grouped by site ("Signed in to shop.example.test with a saved login", event `runs.saved_login_used`, browser and push).

**Crash safety.** Before each field the runner writes the phase (`typing`) to the run's memory and a `saved_login_phase` note to the trace, and `typed` after the fabric confirms it. A job that dies between the two fields and is retried does not type the username again; a password that may already have been typed is never typed a second time (the model is told to look at the page and, if it is not signed in, to ask the owner).

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
