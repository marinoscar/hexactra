# Connections auth spike (issue #598, E39.1)

Throwaway scaffold for the experiments the decision record `console/docs/decisions/connections-auth.md` still needs. Not product code, not part of any build or CI. One file, no dependencies, Node 20 or later (`node --check spike.mjs` passes).

**It holds no secrets.** Client ids and secrets come from environment variables. Tokens and the log go to a state directory that the script refuses to use if it is inside a git work tree (default `~/.hexactra-spike-connections`, files mode 0600). Profile names are labels such as `google-workspace-internal`, never addresses.

## Setup

1. Follow the owner-setup checklist in the decision record for the provider (a Google Cloud project and OAuth client, or a Microsoft Entra app registration). Following it once from scratch is itself an acceptance criterion: note every step that was wrong or missing.
2. Register this redirect URI on the client or app registration: `http://localhost:53682/callback` (change the port with `SPIKE_REDIRECT_PORT`). If Google refuses `localhost` for the client type you created, use a "Web application" client and register it exactly.
3. Export the variables in the shell that runs the script (never in a file in the repository):

| Variable | Meaning |
|---|---|
| `SPIKE_GOOGLE_CLIENT_ID`, `SPIKE_GOOGLE_CLIENT_SECRET` | Google OAuth client. |
| `SPIKE_MS_CLIENT_ID`, `SPIKE_MS_CLIENT_SECRET` | Microsoft app. The secret is optional (public client). |
| `SPIKE_MS_AUTHORITY` | `common` (default), `organizations`, `consumers` or a tenant id. |
| `SPIKE_LOGIN_HINT` | Optional login hint for the consent page. |
| `SPIKE_STATE_DIR` | Where tokens and the log go. Must be outside any git work tree. |
| `SPIKE_REDIRECT_PORT` | Local redirect port (default 53682). |
| `SPIKE_XLSX_TEMPLATE` | Optional path to an empty `.xlsx` you created by hand, for the Excel workbook probe. |

## Commands

```bash
node spike.mjs scopes google --caps mail_read,mail_send      # offline: print the scopes a capability set asks for
node spike.mjs auth google --profile gmail-testing --caps mail_read,mail_send,calendar_write,docs_write
node spike.mjs probe --profile gmail-testing                 # one read and one harmless write per capability
node spike.mjs refresh-daily                                 # refresh every stored profile and append to the log
node spike.mjs status                                        # profiles, age of each authorization, last refresh
node spike.mjs revoke --profile gmail-testing
```

Capabilities: `mail_read`, `mail_send`, `calendar_read`, `calendar_write`, `docs_read`, `docs_write`. The scope sets are the candidate ones from the decision record, at the top of `spike.mjs`; edit them to test a variant (for example `gmail.modify`, or `drive` instead of `drive.file`).

**Probes** (the write probes clean up after themselves; they never send to anyone but the account itself and never invite attendees): mail read lists one message id and the labels or folders; mail send sends one message to the same account; calendar read lists calendars; calendar write creates an event without attendees and deletes it; documents read lists one file; documents write creates a spreadsheet, appends one row (raw values) and deletes it, creates a document and deletes it (Microsoft: uploads a text file and deletes it; with `SPIKE_XLSX_TEMPLATE`, also a workbook range write). Only status codes and short provider error codes are logged, never message, event or file content.

## The daily refresh (the 7-day test)

Authorize each Google profile once, then run `refresh-daily` once a day for at least 8 days, longer for the "In production" rows (see the decision record for why). Each run refreshes every profile, calls the identity endpoint with the new access token and appends a line with `ageDays` since authorization, whether the refresh token was rotated, and the error code if it failed. Example crontab entry:

```cron
17 6 * * * cd /path/to/checkout/scripts/spikes/connections && SPIKE_GOOGLE_CLIENT_ID=... SPIKE_GOOGLE_CLIENT_SECRET=... SPIKE_MS_CLIENT_ID=... node spike.mjs refresh-daily >> "$HOME/.hexactra-spike-connections/cron.out" 2>&1
```

(Put the variables in a file outside the repository that the cron line sources.) Keep running it after the first failure is seen: the day it first fails, and with which error code, is the result.

## What to record by hand

The script cannot see these. For every row of the matrix, write down: each consent screen and warning exactly as shown (for example the "unverified app" page and the wording of its continue link), every error text, what the account's security page lists afterwards, and any email the provider sent. Redact addresses before anything goes into the issue.

## Sharing results

`log.ndjson` already masks addresses and token-like strings, but read it before sharing and remove anything that identifies a real account. Do not commit it, the tokens file or a screenshot of a real mailbox. Summaries go in the matrix of the decision record using `Person A`, `Org Alpha` and `example.test` only.
