# Connections: your Google and Microsoft accounts

Epic E39 (#581) lets the owner connect their accounts at Google and Microsoft **once**, with a name they choose and a switch for each of Mail, Calendar and Documents, so that tasks, chats and deliveries can use them later. This chapter is the foundation (issue E39.2, #599): the model, the capabilities, the defaults, how tokens are kept, what "needs reconnect" means, and the administrator's setup. What uses a connection is built on top of it by later issues: the Google and Microsoft providers (E39.3, E39.4), deliveries after a run (E39.6), agent tools (E39.7), triggers (E39.8) and generic MCP connections (E39.9).

**Status, honestly.** The model, the flows, the token service, the pages and the CLI are implemented and tested against a **fake provider** (`apps/api/test/support/fake-connection-provider.ts`). The **Google provider** (E39.3, #601: [Google](#google) below) is implemented and tested against an **in-process fake of Google's endpoints**; the Microsoft provider is E39.4, and until it is installed Microsoft is listed as "not available on this deployment yet". **No real Google or Microsoft account has been connected yet:** the real-account checks of E39.3 need the owner and are listed at the end of the Google chapter. The app model below (bring your own app), the account types and the setup checklists follow the decision record [decisions/connections-auth.md](decisions/connections-auth.md) (E39.1, #598), which is itself **provisional**: derived from documentation, not yet verified on a real account. That record proposes a seventh capability, `mail_modify` (archive, labels, mark read, drafts); **E39.3 adds it** (it is a switch like the others), because at both providers it needs a higher permission than sending.

## In short

- A **connection** is one account at one provider: `Work` (a Google account), `Personal` (another Google account), `Outlook` (a Microsoft account). The same owner can have several of each.
- Each connection has **seven switches** (the capabilities): `mail_read`, `mail_send`, `mail_modify`, `calendar_read`, `calendar_write`, `docs_read`, `docs_write`. Read is never write. The page shows them as Mail, Calendar and Documents, each "read", "read and write" (Mail: also "organize").
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
| The code | `apps/api/src/connections/` (the capability interfaces `capabilities.ts`, the Google provider `google/`, test doubles `testing/` and `google/testing/`), `apps/api/prisma/fragments/connections.prisma`, `apps/web/src/pages/ConnectionsPage.tsx`, `apps/cli/src/connections.command.ts` |
| Permissions | `connections:read` and `connections:write` (contributors and organization admins); the administrator's page uses `system_settings:read` and `:write` |

## Capabilities, groups and defaults

| Capability | The group the owner sees | What it allows |
|---|---|---|
| `mail_read` | Mail: read | Read and search mail |
| `mail_send` | Mail: read and write | Send mail |
| `mail_modify` | Mail: organize | Archive, label and mark messages as read, and save drafts. A more sensitive permission than sending (Gmail `gmail.modify` is a restricted scope), so it is its own switch |
| `calendar_read` | Calendar: read | See events and free time |
| `calendar_write` | Calendar: read and write | Create and change events |
| `docs_read` | Documents: read | Read documents, spreadsheets and files |
| `docs_write` | Documents: read and write | Create and change documents, add spreadsheet rows, save files |

- **A write capability brings its read capability.** Switching `mail_send` (or `mail_modify`) on switches `mail_read` on; switching `mail_read` off switches `mail_send` and `mail_modify` off. A provider that grants a write without its read leaves it off.
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

Hexactra does not ship a Google project or a Microsoft app: **the deployment's administrator registers one of each** and Hexactra's users connect their accounts through it. (This is the decision record's recommendation; per-user apps are not part of this issue.)

1. Open **Administration → Browser agent → Connections**. Each provider shows the **redirect URI** to copy and a **setup checklist**.
2. **Google.** In the Google Cloud console create or choose a project, enable the Gmail, Calendar, Docs, Sheets and Drive APIs, configure the Google Auth Platform (the OAuth consent screen) as **External** and **publish it** ("In production": a project left in testing mode ends every sign-in after about a week; an unverified app is fine for your own use, users accept a warning), create an OAuth client of type *Web application* with the redirect URI shown (an https address with a public domain name), and paste the client id and secret. For Google Workspace, mark the client trusted in the Admin console if your organization blocks unverified apps.
3. **Microsoft.** In the Microsoft Entra admin center register an application ("any organizational directory and personal Microsoft accounts"), add the redirect URI as a *Web* redirect, add the delegated Graph permissions you will use plus `offline_access` and `User.Read`, create a client secret (note its expiry date: sign-ins stop refreshing when it expires), paste the application (client) id and secret, and set the **tenant** (`common` allows work, school and personal accounts; `organizations`, `consumers` or a tenant id narrow it). A work or school account of another organization needs that organization's administrator to approve the app once.
4. Switch the provider on. It can be switched on only when the client id and secret are set.

The client id, tenant and switch are the `connections` system settings; the secret is a write-only system credential (`connection_app_google`, `connection_app_microsoft`), never returned. Switching a provider off stops new connections; existing connections keep refreshing. Removing the app deletes the id and secret and switches it off: connected accounts stay but cannot refresh until an app is set again.

Until the adapter for a provider is installed (E39.3, E39.4) the provider is listed as not available even when switched on. The Connect dialog explains which kinds of account work (personal accounts, work or school accounts) before the owner starts; that text is provisional until the record's experiments are done.

## Google

Epic E39 (#581), issue E39.3 (#601). The Google provider signs several Google accounts in and gives the rest of the console one typed set of operations for mail, calendar and documents. **Nothing that uses a connection talks to Google directly**: deliveries (E39.6), agent tools (E39.7) and the mail trigger (E39.8) call the neutral interfaces below, and the Microsoft provider (E39.4) implements the same ones.

### What the owner gets, in plain words

| Capability | What the agent can do with the account | The Google permission asked | Google's tier |
|---|---|---|---|
| Mail: read (`mail_read`) | Search and read messages and attachments, list labels | `gmail.readonly` | restricted |
| Mail: send (`mail_send`) | Send a message from the account's own address | `gmail.send` | sensitive |
| Mail: organize (`mail_modify`) | Archive, label, mark read or unread, create and send drafts | `gmail.modify` | restricted |
| Calendar: read (`calendar_read`) | List calendars and events, see free and busy time | `calendar.readonly` | sensitive |
| Calendar: write (`calendar_write`) | Create, change and delete events (nobody is emailed unless asked) | `calendar.events` | sensitive |
| Documents: read (`docs_read`) | Read documents and spreadsheets, find files the app made or you picked | `drive.file`, `documents.readonly`, `spreadsheets.readonly` | non-sensitive and sensitive |
| Documents: write (`docs_write`) | Create documents, spreadsheets, folders and files, add text and spreadsheet rows | `drive.file`, `documents`, `spreadsheets` | non-sensitive and sensitive |

Always asked: `openid`, `email` and `profile` (who the account is). Only the permissions of the switched-on capabilities are asked; switching one on later asks for just the new permission (incremental consent). Only mail read and mail organize ask a restricted permission, so a deployment that never switches those on never meets the restricted tier. The decision record is the source for this table; the code is `google/google.scopes.ts` and a test pins it.

**Where this issue and the decision record differ, the record wins:** (1) `mail_modify` is a seventh switch; `createDraft`, sending a saved draft (`send({ draftId })`) and `modify` need it, while `send(message)` needs only `mail_send`. (2) Documents are reached **by id, or from files the owner picked or the app created**, not by a search of the whole Drive (see "Only files you picked" below), because the narrow `drive.file` permission is the one the record chose.

### Setup checklist for the administrator

Follows the decision record (provisional until the experiments of #598 are done).

1. In the Google Cloud console create a project and enable the **Gmail, Google Calendar, Google Docs, Google Sheets and Google Drive** APIs. A switched-off API shows up in the connection's **Test** as "the service is switched off" (`API_DISABLED`).
2. **Google Auth Platform:** set the audience to **External** and the publishing status to **In production**. A project left in **Testing** ends every sign-in after about seven days (the connection then says it needs to be connected again). You do not submit the app for verification for your own use; users click through the "Google hasn't verified this app" page. Adding the restricted Gmail permissions is what makes Google say verification is needed: for your own accounts you do not take that step.
3. **Clients, Create client:** type **Web application**. Authorised redirect URI, to copy exactly: `<console base>/api/connections/callback/google` (the page under Administration shows it with your address filled in). It must be `https` with a public domain name (a tunnel or a reverse proxy is enough); Google refuses a raw IP address and a private name.
4. Paste the client id and secret into **Administration, Connections** and switch Google on.
5. Google Workspace only: in the Admin console (Security, API controls) mark the client **Trusted** if your organization blocks unverified apps.
6. Connect an account; on the consent screen tick **every** permission asked (an unticked one leaves that capability off, and the page says which).
7. Use an AI model provider whose terms do not train on API inputs: Google's API user-data policy ("limited use") applies to Gmail data whether or not the app is verified.

### Only files you picked

With the narrow `drive.file` permission, Google lets the app see **only files it created, or files you picked** for it in Google's file picker. It cannot list, search or open the rest of your Drive. Concretely:

- `searchFiles`, `getFile`, putting a file into a folder and `registerPickedFile` work on those files only. A file you did not pick looks like "not found" to the app.
- Reading and changing a **document or spreadsheet by its id or link** goes through the Docs and Sheets permissions, which accept any file the account can itself open: paste the link and it works, without a pick.
- A folder the app did not create is not reachable until you pick it. The app creates and keeps one folder of its own for what it saves.
- Picking a file needs Google's picker in the web app; that button is E39.10. Until then `registerPickedFile(id)` is what the server calls after a pick: it checks that the account can reach the file and returns its details. Nothing is stored on our side: Google remembers the pick, and `searchFiles` shows it.

### What is not supported, and why

Searching the whole Drive (needs the restricted `drive.readonly`), shared-drive administration, Gmail filters and settings, Google Chat, Meet, Contacts and Tasks (out of scope), sending as another address (the `From` is always the connected account; send-as aliases are not used), push notifications for new mail (E39.8 polls), accounts in Google's Advanced Protection programme (Google allows only verified apps there), and the Google device flow (it does not offer these permissions).

### The neutral interfaces

`apps/api/src/connections/capabilities.ts` defines `MailCapability`, `CalendarCapability` and `DocumentsCapability` with zod schemas for every input and output. A service asks `ConnectionCapabilities` (`connection-capabilities.service.ts`) for the one it needs, after it has chosen the account with `ConnectionResolverService`:

```ts
const mail = capabilities.mail({ connectionId, userId, signal });   // signal: Stop (#582)
const page = await mail.search({ from: 'person-b@example.test', unread: true, pageSize: 25 });
```

The provider is resolved from the connection, so the same code works for a Google and a Microsoft account. Every call goes through one gate (`capability-hub.ts`), so no provider and no caller skips a step:

1. The connection is read now: paused is `CONNECTION_PAUSED`, needing a reconnect is `CONNECTION_NEEDS_RECONNECT`.
2. **The capability gate, before any request:** a capability that is off is `CAPABILITY_OFF`; one the provider did not grant is `PERMISSION_MISSING` (offer an incremental consent).
3. The arguments are validated (`INVALID_INPUT`, listing the field paths and never the values) and checked against the limits.
4. The adapter runs; its result is validated against the result schema (no provider type or extra field gets out), and cut at the limits with `truncated`.

Every method is tagged **read or write** and with the capability it needs (`METHOD_TAGS`): mail search, get, attachment download and label list need `mail_read`; `send` needs `mail_send` (and `mail_modify` for a saved draft); `createDraft` and `modify` need `mail_modify`; calendar reads need `calendar_read`, create, update and delete need `calendar_write`; document, sheet and file reads need `docs_read`, everything that creates or changes needs `docs_write`.

**Typed errors** (`CapabilityError`, one class): `CONNECTION_NEEDS_RECONNECT`, `CAPABILITY_OFF`, `PERMISSION_MISSING`, `NOT_FOUND`, `RATE_LIMITED { retryAfterMs }`, `QUOTA_EXCEEDED`, `TOO_LARGE`, `PROVIDER_ERROR { status }`, plus `CONNECTION_PAUSED`, `CONNECTION_NOT_FOUND`, `INVALID_INPUT`, `NOT_SUPPORTED` and `ABORTED`. The text is fixed and no provider message is ever copied, because it can carry a subject, an address or a file name. `details.outcomeUnknown` marks a write that was sent and got no definite answer (see below): it is not `retryable`.

**Limits, enforced here and not by callers:** message and document text 50,000 characters, an attachment or uploaded file 10 MB (all attachments of one outgoing message 18 MB, because Gmail's 25 MB limit counts the encoding), a sheet read or append 5,000 cells, a list page at most 50 items (the default is 25). A limit that is exceeded on a read is a cut with `truncated: true`; on a write it is `TOO_LARGE`.

### How the Google adapter works

- **Plain `fetch`, not Google's client library.** About twenty REST calls are needed. `googleapis` would add tens of megabytes to the API image and a large dependency surface, and the attack surface of every transitive package, for typed wrappers that are small to write and test here. Requests go through the console's `OutboundHttp` (HTTPS only, SSRF-checked, no redirects, bounded responses, now with `PUT`, `PATCH`, `DELETE` and an abort signal). No dependency was added.
- **Sign-in:** authorization code with PKCE (S256), `access_type=offline`, `include_granted_scopes=true`, `prompt=consent` only when a refresh token is needed (a new connection or a reconnect, not an incremental consent), `login_hint` for a known account. The account's stable id (`sub`) and email come from Google's userinfo endpoint. Revoke uses Google's revoke endpoint.
- **Mail:** search builds a Gmail query from the structured `MailQuery`; every value is quoted and cannot add an operator (`OR`, `in:anywhere`, `label:` inside a value are plain text). A label is a label id, never part of the query. Reading prefers the plain part and reduces HTML to text on the server. Sending builds an RFC 5322 message with a small tested composer: UTF-8 subjects and names as encoded words, plain and HTML parts, attachments, `In-Reply-To` and `References` for a reply (and the thread), `From` always the connected account, **and a newline in a subject, name, address, file name or content type is refused, never stripped**.
- **Calendar:** times carry explicit offsets. `sendUpdates` is `none` unless `notifyAttendees` is true, on create, update and delete: **an agent must not email people by side effect**. An event is created with a client-generated id (from the caller's `idempotencyKey`), so a retry after a lost answer finds the same event (409) instead of making a second.
- **Documents:** Drive for search, metadata, folders and upload; Docs for create, read (structure flattened to text, tables as tab-separated rows) and append; Sheets for read, append and create. **Spreadsheet values are written `RAW`: a cell that starts with `=` is text, never a formula, and there is no flag to change that.**
- **Reliability:** at most 3 tries on `429` and `5xx` with exponential backoff and jitter, honouring `Retry-After` (a wait over 30 seconds is not slept through: the caller gets `RATE_LIMITED` with `retryAfterMs`); at most 4 requests in flight per connection; timeouts; an abort signal that cancels a wait, a backoff sleep and an in-flight request; a `401` forces one token refresh and one retry, then means the account must be connected again. A request that is **not safe to repeat** (a send, an append, creating a file) is retried only on `429`, never after a `5xx` or a lost connection.
- **`appendRows` and an unknown outcome.** If the append is answered with a `5xx` or the connection is lost, the rows may or may not have been written. The adapter does **not** retry (that could duplicate a row) and returns `{ updatedRange: null, ambiguous: true }`; the caller decides (read the sheet, or accept a possible duplicate). A `429` was not applied and is retried. Mail `send` after an unknown outcome throws `PROVIDER_ERROR` with `outcomeUnknown: true` for the same reason.
- **Privacy in telemetry.** Spans, metrics and logs carry the service, the operation name (`messages.list`), the connection id, sizes, attempt counts, durations and status codes. **Never** a subject, an address, a body, a file name, a search query, a URL or a cell. A test seeds markers in all of them and scans every span, metric, log line and error. The metrics are `app.connections.google.requests` (by service and outcome) and `app.connections.google.duration_ms` (by service).
- **Test:** `POST /api/connections/{id}/test` makes one cheap read per switched-on capability: the label list (mail), the calendar list, a Drive `about` call (documents). The reason codes are a closed set: `UNAUTHORIZED`, `FORBIDDEN`, `API_DISABLED`, `RATE_LIMITED`, `UNAVAILABLE`, `FAILED`.

### Test doubles for the code that uses connections

- `connections/testing/` (`createTestCapabilities()`): an in-memory `FakeCapabilityProvider` behind the same gate, with one account per connection (`fake.account(connectionId).addMessage(...)`), failure injection (`failNext`), a call log and latency for abort tests. No network, no database.
- `connections/google/testing/` (`FakeGoogle`): an in-process fake of the Google endpoints (OAuth, Gmail, Calendar, Drive, Docs, Sheets) that implements `OutboundHttp`, checks scopes and bearer tokens, records every request and can fail, drop or delay the next ones. Built from the documented response shapes with invented data; no real response is recorded in the repository.

### What has not been verified, and what the owner must do

Everything above was tested against the fakes: **no real Google account was used.** The shapes of Google's responses and errors are from the documentation as the author knew it and may differ in detail. With the owner, on the deployed stack, for each supported account type of the decision record (a personal Gmail account, a Google Workspace account): connect, press **Test**, then run a manual script or admin action that sends a mail to the same account, creates and deletes a calendar event, creates a spreadsheet and appends a row. Record pass or fail per capability and account type, with no mailbox content. Also to check by hand: that Google accepts base64 content in the Drive multipart upload, that an unverified In-production app keeps its refresh token for more than a week with the restricted Gmail permissions (decision record, G4a), and that `drive.file` shows a picked file in a search.

## For the next issues

- **Adapters** implement `ConnectionProviderAdapter` (`src/connections/provider.ts`: `scopesFor`, `authorizeUrl`, `exchangeCode`, `refresh`, `revoke`, `capabilitiesGranted`, `probe`) over `OAuthClientService` (`src/oauth-client/`), and register with `ConnectionProviderRegistry` from their own module's `onModuleInit`. A refused grant must surface as an `OAuthClientError` of kind `invalid_grant`; `TokenSet.scopes` must list what the provider granted.
- **Callers** use `ConnectionResolverService.resolveConnection` to pick the account, then `ConnectionCapabilities` (`mail`, `calendar`, `documents`) to use it: the neutral interfaces, the gate, the limits and `CapabilityError` ([Google](#google) above). They never ask for a token. The resolver's own `ConnectionError`s are `.code` strings too.
- **Features that reference a connection** (deliveries, tool grants, triggers) register a `ConnectionUsageSource` with `ConnectionUsageRegistry`, so that removing a connection lists what uses it and clears the references.
- **No MCP tool** exposes a connection. If one ever does, it needs its own decision in [parity.md](parity.md).

## Microsoft: Outlook, Calendar, OneDrive, Word and Excel (E39.4, #602)

The Microsoft provider signs in work, school and personal Microsoft accounts and gives the same mail, calendar and documents operations as the Google provider through Microsoft Graph (v1.0). A delivery or an agent tool written against the neutral interface (`src/connections/capabilities.ts`) works with either without knowing which. Code: `apps/api/src/connections/microsoft/`; the fake Graph for tests: `connections/microsoft/testing/`.

**Status, honestly.** Everything below is implemented and tested against an **in-process fake of Graph** (`FakeGraph`, invented data only). **No real Microsoft account has been connected yet**, and the Microsoft documentation pages were not reachable from the environment this was written in, so every statement about how Graph behaves comes from the decision record ([decisions/connections-auth.md](decisions/connections-auth.md), itself provisional) and from knowledge of the documentation, not from an experiment. The items that need a real account are listed under "Not confirmed yet" and in the issue's verification section. Where the record and the issue disagree the record wins; the differences are listed under "Decisions".

### What each kind of account can do

One table in code (`src/connections/capability-matrix.ts`) says, for every method, whether Google, a Microsoft work or school account and a Microsoft personal account can do it: **Yes**, **Limited** (how), or **No** (why). The Microsoft adapter answers `NOT_SUPPORTED` for a method the table marks "No" for the account's kind (and makes no request); `GET /api/connections/providers` returns the same rows (`capabilityMatrix`, with `matrixColumns` for the provider) so the Connect dialog and the task UI never offer an unsupported choice; and a test fails when this table and the code disagree (`UPDATE_CAPABILITY_MATRIX_DOC=1 npx jest --config ./test/jest.config.js capability-matrix` from `apps/api` rewrites it: review the diff).

The Google column follows the decision record (the narrow `drive.file` permission: only files the app created or the owner picked); the Google adapter's own section is the authority on Google.

<!-- capability-matrix:start -->
| Method | Needs | Google | Microsoft work or school | Microsoft personal |
|---|---|---|---|---|
| `mail.search` | `mail_read` | Yes | Limited: Free text goes through Microsoft search; the other filters are applied to each page, so a page can be short: follow the next page. | Limited: Free text goes through Microsoft search; the other filters are applied to each page, so a page can be short: follow the next page. |
| `mail.get` | `mail_read` | Yes | Yes | Yes |
| `mail.getAttachment` | `mail_read` | Yes | Limited: File attachments only; an attached message or a link is not downloadable. | Limited: File attachments only; an attached message or a link is not downloadable. |
| `mail.createDraft` | `mail_modify` | Yes | Yes | Yes |
| `mail.send` | `mail_send` | Yes | Limited: With send-only permission there is no message id in the answer and attachments must be under 3 MB; with the modify switch on, larger ones are sent through a draft. | Limited: With send-only permission there is no message id in the answer and attachments must be under 3 MB; with the modify switch on, larger ones are sent through a draft. |
| `mail.modify` | `mail_modify` | Yes | Limited: Microsoft has folders and categories, not labels: archive moves to Archive, labels map to categories (`category:<name>`) and a folder (`folder:<id>`) moves the message. | Limited: Microsoft has folders and categories, not labels: archive moves to Archive, labels map to categories (`category:<name>`) and a folder (`folder:<id>`) moves the message. |
| `mail.listLabels` | `mail_read` | Yes | Limited: Returns folders and categories, with the kind. | Limited: Returns folders and categories, with the kind. |
| `calendar.listCalendars` | `calendar_read` | Yes | Yes | Yes |
| `calendar.listEvents` | `calendar_read` | Yes | Limited: Text matches the event title. | Limited: Text matches the event title. |
| `calendar.freeBusy` | `calendar_read` | Yes | Yes | Limited: Personal accounts have no free/busy service: computed from the events of the calendar. |
| `calendar.createEvent` | `calendar_write` | Yes | Limited: Changing an event that has attendees emails them at Microsoft, which cannot be turned off: it is refused unless notifying is allowed. A video conference is a Teams meeting. | Limited: Changing an event that has attendees emails them at Microsoft, which cannot be turned off: it is refused unless notifying is allowed. No video conference. |
| `calendar.updateEvent` | `calendar_write` | Yes | Limited: Changing an event that has attendees emails them at Microsoft, which cannot be turned off: it is refused unless notifying is allowed. | Limited: Changing an event that has attendees emails them at Microsoft, which cannot be turned off: it is refused unless notifying is allowed. |
| `calendar.deleteEvent` | `calendar_write` | Yes | Limited: Changing an event that has attendees emails them at Microsoft, which cannot be turned off: it is refused unless notifying is allowed. | Limited: Changing an event that has attendees emails them at Microsoft, which cannot be turned off: it is refused unless notifying is allowed. |
| `documents.searchFiles` | `docs_read` | Limited: Only files the app created or you picked (the narrow Drive permission). | Yes | Yes |
| `documents.getFile` | `docs_read` | Limited: Only files the app created or you picked (the narrow Drive permission). | Yes | Yes |
| `documents.registerPickedFile` | `docs_read` | Yes | Yes | Yes |
| `documents.readDocument` | `docs_read` | Limited: Only files the app created or you picked (the narrow Drive permission). | Limited: Word (.docx) and plain-text files; a PDF or an older .doc is not read. | Limited: Word (.docx) and plain-text files; a PDF or an older .doc is not read. |
| `documents.createDocument` | `docs_write` | Yes | Limited: Creates a plain Word (.docx) file of paragraphs. | Limited: Creates a plain Word (.docx) file of paragraphs. |
| `documents.appendToDocument` | `docs_write` | Limited: Only files the app created or you picked (the narrow Drive permission). | Limited: Rewrites the whole .docx file as a new version; a concurrent edit is detected and refused (conflict). | Limited: Rewrites the whole .docx file as a new version; a concurrent edit is detected and refused (conflict). |
| `documents.readSheet` | `docs_read` | Limited: Only files the app created or you picked (the narrow Drive permission). | Yes | No: Excel workbook calls are not confirmed to work on personal OneDrive; refused until an experiment shows they do. |
| `documents.appendRows` | `docs_write` | Limited: Only files the app created or you picked (the narrow Drive permission). | Limited: Rows go into the first table of the sheet, or below the used range when there is none. A failure that leaves it unknown is reported, not retried. | No: Excel workbook calls are not confirmed to work on personal OneDrive; refused until an experiment shows they do. |
| `documents.createSpreadsheet` | `docs_write` | Yes | Limited: Creates an Excel (.xlsx) file with the header row as text. | Limited: Creates an Excel (.xlsx) file with the header row as text. |
| `documents.uploadFile` | `docs_write` | Yes | Yes | Yes |
| `documents.createFolder` | `docs_write` | Yes | Yes | Yes |
<!-- capability-matrix:end -->

### Administrator setup: the Microsoft app (bring your own app)

1. In the Microsoft Entra admin center (or the Azure portal) open **App registrations, New registration**. Name it. For **Supported account types** choose **Accounts in any organizational directory and personal Microsoft accounts**. (A personal Microsoft account needs an Entra tenant to register in: a free Azure sign-up creates one.)
2. Platform **Web**, redirect URI `<console base>/api/connections/callback/microsoft` (copy it from Administration, Browser agent, Connections). `http://localhost` is accepted for development; anything else must be https.
3. **API permissions, Add a permission, Microsoft Graph, Delegated** (never Application): `offline_access` and `User.Read` always, plus those of the capabilities you will let owners switch on: `Mail.Read`, `Mail.Send`, `Mail.ReadWrite`, `Calendars.Read`, `Calendars.ReadWrite`, `Files.Read`, `Files.ReadWrite`.
4. **Certificates and secrets, New client secret.** Copy the **value** at once (it is shown once) and note the expiry date (at most 24 months): when it expires every connection stops refreshing at the same moment.
5. Paste the application (client) id and the secret into the administrator page, set the **tenant** (`common` for work, school and personal accounts; `organizations`, `consumers` or a tenant id narrow it) and switch Microsoft on. Leave publisher verification alone: it is optional and out of reach for an individual.

What the console asks for, per capability (and the plain-words consent the owner reads):

| Capability | Microsoft permission | What the owner is agreeing to |
|---|---|---|
| always | `openid`, `email`, `profile`, `offline_access`, `User.Read` | Sign in, know which account this is, and stay signed in |
| `mail_read` | `Mail.Read` | Read your mail |
| `mail_send` | `Mail.Send` | Send mail as you (no sending as someone else) |
| `mail_modify` | `Mail.ReadWrite` | Read and change your mail: drafts, folders, categories, read state (**not** sending) |
| `calendar_read` | `Calendars.Read` | See your calendars |
| `calendar_write` | `Calendars.ReadWrite` | Create and change events |
| `docs_read` | `Files.Read` | Read **all** your OneDrive files (Microsoft has no narrower permission) |
| `docs_write` | `Files.ReadWrite` | Change **all** your OneDrive files |

Only what the switched-on capabilities need is asked; switching one on later asks for just the added permission. A write brings its read. Microsoft's `Mail.ReadWrite` includes read but **not** send, so `mail_send` is its own switch. Personal accounts have a narrower `Files.ReadWrite.AppFolder` that the record lists as "expected, confirm"; it is not used.

### Work and personal accounts of one person are two connections

The account's stable id is stored as `accountId` in the form **`<tenant id>:<object id>`**, both lower-case GUIDs from the sign-in's id token. A personal account is always in the consumer tenant `9188040d-6c67-4c5b-b112-36a304b66dad`, so the same person's work and personal accounts have different ids and become two connections whose tokens never cross (tested). When no account is named, the consent page asks the owner to **pick the account** (`prompt=select_account`), so a browser signed in to the work account is not silently connected as that account when the personal one was meant; a reconnect names its account (`login_hint`).

### When an administrator must approve (`ADMIN_CONSENT_REQUIRED`)

A work or school account of another organization may be blocked from consenting until that organization's administrator approves the app (the "Need admin approval" screen), depending on its user-consent settings. The console tells this apart from the owner declining:

- the redirect carries `connect=admin_consent_required` (not `denied`); the web page says an administrator must approve and that the link is on the connections page;
- `GET /api/connections/providers` returns `adminConsentUrl` for Microsoft: the address an administrator of the owner's organization opens to approve the app for everyone (`https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=…`, built from the app and nothing personal). The owner sends it on; afterwards they connect again;
- the typed error is `ADMIN_CONSENT_REQUIRED` (`CapabilityError`, with `details.adminConsentUrl`), and at the token endpoint it is an `OAuthClientError` with `oauthError: 'admin_consent_required'`. No text from Microsoft is shown.

An owner who clicked "Cancel" gets `denied` as before.

### What removing access means

Microsoft has **no per-token revoke for delegated sign-ins**. Disconnect deletes the tokens on the console (and reports `revoked: false`, because Microsoft could not be asked). The app itself stays in the owner's Microsoft account until they remove it there: for a personal account at the account's **Privacy, Apps and services** page (`account.live.com/consent/Manage`); for a work or school account at **My Apps** (`myapps.microsoft.com`, the app's menu), or an administrator deletes the grant. Say so to owners who disconnect for security.

### Differences from Gmail (mail)

| | Gmail | Outlook (Graph) |
|---|---|---|
| Labels | one message, many labels | **folders** (one per message) and **categories** (many). Label ids are `folder:<id>` (`folder:inbox`, `folder:archive`, … are well-known aliases) and `category:<name>`. `listLabels` returns both, folders first, with `kind` `system` (the well-known folders) or `user` |
| Archive | remove `INBOX` | `archive: true` moves to the Archive folder; `archive: false` back to the Inbox; removing `folder:inbox` is archiving. A message is in one folder: more than one destination is `INVALID_INPUT` |
| Search | one query language | `$filter` for structured queries, `$search` (KQL) when there is free text, a subject or a name, and the two cannot be combined at Graph: in search mode the dates, unread, attachment and category filters are applied to each page, so **a page can be short or empty: follow `nextPageToken` until it is null** |
| Send | one call | with `mail_modify` on, a draft is created and sent (a retry after a lost answer can look at the draft); with send-only permission, `/me/sendMail`, which returns **no message id** (the answer is a placeholder `sendmail:<uuid>`) and takes attachments under 3 MB |
| Drafts | `gmail.modify` | need `mail_modify` (`Mail.ReadWrite`); `send({ draftId })` also needs it |
| Message ids | stable | requested as immutable ids (`Prefer: IdType="ImmutableId"`) so a move does not change them |
| Body | plain part preferred | the text body is asked for (`Prefer: outlook.body-content-type="text"`); a message with both `text` and `html` is sent as HTML only (Graph has one body) |
| Attachments | all | file attachments only: an attached message or a link is `NOT_SUPPORTED` |

Queries that cannot be expressed: a search that is both free text and a name or subject is one KQL expression, which Graph evaluates its own way; `unread`, `hasAttachment`, dates and category filters never narrow Graph's own search, only the page that comes back. Every value is escaped (an OData string doubles its quotes; a KQL phrase is quoted with quote and backslash escaped), so operators inside a value are text.

### Calendar: nobody is emailed by surprise

Graph emails the attendees when an event that has any is created, changed or cancelled, and, as far as the documentation read for the decision record says, offers no general "do not notify" switch. The neutral interface promises that an agent does not email people by side effect, so:

- creating an event with attendees, adding attendees, changing an event that has attendees, or cancelling one **fails with `NOTIFY_REQUIRED` unless `notifyAttendees` is true**, before any request that could send; nothing is created or changed;
- with `notifyAttendees: true` the event is written and Graph sends its invitation, update or cancellation (an organizer's cancellation is `POST …/cancel`, which is what tells the attendees);
- an event without attendees, and an event somebody else organizes (only the organizer's changes are sent), need nothing.

Times: every request asks for `Prefer: outlook.timezone="UTC"`, so instants come back with `Z`; an event is written as the wall time in the event's `timeZone` (UTC when none is given) with that zone named, and an all-day event is a date. `freeBusy`: `getSchedule` on work and school accounts; **computed from the calendar view on personal accounts** (and whenever calendars are named), clipped to the window. A video conference is a Teams meeting and is `NOT_SUPPORTED` on a personal account. A retried create with an `idempotencyKey` returns the first event (Graph's `transactionId`).

### Documents: OneDrive, Word, Excel

- **Files:** OneDrive for everything. `searchFiles` is Graph's drive search (words in the name or content, under the root or a folder) or a folder listing; a kind filter and short pages work as for mail. A file is uploaded in one request under **4 MB** and through an **upload session** above it, in chunks; a name that clashes is kept and the new file renamed. Names OneDrive refuses (`" * : < > ? / \ |`) become `-`. There is nothing to "pick" at Microsoft: `registerPickedFile` confirms the file can be reached.
- **Word:** Graph cannot edit a `.docx` in place. `createDocument` uploads a generated plain `.docx` (paragraphs; a built-in writer of about 150 lines on `node:zlib`, no library, so the API image does not grow); `readDocument` extracts the text of a `.docx` here (and reads plain-text files; a PDF or an older `.doc` is `NOT_SUPPORTED`); `appendToDocument` **downloads the file, adds paragraphs and uploads a new version with the file's eTag as an `If-Match` precondition**, so a change made in the meantime is `CONFLICT`, never overwritten. Every other part of the file (styles, images, tables) is carried through untouched. A file without an eTag is refused rather than risked.
- **Excel:** the workbook API on the file. `readSheet` reads the used range or a given range (cut at the cell limit, marked `truncated`). `appendRows` writes into the **first table of the sheet** when it has one (rows padded to the table's width; a wider row is `INVALID_INPUT`) and otherwise **below the used range**, starting at its first column. **Values are written as values:** a string Excel would read as a formula (it starts with `=`, `+`, `-` or `@`) is stored with a leading apostrophe, which Excel keeps as text; numbers, booleans and ordinary text are unchanged. A failure that leaves it unknown whether the rows were written is **not retried** for a table (`ambiguous: true`, `updatedRange: null`); writing to a range may be repeated because the same cells end the same. `createSpreadsheet` uploads a generated `.xlsx` with the header row as text.
- **Personal accounts:** the workbook API is documented for OneDrive for Business and SharePoint; **it is not confirmed to work on personal OneDrive**, so `readSheet` and `appendRows` are marked unsupported for personal accounts until an experiment shows otherwise (`NOT_SUPPORTED`, reason `ACCOUNT_TYPE`). Everything else works on a personal account.

### Reliability and privacy

- **Plain `fetch`** against `graph.microsoft.com/v1.0` and `login.microsoftonline.com`, with small typed wrappers: no Microsoft SDK (the official client is large and pulls in its own HTTP stack; a dozen endpoints are used). Recorded here as the issue asks.
- **Backoff:** at most 3 tries. `429` is retried after `Retry-After` (a wait longer than 30 s is returned as `RATE_LIMITED` with `retryAfterMs` instead of waiting); `502/503/504`, a timeout and a dropped connection are retried **only for requests that are safe to repeat** (reads, deletes, idempotent writes). A write that failed in a way that leaves it unknown is not repeated: the error says `reason: 'AMBIGUOUS'`.
- **Concurrency:** 3 requests at a time per connection (Graph allows 4 per mailbox). **Timeout** 30 s per request. `AbortSignal` cancels a call under way and one still waiting for its turn.
- **Sends do not happen twice.** With a draft, an ambiguous failure of the send is checked by looking at the draft (gone means sent); a caller's `idempotencyKey` is remembered for **ten minutes in this process** (a short-lived server-side record, not shared between API instances: run one API instance, or do not retry across instances) and a repeated call returns the first send. With send-only permission a lost answer cannot be checked, so the same key is refused with `CONFLICT` (`reason: SEND_AMBIGUOUS`) until the owner looks at the sent folder.
- **A 401** forces one refresh of the access token and one retry; a refused grant is the token service's `CONNECTION_NEEDS_RECONNECT`. A Microsoft refresh token **rotates on every refresh**: the token service stores the new one before the old is dropped.
- **No content in logs, spans or metrics:** telemetry carries the operation name, the connection id, the status, request and response sizes, the attempt and the duration. Never a subject, an address, a body, a file name, a query or a cell; Graph's own error text is never copied (only its `error.code`, a stable identifier). A marker test checks it (`test/microsoft/microsoft-privacy.spec.ts`).
- **Page tokens** are opaque, can only be used for the operation that issued them and can never address another user's mailbox.

### Decisions where this differs from the issue

The decision record wins where it disagrees; each of these is also in the pull request.

- **`mail_modify` exists** (record, "What changes in the epic's capability model"): drafts and `modify` need `Mail.ReadWrite`, which the issue's list names without saying which capability it belongs to.
- **Send with `Mail.Send` alone cannot use a draft**, so large attachments are not available to a send-only connection (3 MB): the issue's draft-and-upload-session path is used when `mail_modify` is on (record, `mail_send` row).
- **`Files.ReadWrite.AppFolder` is not used** (record: "expected, confirm").
- **Interface refinements, additive** (as the issue allows): three typed errors (`CONFLICT`, `NOTIFY_REQUIRED`, `ADMIN_CONSENT_REQUIRED`), an optional `idempotencyKey` on an outgoing message, and the provider's account id in the call context (it tells a personal account from a work one).
- **Interface refinements to the sign-in contract:** two optional hooks on `ConnectionProviderAdapter` (`classifyAuthorizationError`, `adminConsentUrl`), a new callback outcome `admin_consent_required`, and `GET /api/connections/providers` returning the capability matrix and the admin-consent link.

### Not confirmed yet (needs a real account; the issue's verification section)

None of this was observed on a real account, and the pages that would settle it were not reachable. Each is a behaviour the code assumes:

1. That Graph offers no way to create or change an event with attendees without emailing them (if it does, `NOTIFY_REQUIRED` can be relaxed).
2. The `$filter` and `$search` forms accepted together with the ordering used (`InefficientFilter` risk with a sender filter and `$orderby`).
3. The Excel workbook API on personal OneDrive, and that a leading apostrophe stores a formula-like string as text through the API.
4. `If-Match` on a file's content upload and on `createUploadSession` for a Word append.
5. `getSchedule` on a work account; the absence of free/busy on a personal account.
6. The scopes Microsoft returns after an incremental consent (only the added ones, or all consented), and the refresh-token inactivity of personal accounts.
7. The admin-consent error codes and the "needs admin approval" redirect, and the tenants whose policy blocks user consent.
8. That a personal account's mailbox accepts `Mail.ReadWrite` drafts and the calendar-view reads that replace free/busy for it, and that localized folder names do not matter (well-known folder aliases are used, never display names).
9. The form of Graph's next links (`/users('<id>')/`, `/drives/<id>/`, `mailFolders('<id>')` are read back as the user's own `/me/...` path; a form not listed there would make a page token fail with `INVALID_INPUT`).
