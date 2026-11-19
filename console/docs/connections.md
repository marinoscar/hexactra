# Connections: your Google and Microsoft accounts

Epic E39 (#581) lets the owner connect their accounts at Google and Microsoft **once**, with a name they choose and a switch for each of Mail, Calendar and Documents, so that tasks, chats and deliveries can use them later. This chapter is the foundation (issue E39.2, #599): the model, the capabilities, the defaults, how tokens are kept, what "needs reconnect" means, and the administrator's setup. What uses a connection is built on top of it by later issues: the Google and Microsoft providers (E39.3, E39.4), deliveries after a run (E39.6), agent tools (E39.7), triggers (E39.8) and generic MCP connections (E39.9).

**Status, honestly.** The model, the flows, the token service, the pages and the CLI are implemented and tested against a **fake provider** (`apps/api/test/support/fake-connection-provider.ts`). **No real Google or Microsoft account has been connected yet:** the real adapters are E39.3 and E39.4, and until one is installed its provider is listed as "not available on this deployment yet". The app model below (bring your own app), the account types and the setup checklists follow the decision record [decisions/connections-auth.md](decisions/connections-auth.md) (E39.1, #598), which is itself **provisional**: derived from documentation, not yet verified on a real account. That record also proposes a seventh capability, `mail_modify` (archive, labels, drafts), which this issue does **not** add: the six switches above are the issue's, and a later decision adds it if the owner agrees.

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

Hexactra does not ship a Google project or a Microsoft app: **the deployment's administrator registers one of each** and Hexactra's users connect their accounts through it. (This is the decision record's recommendation; per-user apps are not part of this issue.)

1. Open **Administration → Browser agent → Connections**. Each provider shows the **redirect URI** to copy and a **setup checklist**.
2. **Google.** In the Google Cloud console create or choose a project, enable the Gmail, Calendar, Docs, Sheets and Drive APIs, configure the Google Auth Platform (the OAuth consent screen) as **External** and **publish it** ("In production": a project left in testing mode ends every sign-in after about a week; an unverified app is fine for your own use, users accept a warning), create an OAuth client of type *Web application* with the redirect URI shown (an https address with a public domain name), and paste the client id and secret. For Google Workspace, mark the client trusted in the Admin console if your organization blocks unverified apps.
3. **Microsoft.** In the Microsoft Entra admin center register an application ("any organizational directory and personal Microsoft accounts"), add the redirect URI as a *Web* redirect, add the delegated Graph permissions you will use plus `offline_access` and `User.Read`, create a client secret (note its expiry date: sign-ins stop refreshing when it expires), paste the application (client) id and secret, and set the **tenant** (`common` allows work, school and personal accounts; `organizations`, `consumers` or a tenant id narrow it). A work or school account of another organization needs that organization's administrator to approve the app once.
4. Switch the provider on. It can be switched on only when the client id and secret are set.

The client id, tenant and switch are the `connections` system settings; the secret is a write-only system credential (`connection_app_google`, `connection_app_microsoft`), never returned. Switching a provider off stops new connections; existing connections keep refreshing. Removing the app deletes the id and secret and switches it off: connected accounts stay but cannot refresh until an app is set again.

Until the adapter for a provider is installed (E39.3, E39.4) the provider is listed as not available even when switched on. The Connect dialog explains which kinds of account work (personal accounts, work or school accounts) before the owner starts; that text is provisional until the record's experiments are done.

## For the next issues

- **Adapters** implement `ConnectionProviderAdapter` (`src/connections/provider.ts`: `scopesFor`, `authorizeUrl`, `exchangeCode`, `refresh`, `revoke`, `capabilitiesGranted`, `probe`) over `OAuthClientService` (`src/oauth-client/`), and register with `ConnectionProviderRegistry` from their own module's `onModuleInit`. A refused grant must surface as an `OAuthClientError` of kind `invalid_grant`; `TokenSet.scopes` must list what the provider granted.
- **Callers** use `ConnectionResolverService.resolveConnection` to pick the account, then `ConnectionTokensService.getAccessToken` for a token, and `ConnectionsService.markUsed` to record the use. They catch `ConnectionError` and read `.code`.
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
