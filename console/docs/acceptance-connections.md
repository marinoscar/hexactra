# Acceptance run for connections and deliveries (E39)

Epic E39 ([#581](https://github.com/marinoscar/hexactra/issues/581)) lets the agent use the owner's Google and Microsoft accounts and MCP servers, lets a mail start a task, and lets a finished run send its result out. The owner's example: **every month, pay the car loan from a scheduled task, keep a screenshot as proof, email the result, and add a row to a spreadsheet.** This page is the checklist for the close-out issue ([#608](https://github.com/marinoscar/hexactra/issues/608)): the eleven steps that prove it on the deployed stack, then the list of everything that was built and tested against fakes and that only the owner can confirm. What the features are: [connections.md](connections.md) and [deliveries.md](deliveries.md). What stops misuse and what does not: [security-connections.md](security-connections.md).

**Status when this was written: not performed.** The automated evidence is green on `main` and none of it used a real account: every provider test ran against an in-process fake of Google's endpoints, a fake of Microsoft Graph, a fake MCP server or an in-memory capability double, and the decision record the providers were built on ([decisions/connections-auth.md](decisions/connections-auth.md)) is still **provisional**. Nothing in this file is a measured result: the results table is empty on purpose. Fill it in; a `Pass` is a statement that you saw it, a `Deferred` says why and links the follow-up issue, and a `Fail` is a defect that gets its own issue and a repeat of the step.

## Before you start

You need the deployed stack ([vps-stack.md](runbooks/vps-stack.md)) at the commit under test, with:

- **The node updated.** After deploying the console, run `hexactra agent update` on each browser node, then `hexactra agent doctor`. The Chrome extension is force-installed by policy from `https://github.com/marinoscar/hexactra/releases/download/agent-latest/updates.xml` and carries the E37.10 origin guard on `type` and `type_keys` and the E35 masked screenshots; an **old extension silently ignores the origin guard** and takes unmasked-looking pictures the console then has to rely on, so the payment step proves nothing on a stale node. The rolling `agent-latest` release is rebuilt by `.github/workflows/agent-release.yml` on every merge to `main` that touches `crates/` or `apps/chrome-extension/`.
- **A Google app and a Microsoft app** registered by you as the administrator ([connections.md, Administrator setup](connections.md#administrator-setup-bring-your-own-app)): the Google project with the consent screen **In production** (a project left in Testing ends every sign-in in about a week and would fail step 4 for the wrong reason), the Microsoft app with the delegated permissions and a client secret whose **expiry date you wrote down**.
- **Real accounts of the supported kinds:** two accounts of one provider (for example two Google accounts) and one of the other (a Microsoft account), plus, if you want it, a work or school account. Use a mailbox, a calendar and a drive you do not mind a test touching.
- **A harmless payment of your choice** or, better, a "pay" step on a page you control that records the click. A low-value real payment is the owner's call; nothing here requires one.
- **The deployed stack's email set up** (Administration → Email) if you want to test the console's own sender as well as a connection.
- **The telemetry slice on** with a collector you can search by attribute, for step 10.
- Placeholders in this page (`Person A`, `example.test`) stand for your own addresses; **never copy a real one into the issue.**

## What to record, and what never goes in the issue

Record, for each step: pass, fail or deferred; the **run ids** (from the run page URL, `/runs/<id>`); the console version; the account **kinds** (personal Google, Workspace Google, Microsoft work, Microsoft personal), not the accounts; the closed codes you saw (`errorCode`, `statusReason`); the time a thing took.

**Do not put in the issue, a comment or a PR:** any mailbox content (a subject, a body, a snippet, an attachment name), any address of another person or of your own accounts, calendar titles, spreadsheet cell values or file names that identify you, tokens, client ids or secrets, a screenshot that shows any of these, or the amount and merchant of a real payment. Say "the subject" or "the sheet", not what it says.

## The eleven steps

Each step is a checklist. Tick what you saw.

### 1. Connect

- [ ] Connect **two accounts of one provider and one of the other**, each with a label you choose (`Work`, `Personal`, `Outlook`). Settings → Connections.
- [ ] On the consent screen tick every permission asked; the page shows the capabilities that were granted. Switch on **Mail: read and write**, **Calendar: read** and **Documents: read and write** on at least one account of each provider.
- [ ] Press **Test** on each account: one cheap read per switched-on capability passes, and the page shows no token and no scope string.
- [ ] Note which **kinds** of account worked and which did not (a personal Gmail with the restricted permissions, a Workspace account, a personal Microsoft account, a work account that needed administrator approval). This settles the decision record's experiment matrix.
- [ ] A **second account of the same provider** is a second connection (no duplicate); connecting the first again updates it.
- [ ] **New chats** (Settings → Connections, and in any chat's settings): a new chat already lists your active Google and Microsoft accounts at **Read and change** (#680); set **Off**, start another chat: it lists none; set **Read only**: it lists them read only. An MCP server is never listed. An existing chat keeps what it had.

### 2. The example task

- [ ] Create the task **"Pay the car loan"** in the web app (README, [Accounts and deliveries in the form](../README.md#accounts-and-deliveries-in-the-form)): a goal with **one parameter**, `{{Amount}}` (type money), and saved values or saved logins for the rest.
- [ ] **Accounts the agent may use:** the Google or Microsoft account, **Read and change** (or Read only, if the task will not send).
- [ ] **Outputs** (Where the result goes, or the task's Outputs section): amount paid (money), confirmation number (text), payment date (date), remaining balance (money).
- [ ] **Deliveries:** an **email** to yourself with the PDF report; a **spreadsheet row** (a new spreadsheet created on the first send, or one you pasted the link to), mapped from the outputs with **Fill from outputs**; a **folder** delivery with the PDF and the JSON trace.
- [ ] **Send a test** for each delivery: an email marked `[TEST]` with no attachment, a row whose Run ID reads `TEST-...`, a `TEST.txt` in the folder. A wrong address is caught here.
- [ ] A monthly **schedule** (for step 4 use a schedule a few minutes ahead, with a preset amount).

### 3. Run it by hand

- [ ] Run the task. You are asked **only for the amount** and, at the payment, for approval (or not, if you remembered that approval, #555).
- [ ] The **email arrives** with the outputs and the PDF; the PDF shows the **masked** confirmation screenshot (#541, #543).
- [ ] The spreadsheet has **one new row**, with the run id in the last column and the outputs in their cells.
- [ ] The folder has the PDF and the JSON.
- [ ] The run page's **Deliveries** block says `sent` for each, with a link to the spreadsheet and the folder.
- [ ] Record whether the run needed a browser and node at all for the delivery part (it should not).

### 4. Run it from the schedule

- [ ] With a preset amount and, if E37 shipped, a saved login, let the **schedule** fire. Record whether the run **completed with nobody present**, and **if it asked, why** (a payment confirmation, a sign-in, a code). An unattended payment asks unless `unattendedPayments` allows it and a remembered approval covers it; either answer is a fact to record, not a defect.
- [ ] The four deliveries ran for this run too, once each.

### 5. Idempotency

The owner cannot make a provider lose an answer, so this step checks what can be seen. The lost-answer cases are covered by automated tests only ([deliveries.md, How it works](deliveries.md#how-it-works)).

- [ ] After steps 3 and 4, the spreadsheet's Run ID column holds **each run id exactly once**, the mailbox has **one message per recipient per run**, the folder has **one set of files per run**.
- [ ] Press **Retry** on a delivery that is already `sent`: the console **refuses** (`409 DELIVERY_NOT_RETRYABLE`), and nothing is sent.
- [ ] Press Retry on the delivery that failed in step 6 (below): after it the mailbox, the sheet and the folder still hold **one** each.

### 6. A failing delivery

- [ ] **Pause** the connection a delivery uses (Settings → Connections → Pause, or `hexactra connections pause`). Run the task again.
- [ ] The **run still succeeds**. The delivery is `failed` with a plain reason ("the connection is paused"), the owner gets one notification ("A delivery after a run failed"), and the run's status did not change.
- [ ] **Resume** the connection and press **Retry**: the delivery is sent, once.

### 7. Agent tools

- [ ] **A chat question answered from the calendar** with no run: Chat settings → Accounts this chat may use (read), ask "what is on my calendar today"; the thread shows an answer and **no Browser card**, and Runs shows no new run.
- [ ] **A task that reads an email and fills a form from it**: it lists a mail account with **Read only**, reads the message with the mail tools, fills a form field from its text. The step list shows recipients and subject of each call and never a body. **Expect the attachment variant to be deferred:** `mail_attachment_to_browser` needs a fabric `upload_file` action that does not exist; the tool tells the model the host cannot take a file. Record the result as deferred with that reason.
- [ ] **A send to a new address asks.** The card shows the account, the recipients, the subject, the start of the body and the attachments, and is answered signed in.
- [ ] **A remembered send to an approved address does not ask**; a send to another address, from another account or with another tool still does. (Tick **Don't ask again** with *these people*, send again, then send to someone else.)
- [ ] Optional: do the same with an **MCP server** (see "Beyond the eleven", below).

### 8. Trigger

- [ ] On the task, **When an email arrives**: your second account's address as the sender and a subject keyword. **Test** the trigger: the last five matching messages are listed with the subject cut to 60 characters and the answer "would start a run".
- [ ] **Send a matching mail** from that second account: the task starts **once**, within the poll interval (record the lag), the run says "Started by an email", and the history says `started`.
- [ ] A **non-matching mail** (another subject) starts nothing.
- [ ] A **forged-sender test mail**: a message with the listed address in its `From` header, sent from a server that does not sign or align for it (use a domain you own, never someone else's). It starts nothing and the history says `skipped_unverified` (`SENDER_NOT_VERIFIED`, or `SENDER_NOT_CHECKED` when the provider could not check it). The trigger's "Also accept mail the provider could not verify" is **off** for this check.
- [ ] Record, for each provider, whether a normal mail from a domain with SPF and DKIM read `pass`, and whether a mailing-list or forwarded copy read `fail` or `unknown`.

### 9. Injection

- [ ] A **test page** you control whose text says to email some data to an address of your choice (use an address you own that is not on any approved list), and a **test email** that says the same. Run a task with a mail account (Read and change) that reads the email and visits the page.
- [ ] **Nothing is sent without you approving that recipient**: the agent asks on a card, or sends nothing. Decline it, and check that the run does not ask again for the same call.
- [ ] The test email's instructions do not change the run's allowed sites, approvals or connections.

### 10. Trace and export

- [ ] Put a **marker string** in the body (not the subject) of a message the agent sends or reads in step 7 or 9.
- [ ] The run's **JSON export** (#542; the run page, Export) shows the connection steps with **masked recipients** and **no body**; searching it for the marker finds nothing.
- [ ] The run's **OpenTelemetry trace** (#585; Administration → Telemetry explorer, by `hexactra.run.id`) has **no content in any attribute**: searching spans for the marker, a subject word and an address finds nothing. The connection spans carry the provider, the capability and `read` or `write`.

### 11. Disconnect

- [ ] **Disconnect one account.** The dialog lists what uses it (tasks, deliveries, triggers). Afterwards its tasks **show what is missing** ("connection removed"), its deliveries are switched off with that reason, and its mail triggers are off.
- [ ] **Nothing else breaks:** the other accounts, tasks, deliveries and triggers still work; run step 3 for a task that uses another account.
- [ ] Record whether the provider's own page still lists the app (Google revokes the grant best effort; **Microsoft cannot be asked**: remove the app at the account's page or My Apps).

## Beyond the eleven

These are not among the issue's eleven steps and have no result below until someone does them; record each as pass, fail or deferred.

- [ ] **An MCP server, for real.** In Administration → Connections switch MCP on; add a public test MCP server (or one you run) with the sign-in it needs; switch on one read tool and one write tool; run a task that lists the connection; check the run calls both, the approval card for the write and the step list; then change a tool's description on the server and press **Refresh tools**: it comes back **off** and flagged.
- [ ] **The file picker.** Not expected to open until the platform seam lands (see below); check the fallbacks work: search, a pasted link, a spreadsheet created on the first send.
- [ ] **Android.** Not run on a device: the checklist is [runbooks/android-app.md, section 7](runbooks/android-app.md#7-connections-on-a-phone-e3910).
- [ ] **Multi-organization.** `TENANCY_MODE=multi` has not been tried for deliveries.

## Results

Fill in, one row per step. Do not paste content (see above).

| # | Step | Result (pass / fail / deferred) | Run ids | What you saw (kinds of account, closed codes, times) | Issue for a defect or a deferral |
|---|---|---|---|---|---|
| 1 | Connect two accounts of one provider and one of the other; Test passes | | | | |
| 2 | The example task: one parameter, four outputs, three deliveries, a monthly schedule | | | | |
| 3 | Run it by hand: email with PDF, one row, files in the folder | | | | |
| 4 | Run it from the schedule: completed with nobody present, or why it asked | | | | |
| 5 | Idempotency: no second email, no second row | | | | |
| 6 | A failing delivery: run succeeds, `failed` with a reason, Retry sends once | | | | |
| 7 | Agent tools: calendar in a chat with no run; a task reads mail; a new address asks; a remembered one does not | | | | |
| 8 | Trigger: a matching mail starts it once; a non-matching and a forged one do not | | | | |
| 9 | Injection: nothing is sent without approving the recipient | | | | |
| 10 | Trace and export: masked recipients, no body, no content in a span | | | | |
| 11 | Disconnect one account: what is missing is shown, nothing else breaks | | | | |

## What was not verified, and is yours to confirm

Collected from the pull requests of the epic. Each is a statement the code or the documents make that no test can settle; the step that exercises it is in brackets.

1. **Real Google and Microsoft accounts.** No real account has been connected, so every provider behaviour here is from documentation and from fakes built to match it ([step 1](#1-connect)).
2. **The provisional decision record (#598).** Its experiments are pending: whether an unverified In-production Google app keeps its refresh token for more than a week with the restricted Gmail permissions (G4a), whether personal Gmail works at all with the restricted scope, the Microsoft admin-consent behaviour, and the rest of its matrix ([decisions/connections-auth.md, Experiment matrix](decisions/connections-auth.md#experiment-matrix-all-pending)). It may change the choices the docs make. Its documentation verification pass (open each cited page, record the date and whether the status held) has not been done either.
3. **The Google column of the capability matrix.** It follows the record's narrow `drive.file` permission; that a picked or created file shows in a search, that Google accepts base64 content in the Drive multipart upload, and that `RAW` values stay text are not observed ([connections.md, Google](connections.md#google-what-it-gives-and-how-the-adapter-works)).
4. **The Microsoft assumptions: the nine "Not confirmed yet" items** in [connections.md, Microsoft: not confirmed yet](connections.md#microsoft-not-confirmed-yet-needs-a-real-account): that Graph offers no way to change an event with attendees without emailing them (so `NOTIFY_REQUIRED` stays), the `$filter` and `$search` forms with the ordering used, the Excel workbook API on personal OneDrive and the apostrophe that keeps a formula-like string as text, `If-Match` on a file upload and an upload session, `getSchedule`, the scopes returned after an incremental consent and refresh-token inactivity, the admin-consent error codes, `Mail.ReadWrite` drafts and the calendar-view reads for a personal account, and the form of Graph's next links.
5. **Sender verification.** The Microsoft neutral label ids `INBOX` and `ARCHIVE` (the trigger's default inbox search depends on the mapping), and the **Exchange Online `Authentication-Results` stand-in**: Exchange Online often writes its own header with no server name, which the adapter reads as Microsoft's because Microsoft prepends its own and only the topmost counts. That is an argument, not an observation ([step 8](#8-trigger)). At Google, that a normal message reads `pass` and a forwarded one `fail` or `unknown`.
6. **`mail_attachment_to_browser`** needs a fabric `upload_file` action that does not exist. Until it does, the agent cannot hand an attachment to a page's file input ([step 7](#7-agent-tools)).
7. **The replay suite has no email or MCP injection scenario.** The suite has a hostile page (`injection-page`); the hostile email, the hostile MCP result and the hostile MCP description are tested with a scripted model against the connection tools, not as whole-loop scenarios. Adding scenarios is a follow-up ([step 9](#9-injection) is the real-world check).
8. **A real MCP server** has not been tried ([Beyond the eleven](#beyond-the-eleven)).
9. **Idle MCP OAuth tokens are not refreshed by the health job.** The daily job keeps only Google and Microsoft grants alive; an MCP OAuth token that goes idle needs a new sign-in.
10. **The Google file picker cannot load in production yet.** The platform's content security policy has no `script-src` include, and `infra/nginx/csp*.conf` is generated; only `frame-src https://docs.google.com` and `style-src https://www.gstatic.com` were added under `console/infra/nginx/app.d/csp/`. The upstream EnterpriseAppBase seam request (draft text in [connections.md, Choosing files](connections.md#choosing-files-the-picker-e3910)) has **not been filed**. The fallbacks are search, a pasted link and "create a new spreadsheet". **Not tested in a real browser with a real account.**
11. **The picker route gives the browser a token.** It hands the signed-in user's browser the connection's short-lived Google access token: the one exception to "tokens stay on the server". Google only, Documents on, `Cache-Control: no-store`, audited as `connection.picker_opened` without the token, session-authenticated so a hosted OAuth app cannot reach it ([security-connections.md, threat 7](security-connections.md#7-a-stolen-refresh-token)).
12. **Home** shows a notice for an account that must be connected again; it does **not** show repeated delivery failures. Those are in the run's Deliveries block, one notification per task per day, and the alert rule **Delivery keeps failing**.
13. **Android** was not run on a device ([runbooks/android-app.md, section 7](runbooks/android-app.md#7-connections-on-a-phone-e3910)).
14. **The node update.** After deploying the console, `hexactra agent update` on each node, then `hexactra agent doctor`; an old extension ignores the origin guard.
15. **`TENANCY_MODE=multi` is untried for deliveries.**

## Follow-ups to file

An issue for each defect not fixed and each deferred part, linked from the epic. Candidates: the upstream seam request for a `script-src` include; a fabric `upload_file` action; replay scenarios for a hostile email and a hostile MCP result; push notifications for new mail and provider change notifications instead of polling; a Home notice for repeated delivery failures; refreshing idle MCP OAuth tokens; contacts and tasks capabilities; deleting and moving files; more delivery kinds; a model-assisted extraction of values from a triggering email; an iOS app if wanted later.
