# Decision record: connecting Google and Microsoft accounts to a self-hosted console

Issue #598 (epic E39, #581). **Status: Provisional. Derived from documentation, not yet verified; experiments pending.** Nothing in this record was observed on a real account, and the official documentation pages it cites were **not re-read in the session that wrote it** (see "How this record was made"). Child issues #599 to #605 may build on the recommendations below, but every line marked `unknown-needs-experiment` must be settled by the experiments before the matching code ships, and the record must be revised when the experiments are done. Acceptance criteria of #598 that need real accounts are not met by this record.

Placeholders only: `Person A`, `Org Alpha`, `example.test`, `<console base>` (the console's public base URL).

## How this record was made, and what that limits

- Written on 2026-11-19 from the author's prior knowledge of the providers' documentation (knowledge to mid 2026) and the issue's hypotheses.
- **No official page was fetched.** The session's network allowlist blocked `developers.google.com`, `support.google.com`, `docs.cloud.google.com` and `learn.microsoft.com`. The only retrieval that worked was a general web search about the 7-day rule, which returned forum posts (secondary sources) that agree with the hypothesis.
- So the statuses below mean: **expected-confirmed** or **expected-refuted** = what the official documentation is believed to say, to be re-checked against the page and dated; **unknown-needs-experiment** = the documentation is believed not to settle it, or it concerns behaviour that only a real account shows. "Date read" is therefore `not read` everywhere; the verification pass (below) fills it in.
- Page paths are given as the author knows them and may have moved: search the provider's site for the title if one does not resolve.
- Cloud setup screens and menu names move often; the checklists give the intent and the current names as believed.

**Verification pass (small, do it first):** allow the four hosts above, open each page in the "Official page" column, and for each row record the date read and whether the status held. Any row that did not hold changes this record, and the child issues' comments drafted from it.

## Decision summary

| Question | Provisional decision |
|---|---|
| App model | **Bring your own app.** Each deployment registers its own Google Cloud project and Microsoft Entra app; the deployment's administrator pastes client id and secret into the console. No shared Hexactra app: it would make Hexactra the verified developer of a restricted-scope Gmail app (brand verification and a yearly third-party security assessment) and a publisher-verified Microsoft app, for every self-hoster's mail. |
| Google audience | **One External app, publishing status "In production", unverified**, serves every Google account (personal Gmail, the owner's Workspace, other organisations). "Testing" is not usable for a standing connection (refresh tokens end after 7 days). "Internal" is an optional refinement for a Workspace-only deployment, not the base case. |
| Microsoft audience | One multi-tenant app registration with the `/common` authority (work, school and personal accounts). Work and school accounts in tenants other than the app's home tenant need that tenant's administrator to consent (unverified publisher). |
| Personal Gmail | Native Gmail API on an unverified In-production app is **the candidate**, **unknown-needs-experiment**. If it does not keep refresh tokens alive for 8 days or more, or Google blocks the restricted scope, the fallback is: **documents and calendar natively, mail send through the console's existing email channel, mail read deferred**. IMAP/SMTP with app passwords is not recommended (see "Personal Gmail"). |
| Push or poll for new mail | **Poll first** (E39.8 as written); push is an optional follow-up. |
| Capabilities | The six switches are kept, but **a seventh, `mail_modify`, is needed** (archive, labels, mark read, drafts): at both providers it needs a higher permission than send. Details and the proposed change to #599 below. |

## Hypotheses of the issue, one by one

Date read is `not read` for every row (see above).

### Google

| # | Hypothesis | Status | What the documentation is believed to say | Official page |
|---|---|---|---|---|
| G1 | Full Gmail access is in the most restricted tier; a public app needs verification and a yearly third-party assessment | **expected-confirmed, with a correction**: only read/modify-type Gmail scopes are restricted (`gmail.readonly`, `gmail.modify`, `gmail.metadata`, `gmail.compose`, `gmail.insert`, `gmail.settings.*`, `https://mail.google.com/`). **`gmail.send` is sensitive, not restricted.** | Restricted-scope verification applies when the app is submitted for verification; the security assessment is required of apps that access restricted data and keep it on servers. An app that is never submitted is never assessed, but also never verified. | `https://developers.google.com/identity/protocols/oauth2/scopes`; `https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification` |
| G2 | External app in Testing: refresh tokens expire after 7 days (except basic sign-in scopes); 100 test users | **expected-confirmed** (also seen in forum posts of 2026-11-19, secondary only) | Stated in the "Refresh token expiration" list of the OAuth 2.0 guide; the cap is 100 test users while in Testing. Tokens issued while in Testing keep the limit; re-consent after publishing to get a normal one. | `https://developers.google.com/identity/protocols/oauth2` ("Refresh token expiration"); `https://support.google.com/cloud/answer/10311615` |
| G3 | Internal app in a Workspace organisation needs no verification and serves only that organisation | **expected-confirmed**. Additions: the project must belong to the Workspace organisation's resource hierarchy; an Internal app cannot serve personal Gmail or another organisation, so a deployment with both needs a second (External) project; the organisation's admin API controls (app access control) can still restrict it. | Consent-screen user types Internal and External. | `https://support.google.com/cloud/answer/10311615` |
| G4a | External, In production, **unverified**, restricted scopes, personal Gmail: refresh tokens stay alive, with only the warning and a user cap | **unknown-needs-experiment**. Believed: the 7-day rule is documented for Testing only; production unverified apps show the "Google hasn't verified this app" screen (continue through "Advanced") and are limited to 100 new users over the app's lifetime. Whether Google throttles, disables or revokes tokens of unverified apps using restricted scopes is not something the documentation promises either way. | | `https://support.google.com/cloud/answer/7454865` ("unverified apps"; confirm the id) |
| G4b | Whether limited-use and security-assessment requirements apply to a personal single-user deployment | **unknown-needs-experiment, and a judgement for the owner**. Believed: the API Services User Data Policy (including limited use of Gmail data: no transfer to third parties except to provide user-facing features, no use to train generalised AI/ML models) binds every app that uses the APIs, verified or not; the *assessment* is only triggered by submitting for verification. A model provider that trains on API inputs would break the policy: the setup guide must say to use one that does not. | | `https://developers.google.com/terms/api-services-user-data-policy` |
| G5a | `drive.file` is not sensitive | **expected-confirmed**, with a limit that changes the design: the app sees only files it created or the user picked (Google Picker). It cannot search the user's existing Drive. | | `https://developers.google.com/identity/protocols/oauth2/scopes` |
| G5b | `gmail.send` alone is sensitive, not restricted | **expected-confirmed** | | same |
| G5c | Sheets and Docs have their own scopes | **expected-confirmed**: `spreadsheets` and `documents` (sensitive), with `.readonly` variants (sensitive). They work on a file id without Drive scopes. | | same |
| G5d | Calendar scopes are sensitive | **expected-confirmed** (`calendar`, `calendar.events`, `calendar.readonly`, `calendar.events.readonly`; narrower ones exist such as `calendar.freebusy` and `calendar.calendarlist.readonly`: confirm the current list). | | same |

Further Google facts that bear on the design (all **expected-confirmed, not re-read**):

- **Redirect URIs** for a web client must be `https` (except `localhost`), must not be a raw IP address and must use a public top-level domain. A console reached at `http://192.168.x.x` or `console.home.local` cannot be a Google redirect target; it needs an HTTPS public name (a tunnel or reverse proxy is enough). Page: `https://developers.google.com/identity/protocols/oauth2/policies` ("redirect URI validation rules"). Microsoft allows `http` for `localhost` only too.
- **The device flow cannot be used** to avoid this: it supports a short list of scopes that excludes Gmail, Calendar, Docs and Sheets. Page: `https://developers.google.com/identity/protocols/oauth2/limited-input-device`.
- **Refresh token ends** also on: user revocation; 6 months unused; password change when the token holds Gmail scopes; more than 100 refresh tokens per account and client (the oldest silently stops working); a Workspace admin's controls. Advanced Protection accounts only allow verified apps (not supported). Same OAuth 2.0 guide page.
- **Granular consent:** the consent screen lets the user untick individual scopes; the app must read the granted scopes from the token response (#599 already does).
- A client secret for a Google web client does not expire.

### Microsoft

| # | Hypothesis | Status | What the documentation is believed to say | Official page |
|---|---|---|---|---|
| M1 | One registration signs in work, school and personal accounts (`/common`); `offline_access` gives a refresh token | **expected-confirmed**. Registration setting "Accounts in any organizational directory and personal Microsoft accounts". Registering needs an Entra tenant (a free one is created for a personal Microsoft account through a free Azure sign-up). | | `https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow`; `https://learn.microsoft.com/en-us/entra/identity-platform/supported-accounts-validation` |
| M2 | `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Files.ReadWrite` are user-consentable; tenant policy may require admin consent | **expected-confirmed for the permission itself** (these delegated permissions are not flagged "admin consent required" in the Graph permissions reference; the `.All` and SharePoint-wide ones are). **The tenant's user-consent policy decides in practice**; the Microsoft-managed default has moved more than once. **unknown-needs-experiment per tenant**: read the tenant's "User consent settings" and test. | | `https://learn.microsoft.com/en-us/graph/permissions-reference`; `https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent` |
| M3 | Publisher verification: removes the warning; is it required for consent to succeed? | **expected-refuted as "required at all", expected-confirmed as "required for end users of a work or school tenant to consent to a multi-tenant app from another tenant"**: since late 2020, end users cannot consent to multi-tenant apps without a verified publisher in such tenants; an administrator can still grant tenant-wide consent (the unverified label shows). Not applicable to personal accounts. Verification needs a Cloud Partner Program account and a verified domain: not reasonable for an individual self-hoster. | | `https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview` |
| M4 | Refresh-token lifetime and inactivity | **expected-confirmed for work and school accounts, unknown for personal**: refresh tokens last 90 days of inactivity and roll (every use returns a new refresh token that must be stored); 24 hours for single-page-app clients; revoked by password change, admin revocation or Conditional Access sign-in frequency/risk rules. Personal-account behaviour: **unknown-needs-experiment**. | | `https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens` |

Further Microsoft facts: the **client secret expires** (at most 24 months; every self-hoster will hit it once and every connection fails at that moment); there is no per-token revoke, only removal of the app at the account's "My apps" / consent page, or an admin deleting the grant (the adapter's best-effort revoke is a local delete plus instructions).

## Account types: verdicts

`supported`, `supported with caveat`, `not supported`, `unknown-needs-experiment`. All provisional.

| Account | App configuration | Verdict | Caveat and evidence |
|---|---|---|---|
| Google Workspace, owner's domain | Internal app in that organisation | **supported** (expected) | No verification, no warning, tokens not subject to the Testing rule (G3). Needs the project under the organisation, so a second project for personal Gmail. Admin API controls can still block: owner is the admin. |
| Google Workspace, owner's domain | the External In-production app (base case) | **supported with caveat** (expected) | The unverified warning at consent; the admin may need to mark the client "Trusted" in the Admin console (API controls). One app for everything, which is why this is the base case. |
| Google personal Gmail | External, Testing | **not supported as a standing connection** (expected-confirmed, G2) | Refresh tokens end at 7 days; only for trying things. The console must refuse to call an app "connected" if the owner says it is in Testing (see "What the product must do"). |
| Google personal Gmail | External, In production, unverified | **unknown-needs-experiment** | Expected to work with caveats: the warning, 100-new-user cap, limited-use policy (G4a, G4b). The decisive experiment of this spike. |
| Google Workspace of another organisation | External app | **unknown-needs-experiment** | Works only if that organisation's admin allows unverified third-party apps (restricted scopes especially); Internal is impossible. Treat as "ask that admin". |
| Google account in Advanced Protection | any unverified app | **not supported** (expected) | Only verified apps are allowed. |
| Microsoft work or school, the app's home tenant | the registered app | **supported with caveat** (expected) | Subject to the tenant's user-consent policy (M2); the tenant's admin (the owner) can grant consent for everyone. |
| Microsoft work or school, another tenant | multi-tenant app, unverified publisher | **supported with caveat** (expected) | An administrator of that tenant must consent (M3); the console shows the admin-consent link and a typed `ADMIN_CONSENT_REQUIRED`. |
| Microsoft personal | same app, `/common` | **supported** (expected), documents write **unknown-needs-experiment** | User consent; the Excel workbook API on personal OneDrive and `getSchedule` are doubtful (#602 already plans for it). Refresh-token inactivity: unknown (M4). |

## Permission sets per capability

"Narrowest that works" for the operations the child issues plan. `inc.` = needs incremental consent when switched on later (every capability does, because the first consent asks only for the capabilities switched on at that time; Google: `include_granted_scopes=true`, Microsoft: request the union and let the user consent again). Tier is Google's: **N** non-sensitive, **S** sensitive, **R** restricted (restricted = what a verification would assess; unverified apps skip it but show the same warning).

| Capability | Google scopes | Tier | Microsoft delegated | Notes |
|---|---|---|---|---|
| `mail_read` (search, read, attachments, list labels, history for the trigger) | `gmail.readonly` | **R** | `Mail.Read` | `gmail.metadata` is also restricted and cannot read bodies or use the search query: no use. `Mail.ReadBasic` has no body. |
| `mail_send` (send a message built by the console; reply) | `gmail.send` | **S** | `Mail.Send` | **Cannot create or send a draft** (Gmail `gmail.compose` is restricted; Graph drafts need `Mail.ReadWrite`). A Microsoft send with attachments larger than a few MB needs a draft and an upload session, so with `Mail.Send` alone the delivery falls back to a link (#603). |
| `mail_modify` (new: archive, labels or categories, mark read, drafts) | `gmail.modify` (needs `mail_read`) | **R** | `Mail.ReadWrite` | `gmail.modify` includes read; Graph `Mail.ReadWrite` includes read but **not** send. Required by #605's `afterStart` and #601's `createDraft`/`modify`. |
| `calendar_read` | `calendar.readonly` (or narrower `calendar.events.readonly` + `calendar.calendarlist.readonly` + `calendar.freebusy`: confirm they exist; one scope is simpler and all are S) | **S** | `Calendars.Read` | `getSchedule` for free/busy may need more on Microsoft. |
| `calendar_write` | `calendar.events` (add `calendar.readonly` for the calendar list) | **S** | `Calendars.ReadWrite` | Google: `sendUpdates=none` is available. Microsoft: no general "do not notify" is known: **unknown-needs-experiment** (#602 refuses attendee events then). |
| `docs_read` | `drive.file` + `documents.readonly` + `spreadsheets.readonly` | **N** + **S** | `Files.Read` | **Google reads only files the owner pasted by id or link, or picked, or the app created**: no Drive search (that needs `drive.readonly`, **R**). Microsoft `Files.Read` reads the whole OneDrive. |
| `docs_write` | `drive.file` + `documents` + `spreadsheets` | **N** + **S** | `Files.ReadWrite` (personal accounts only: `Files.ReadWrite.AppFolder`, narrower, expected, confirm) | Google: create a document or spreadsheet, append a row to a sheet by id. A **folder by id** the app did not create is not reachable with `drive.file` unless picked; the app should create and own one "Hexactra" folder. Microsoft `Files.ReadWrite` is the whole drive: say so in the consent text. |

Always requested: Google `openid email profile`; Microsoft `openid email profile offline_access User.Read`.

**Restricted tier, in one line:** only `mail_read` and `mail_modify` ask for a restricted Google scope. A deployment that never switches those on never meets the restricted tier, and everything else is sensitive at worst.

## What changes in the epic's capability model

1. **Add `mail_modify`** (or drop modify and drafts from v1). Without it, either "read is not write" is broken (send would need `gmail.modify`) or the restricted tier is forced onto every sender.
2. **`createDraft` and `send({draftId})`** of #601's `MailCapability` need `mail_modify`; `send(OutgoingMail)` works under `mail_send` alone.
3. **Google documents are by id, not by search** unless the owner picks files. `searchFiles` is limited to files the app created or the user picked; the capability matrix must say so.
4. **One Google app, one Microsoft app per deployment**, with an optional second Google app only if a future need appears (Internal plus External). The singular system credentials of #599 are enough for now.

## Personal Gmail: verdict and fallback

**Verdict: unknown-needs-experiment.** The candidate is native Gmail on an unverified In-production External app. Evidence for: the 7-day rule is a Testing rule; the unverified screen is a click-through; the only documented cap is 100 new users. Evidence against: Google reserves the right to enforce its policies on restricted scopes, and may change what unverified apps can do; no document promises that unverified tokens live long. The experiment decides it: authorize the production-unverified row with `mail_read` and `mail_send`, refresh daily for as long as the spike runs, and see.

If it fails (tokens die early, or Google refuses to let the user continue), the options and their cost:

| Option | Cost | Verdict |
|---|---|---|
| **Documents and calendar natively, mail send through the console's own email channel, mail read deferred** | No Gmail read: no inbox search, no email trigger (#605) and no briefing from mail for Gmail accounts. Everything on the sensitive tier still works (`gmail.send` could still try; if it also fails, console email only). Deliveries (#603) still send from the console's sender. | **Recommended fallback.** Smallest change, no new adapter, no weaker security. |
| IMAP and SMTP with an app password | A third adapter; an app password is a full-mailbox credential that Google offers only with 2-Step Verification, can be disabled by a Workspace admin and does not work on Advanced Protection accounts; no history/push; unrelated to the capability model. | Not recommended. |
| Submit the app for verification and the yearly assessment | Out of scope and not reasonable for a personal deployment. | No. |

For Microsoft personal accounts mail works natively if M4 holds; no fallback needed.

## Token lifetimes, and what the product must do

| Token | Lifetime (expected) | Product duty |
|---|---|---|
| Google access token | about 1 hour | Refresh within 2 minutes of expiry (#599). |
| Google refresh token, app in Testing | 7 days (non-basic scopes) | The admin page asks the owner to confirm the publishing status; a connection whose first refresh fails with `invalid_grant` before day 8 shows "the app may still be in Testing: publish it, then reconnect". |
| Google refresh token, production | until revoked, 6 months unused, password change with Gmail scopes, 100-token cap per client | Daily health refresh (#599) keeps it from the 6-month rule. After a password change, `needs_reconnect` with a reconnect prompt. Do not connect the same account many times: each connect adds a token (cap 100). |
| Microsoft access token | 60 to 90 minutes | Same refresh rule. |
| Microsoft refresh token | 90 days inactive, rolling; **rotates on every use** | Store the new token before dropping the old (#599 already); daily health refresh keeps it alive; `invalid_grant` or Conditional Access errors become `needs_reconnect` with the Microsoft error code mapped to a plain reason. |
| Microsoft client secret | at most 24 months | The administrator enters its expiry date; the page warns 30 days ahead; an expired secret fails every connection at once and must read "the app secret expired", not "reconnect". |

A single health job with one refresh per connection per day is enough. A reconnect prompt is shown at the top of the connections page (#599) and the owner is notified once.

## Quotas and limits that matter

All **expected, not re-read**; check the pages before sizing anything.

| Service | Limit | Effect on the plan |
|---|---|---|
| Gmail API | per-project 1,200,000 quota units per minute and 250 units per user per second; `messages.list` and `get` 5 units, `history.list` 2, `send` 100, `watch` 100 | Polling every 5 minutes is trivial. Page: `https://developers.google.com/gmail/api/reference/quota`. |
| Gmail sending | 500 recipients per day for consumer accounts, 2,000 for Workspace | The per-user delivery cap of #603 (100 per day) is below it. |
| Gmail message size | 25 MB per message including encoding | The "attachment too large → link" rule needs the real threshold: about 18 MB of raw bytes. |
| Calendar, Sheets, Docs, Drive | per-minute project and per-user quotas (Sheets of the order of 60 requests per user per minute per project) | One row per delivery is fine; the adapter's 429 backoff is the guard. Page: `https://developers.google.com/sheets/api/limits`. |
| Graph | about 10,000 requests per 10 minutes per app per mailbox, 4 concurrent requests per mailbox; 429 with `Retry-After` | Per-connection concurrency of 2 to 4 is right. Page: `https://learn.microsoft.com/en-us/graph/throttling-limits`. |
| Graph `sendMail` | small request body; attachments above a few MB need a draft and an upload session | See `mail_send` row above. |

## Push or poll for new mail (E39.8)

| | Gmail | Microsoft Graph |
|---|---|---|
| Mechanism | `users.watch` publishes to a Cloud Pub/Sub topic; the notification carries only the account and a `historyId`, and the app then calls `history.list` | Change-notification subscription on `/me/mailFolders('inbox')/messages` |
| What it needs | A topic in the owner's project, publish rights for Gmail's push service account, and either a **public HTTPS endpoint with a valid certificate** (push subscription) or a **pull subscription** with a service-account credential (works behind NAT but needs another secret and the Pub/Sub API) | A **public HTTPS notification URL** that answers a validation request within seconds |
| Renewal | The watch expires in 7 days; call it again at least daily | Subscription lifetime is short (days; depends on resource and account type); renew, and handle lifecycle notifications |
| Self-hosted cost | One more Cloud API, one more credential, a public endpoint or a pull loop; the owner's console may not be reachable from the internet | A public endpoint |
| Polling alternative | `history.list` from the stored `historyId` (2 units), or `messages.list` with a date filter | Delta query `/me/mailFolders/inbox/messages/delta` with a stored delta link |

**Recommendation: poll in E39.8, as the issue already assumes.** Push needs a public endpoint (and for Gmail a second project service and credential) that a console on a residential network usually lacks, saves nothing in quota, and cuts at best a few minutes of latency. Keep the cursor an **opaque provider string** (Gmail `historyId`, Graph delta link) so push can be added later without a schema change. Gmail `history.list` can answer 404 for an old `historyId` (history is kept for about a week): the poller must then fall back to a bounded `messages.list` since the trigger's last check and never replay old mail. Sender authentication for #605: believed available from the message headers at both providers (Gmail: `Authentication-Results` via metadata headers; Graph: `internetMessageHeaders`); **unknown-needs-experiment**.

## Owner-setup checklists (what the setup guide and the admin page must say)

Menu names are as believed on 2026-11-19; follow the intent if a label moved. `<console base>` must be an HTTPS URL with a public domain name for Google (a tunnel or reverse proxy is fine); Microsoft also accepts `http://localhost`.

### Google

1. Open the Google Cloud console and create a project (project in the Workspace organisation only if you want an Internal app; otherwise any).
2. **APIs and services, Library:** enable Gmail API, Google Calendar API, Google Docs API, Google Sheets API and Google Drive API (Cloud Pub/Sub only if push is added later).
3. **Google Auth Platform** (formerly "OAuth consent screen"):
   - Branding: app name, user support email (an address you own), developer contact email. Logo, home page and authorised domains are optional for an unverified app.
   - Audience: **External** (or **Internal** if the project is in your Workspace organisation and only its accounts will connect). Set the publishing status to **In production** ("Publish app"). Leaving it in Testing makes every connection die after 7 days. Google may say verification is needed: for a personal deployment you do not submit it; you accept the unverified-app warning at connect time.
   - Data access: add the scopes of the capabilities you will use (the table above). Adding the restricted Gmail scopes (`gmail.readonly`, `gmail.modify`) is what triggers the verification notice.
4. **Clients, Create client:** type **Web application**. Authorised redirect URI: `<console base>/api/connections/callback/google`. Copy the client id and secret into the console's administrator page for Connections (never into a file in the repository).
5. Workspace only: in the Admin console, Security, Access and data control, API controls, App access control, **Configure new app** by OAuth client id and mark it **Trusted** (needed if the organisation blocks unconfigured or unverified apps).
6. Connect an account from the console. Expect the "Google hasn't verified this app" page: continue through Advanced, then tick every permission requested (an unticked permission leaves that capability off).
7. Use an AI model provider whose terms do not train on API inputs (limited-use policy for Gmail data).
8. The account holder can see and remove the app at their Google Account, Security, "Third-party apps with account access".

### Microsoft

1. In Microsoft Entra (Entra admin center or Azure portal), **App registrations, New registration**. Name; **Supported account types:** "Accounts in any organizational directory and personal Microsoft accounts"; Redirect URI platform **Web**: `<console base>/api/connections/callback/microsoft`. (A personal Microsoft account needs an Entra tenant to register in: a free Azure sign-up creates one.)
2. **API permissions, Add, Microsoft Graph, Delegated:** `offline_access`, `User.Read`, plus those of the capabilities you will use (`Mail.Read`, `Mail.Send`, `Mail.ReadWrite`, `Calendars.Read`, `Calendars.ReadWrite`, `Files.Read`, `Files.ReadWrite`). Do not add application permissions.
3. **Certificates and secrets, New client secret:** copy the **value** at once; set a reminder for the expiry (at most 24 months) and enter the expiry date in the console.
4. Copy the Application (client) ID and the secret into the console's administrator page. The authority is `/common`.
5. Work or school accounts of another organisation: send that organisation's administrator the console's admin-consent link; until they consent the user sees "needs admin approval". Publisher verification is optional and out of reach for an individual.
6. A person removes the app at "My apps" (`myapps.microsoft.com`, or the personal account's privacy and apps page); the console's Disconnect only deletes the stored tokens.

## Experiment matrix (all pending)

Nothing below has been run. Columns follow the issue: capabilities Mail read, Mail send, Calendar, Documents, plus the daily-refresh result and the consent texts recorded by hand. Google rows need at least 8 days of daily refresh (the 7-day test); the In-production rows should be kept running much longer, because "does an unverified production app's token survive" is only answered by time.

| Provider | Account | App configuration | Mail read | Mail send | Calendar | Documents | Daily refresh | Consent text and warnings |
|---|---|---|---|---|---|---|---|---|
| Google | Workspace account (Person A, Org Alpha) | Internal app in that organisation | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment |
| Google | Personal Gmail (Person A) | External app, Testing | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment |
| Google | Personal Gmail (Person A) | External app, In production, unverified | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment |
| Google | Workspace account of another organisation | External app, Testing | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment |
| Google | Workspace account of another organisation | External app, In production, unverified | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment |
| Microsoft | Work or school account | Multi-tenant app, user consent | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment |
| Microsoft | Personal account | Same app | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment | pending experiment |

Extra cells worth a run while the accounts are connected (each also `pending experiment`): Microsoft work account in a tenant other than the app's home tenant (admin consent text); `mail_modify` and drafts at both providers; the Gmail 404-on-old-`historyId` fallback; whether `Authentication-Results` is readable at both providers; Graph attendee events without notification; Excel workbook `appendRows` on personal OneDrive; Microsoft personal refresh-token inactivity; a Google account's Advanced Protection response; the Workspace admin's block of an unverified client.

How to run them: `scripts/spikes/connections/README.md` (a Node script, no dependencies, tokens kept outside the repository, a `refresh-daily` command for the 8-day test).

## What remains before this record can leave "Provisional"

1. The documentation verification pass (statuses and dates).
2. The experiment matrix, run from scratch on real accounts following the checklists above once (which also tests the checklists).
3. A revision of this record, then of the comments on #599, #601, #602, #603 and #605.
4. The owner's decision on the limited-use question (G4b) and on whether the recommended fallback should be taken if G4a fails.
