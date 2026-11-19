# Connections: your Google and Microsoft accounts

Epic E39 (#581) lets the owner connect their accounts at Google and Microsoft **once**, with a name they choose and a switch for each of Mail, Calendar and Documents, so that tasks, chats and deliveries can use them later. This chapter is the foundation (issue E39.2, #599): the model, the capabilities, the defaults, how tokens are kept, what "needs reconnect" means, and the administrator's setup. What uses a connection is built on top of it by later issues: the Google and Microsoft providers (E39.3, E39.4), deliveries after a run (E39.6), agent tools (E39.7), triggers (E39.8) and generic MCP connections (E39.9).

**Status, honestly.** The model, the flows, the token service, the pages and the CLI are implemented and tested against a **fake provider** (`apps/api/test/support/fake-connection-provider.ts`). **No real Google or Microsoft account has been connected yet:** the real adapters are E39.3 and E39.4, and until one is installed its provider is listed as "not available on this deployment yet". The app model below (bring your own app) is the expected answer of the decision record E39.1 (#598), not yet a recorded one.

## In short

- A **connection** is one account at one provider: `Work` (a Google account), `Personal` (another Google account), `Outlook` (a Microsoft account). The same owner can have several of each.
- Each connection has **six switches** (the capabilities): `mail_read`, `mail_send`, `calendar_read`, `calendar_write`, `docs_read`, `docs_write`. Read is never write. The page shows them as Mail, Calendar and Documents, each "read" or "read and write".
- **Nothing uses a connection until a task or chat is told to.** Connecting an account gives no run any access by itself.
- **The account is always explicit.** If two could do a job and the owner did not say which, the caller asks (`CONNECTION_AMBIGUOUS`); nothing guesses.
- **Tokens never leave the server.** They are encrypted in the credential store, refreshed in the background, and reach no API response, model, step, log, span or export.
- **A connection that stops working says so** (`needs_reconnect`), tells the owner once, and is never chosen until it is connected again.

## Where things are

| What | Where |
|---|---|
| The pages | Settings → Browser agent → Connections (`/settings/connections`, avatar menu); Administration → Browser agent → Connections (`/admin/settings/connections`) |
| The API | `/api/connections` (below); the OpenAPI at `/api/docs` is the reference |
| The CLI | `hexactra connections list\|test\|pause\|resume\|rm` (connecting needs a browser: use the web app) |
| MCP | **No tool.** Hosted AI apps cannot list, add or use the owner's connections ([parity.md](parity.md#what-connections-added-e39)) |
| The code | `apps/api/src/connections/`, `apps/api/prisma/fragments/connections.prisma`, `apps/web/src/pages/ConnectionsPage.tsx`, `apps/cli/src/connections.command.ts` |
| Permissions | `connections:read` and `connections:write` (contributors and organization admins); the administrator's page uses `system_settings:read` and `:write` |

## Capabilities, groups and defaults

| Capability | The group the owner sees | What it allows |
|---|---|---|
| `mail_read` | Mail: read | Read and search mail |
| `mail_send` | Mail: read and write | Send mail |
| `calendar_read` | Calendar: read | See events and free time |
| `calendar_write` | Calendar: read and write | Create and change events |
| `docs_read` | Documents: read | Read documents, spreadsheets and files |
| `docs_write` | Documents: read and write | Create and change documents, add spreadsheet rows, save files |

- **A write capability brings its read capability.** Switching `mail_send` on switches `mail_read` on; switching `mail_read` off switches `mail_send` off. A provider that grants a write without its read leaves it off.
- **Least privilege at the provider.** Only the permissions the switched-on capabilities need are asked for (`scopesFor` of the provider's adapter). Switching a capability on later that the provider has not granted starts an **incremental consent** for just the extra permissions, with the account as the login hint. The switch comes on when the consent returns.
- **Turning a capability off is immediate and local.** The permission stays granted at the provider until the account is disconnected (or the app is removed in the account's own settings at the provider). The page says so.
- **If the provider grants fewer permissions than asked** (the owner unticked one on the consent screen), the missing capabilities are off and the page says which.
- **A default account** can be set for each group (`mail`, `calendar`, `docs`) and provider: it is what a task or chat uses when it does not say which account. There is **at most one default per provider and group per user**: choosing it for one account takes it from the other. It is enforced by the service (a per-user lock) and by the database (a trigger). A default needs a capability of its group switched on; turning the group off drops the default.

## Connecting, reconnecting and the same account twice

`POST /api/connections/authorize` `{ provider, capabilities, label?, loginHint? }` answers the URL to open (the provider's own consent screen, in the same tab). The browser comes back to `GET /api/connections/callback/{provider}`, which answers a redirect to `/settings/connections?connect=<outcome>` (plus `connection=<id>` and `missing=<capabilities>`).

- **State and PKCE.** A random `state`, a PKCE verifier (S256) and a browser-binding value are made for each flow. The verifier is encrypted in the credential store; `state` and the binding are kept only as SHA-256 hashes on a `connection_flows` row. A flow is **single use** (the row is deleted before the code is exchanged) and valid for **10 minutes**.
- **Bound to the browser that started it.** The callback is public (the browser arrives from the provider without a bearer token), so what authenticates it is the `state` **and** an HttpOnly cookie set on the response that started the flow. The cookie is named after the flow, so two flows in two tabs do not clobber each other. A callback from another browser (another user's session, or none) is refused (`binding_invalid`) and changes nothing; the owner's own browser can still finish.
- **Upsert by account.** The account's stable id and email are read from the provider. Connecting an account that is already connected **updates** its connection (no duplicate); connecting a different account of the same provider creates a second connection. The same email at another provider is another connection.
- **Reconnect** is the same flow with the account as the login hint (the page's **Reconnect** button). A reconnect never turns a capability off by itself; the new grant replaces the old (the old refresh token is revoked at the provider).
- **Names.** The label is the owner's, unique among their connections ignoring case (so a label can resolve an account). Left blank it is `Google (person@example.test)`.
- **The result** is a closed set of outcomes: `connected`, `denied`, `expired`, `state_invalid`, `binding_invalid`, `exchange_failed`, `no_refresh_token`, `account_mismatch` (an incremental consent signed in as another account), `nothing_granted`, `provider_unavailable`, `limit` (25 connections per owner). The redirect carries no text from the provider.

The callback's `code` and `state` never reach a log line (the request log's URL is redacted for these paths), a span (the path is not traced) or nginx's access log (`infra/nginx/app.d/locations/connections-callback.conf`).

## How tokens are kept

| Token | Where | Notes |
|---|---|---|
| Refresh token | Credential store, user tier, purpose `connection_token`, name `<connectionId>.refresh` | Encrypted with `SECRETS_ENCRYPTION_KEY` under a key bound to the owner. Rotated by some providers on use. |
| Access token | The same, name `<connectionId>.access` | Short-lived; the row holds only when it expires. |
| PKCE verifier of a flow in progress | The same, name `flow.<flowId>` | Deleted with the flow. |
| The deployment's app secrets | Credential store, system tier, purposes `connection_app_google` and `connection_app_microsoft` | Write-only, set by the administrator. |

No token is a column. Deleting a connection deletes its tokens; deleting the user deletes everything (the connection and flow rows cascade, and the user-owned data registry lists both models). The access token is given **only to server code in `connections/`** (`ConnectionTokensService.getAccessToken`); tests scan every response, audit event, notification, row and log line for seeded token markers and read the credential rows to prove they are ciphertext.

**Refreshing.** `getAccessToken(connectionId, userId)` returns a valid access token, refreshing when fewer than **two minutes** remain.

- **One refresh at a time per connection:** an in-process single-flight map (callers in this process share one refresh) and a database lease on the row (`refresh_lease_until`, compare-and-set), so two API instances never refresh the same grant at once; a follower waits for the leader's result.
- **A rotated refresh token is stored before the old one is dropped,** and before the new access token is used. If it cannot be stored, the connection becomes `needs_reconnect` rather than carry on with a token the provider already retired.
- **A provider that cannot be reached changes nothing:** the status stays, the caller gets `CONNECTION_UNAVAILABLE` (503), the next call tries again. A refusal of the deployment's own app credentials (`invalid_client`) is the same: it is the administrator's to fix, not the owner's.
- **The daily `connections.health` job** (a queue job, server-only, enqueued by an enqueue-only cron at 04:17 UTC) refreshes connections that were neither used nor refreshed in the last 20 hours (paused ones too, so resuming works), so a token does not die of inactivity, and flags the ones that fail. It also deletes flows that expired.

## What "needs reconnect" means

The provider refused the saved grant (`invalid_grant`): the owner removed the app in their account at the provider, changed the password, the grant expired, or (for a Google project left in testing mode) the seven-day rule ended it. Then:

1. The connection's status becomes `needs_reconnect` with a stable reason code (`GRANT_REVOKED`, `NO_REFRESH_TOKEN`, `TOKEN_STORE_FAILED`), its tokens are deleted, and an audit event `connection.needs_reconnect` is written.
2. **The owner is notified once per episode** (the `connections.needs_reconnect` notification: bell, push and Android). Reconnecting clears the flag, so a later episode notifies again.
3. **Every caller fails with the typed error** `CONNECTION_NEEDS_RECONNECT` (409), which names the connection's label. A task or chat turns that into a question or a failed delivery; nothing falls back to another account.
4. The page lists it at the top, under **Needs reconnecting**, with a **Reconnect** button.

A **paused** connection is not used by anything (`CONNECTION_PAUSED`); its sign-in is kept alive by the health job.

## Choosing an account: `resolveConnection`

Every later issue calls `resolveConnection(userId, { provider?, capability, connectionId?, label? })` (`ConnectionResolverService`):

1. An explicit **id or label** wins (a label matches ignoring case). Not found, or another user's: `CONNECTION_NOT_FOUND`.
2. Otherwise **the default** for the capability's group. A default at two providers with none named is ambiguous too.
3. Otherwise, if **exactly one active** connection has the capability, that one.
4. Otherwise `CONNECTION_AMBIGUOUS` with the candidates' **labels** (the caller asks the owner), or `CONNECTION_NONE` when none has it.

A **paused** or **needs_reconnect** connection is never chosen: naming one fails with its typed error; a default that cannot be used is an error naming it, never a silent switch to the other account; and it is never counted as the single candidate.

## The API

| Route | Notes |
|---|---|
| `GET /api/connections` | Label, provider, account email, capabilities, what the provider granted, defaults, status and reason code, last use. Accounts that need a reconnect first. Never a token or a scope string. |
| `GET /api/connections/{id}` | The same, with `usedBy` (what uses it: tasks and deliveries, once E39.6 and later register them) |
| `GET /api/connections/providers` | Which providers can be connected here (`ready`, or the `reason`: `not_installed`, `disabled`, `not_configured`) and which kinds of account work, with a note to read before starting |
| `POST /api/connections/authorize` | Start a connection (above). Sets the binding cookie. |
| `GET /api/connections/callback/{provider}` | Public; the redirect URI to register at the provider |
| `PATCH /api/connections/{id}` | `label`, `capabilities`, `defaultFor`. A capability to add that the provider has not granted answers `consent.authorizeUrl` (and sets the binding cookie). |
| `POST /api/connections/{id}/pause`, `/resume` | |
| `POST /api/connections/{id}/test` | One cheap read call per switched-on capability: `{ results: [{ capability, ok, code }] }`, `code` a closed reason (`UNAUTHORIZED`, `FORBIDDEN`, `UNAVAILABLE`, ...) |
| `DELETE /api/connections/{id}` | Revoke at the provider (best effort: `revoked: false` when it could not be asked), clear references from tasks and deliveries (they show "connection removed"), delete tokens and the row |
| `GET /api/connections/admin/apps`, `PUT\|DELETE /api/connections/admin/apps/{provider}` | The administrator's apps. **No route reaches a user's connections.** |

Another user's connection is `404` (`CONNECTION_NOT_FOUND`) on every route, like a missing one. A viewer has no access. Audit events: `connection.created`, `.updated`, `.paused`, `.resumed`, `.needs_reconnect`, `.removed` (plus `.connect_started`, `.connect_failed`, `.app_saved`, `.app_removed`), with ids, provider and capabilities; never an email body or a token. The counter `app.connections.events` is by provider and outcome only.

## Administrator setup (bring your own app)

Hexactra does not ship a Google project or a Microsoft app: **the deployment's administrator registers one of each** and Hexactra's users connect their accounts through it. (This is the expected answer of E39.1; per-user apps are not part of this issue.)

1. Open **Administration → Browser agent → Connections**. Each provider shows the **redirect URI** to copy and a **setup checklist**.
2. **Google.** In the Google Cloud console create or choose a project, enable the Gmail, Calendar, Docs, Sheets and Drive APIs, configure the OAuth consent screen and **publish it** (a project left in testing mode ends every sign-in after about a week), create an OAuth client of type *Web application* with the redirect URI shown, and paste the client id and secret.
3. **Microsoft.** In the Microsoft Entra admin center register an application (choose the account types you want to allow), add the redirect URI as a *Web* redirect, create a client secret, paste the application (client) id and secret, and set the **tenant** (`common` allows work, school and personal accounts; `organizations`, `consumers` or a tenant id narrow it). Depending on the organization's settings, a user may need an administrator's approval.
4. Switch the provider on. It can be switched on only when the client id and secret are set.

The client id, tenant and switch are the `connections` system settings; the secret is a write-only system credential (`connection_app_google`, `connection_app_microsoft`), never returned. Switching a provider off stops new connections; existing connections keep refreshing. Removing the app deletes the id and secret and switches it off: connected accounts stay but cannot refresh until an app is set again.

Until the adapter for a provider is installed (E39.3, E39.4) the provider is listed as not available even when switched on. The Connect dialog explains which kinds of account work (personal accounts, work or school accounts) before the owner starts; that text is provisional until E39.1 is recorded.

## For the next issues

- **Adapters** implement `ConnectionProviderAdapter` (`src/connections/provider.ts`: `scopesFor`, `authorizeUrl`, `exchangeCode`, `refresh`, `revoke`, `capabilitiesGranted`, `probe`) over `OAuthClientService` (`src/oauth-client/`), and register with `ConnectionProviderRegistry` from their own module's `onModuleInit`. A refused grant must surface as an `OAuthClientError` of kind `invalid_grant`; `TokenSet.scopes` must list what the provider granted.
- **Callers** use `ConnectionResolverService.resolveConnection` to pick the account, then `ConnectionTokensService.getAccessToken` for a token, and `ConnectionsService.markUsed` to record the use. They catch `ConnectionError` and read `.code`.
- **Features that reference a connection** (deliveries, tool grants, triggers) register a `ConnectionUsageSource` with `ConnectionUsageRegistry`, so that removing a connection lists what uses it and clears the references.
- **No MCP tool** exposes a connection. If one ever does, it needs its own decision in [parity.md](parity.md).
