# Decision record: per-profile Google sign-in status, detected on the node

Issue #927 (epic E48, #926). Decided 2026-11-25.

## Context

An unattended node is useful only while its Chrome profiles are signed in to the owner's Google account. Nothing detected a signed-out profile: `HostView` carried profile names and which were running, and the owner found out when a run hit a sign-in wall. E48 adds a per-profile sign-in status, from the node to the console's Fleet page, without changing what any existing field means.

## Spikes

Both spikes ran on **Google Chrome for Testing 158.0.8127.36** (the Chromium bundled in the CI and container images), Linux x86_64, on 2026-11-25. A real Google account cannot be signed in from the CI container, so the signed-in and expired results below come from Chromium's own parser for the same data (`google_apis/gaia/gaia_auth_util.cc`, `ParseListAccountsData`, and `components/signin/internal/identity_manager/account_tracker_service.cc`) and are re-checked on a real unattended node in the close-out (E48.7, #933; recorded in `docs/nodes-acceptance.md`).

### Spike 1: what the profile's `Preferences` file holds

A fresh profile, launched and closed (signed out), writes `<profile>/Default/Preferences` with these sign-in keys:

```json
"google": { "services": { "signin_scoped_device_id": "c4ab…" } },
"signin": { "account_preview_data_last_update": "1344…", "accounts_metadata_dict": {}, "allowed": true },
"gaia_cookie": { "changed_time": 1795583114.21, "hash": "2jmj7l5rSw0yVb/vlWAYkK/YBwk=",
                 "last_list_accounts_binary_data": "", "periodic_report_time_2": "1344…" }
```

There is **no `account_info` key** while signed out. After a sign-in, the account tracker writes `account_info`: a list of `{ "account_id", "email", "gaia", "full_name", … }`, one per account Chrome tracks. Since Chrome's "Uno" sign-in model, a web-only Google sign-in (no Chrome sync, no "Turn on sync") still puts the account in the cookie jar and in the account tracker, so it appears in `account_info` as well; `google.services.last_signed_in_username` (and `signin.*` primary-account keys) appear only for a Chrome-level sign-in, so they are not relied on.

`gaia_cookie` is Chrome's own cache of the last `ListAccounts` answer. On Chrome 158 it is a base64 protobuf (`last_list_accounts_binary_data`), empty while signed out. Only its emptiness is used: empty means Chrome saw no Google web session at its last check. The protobuf is not decoded (its layout is not a stable interface).

### Spike 2: the live session from the extension

Google's `https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard` is what Chrome itself calls to list the accounts in the cookie jar.

| Call | Result (real, signed out) |
|---|---|
| `GET` | `200`, an HTML page that `postMessage`s the list to a parent frame (not usable) |
| `POST` (empty body) | `200`, `["gaia.l.a.r",[]]` |
| `fetch` from a web page | fails (CORS) |

The extension's service worker has `<all_urls>` host permission, so its `fetch(…, { method: 'POST', credentials: 'include' })` is not subject to CORS and carries the profile's Google cookies (Chrome treats an extension request to a host it has permission for as same-site). The answer, per `ParseListAccountsData`, is `["gaia.l.a.r", [account, …]]` where each `account` is an array with:

| Index | Meaning |
|---|---|
| 3 | email |
| 9 | `1` the session is valid, `0` Google needs the person to sign in again |
| 10 | Gaia id |
| 14 | `1` the account was signed out but is still listed |

So: **signed in** = an account with `[9] == 1` and `[14] != 1`; **expired** = an account with `[9] == 0` (Chrome knows it, the web session is no longer valid); **signed out** = an empty list, or every account signed out.

### Alternative evaluated: `chrome.identity.getProfileUserInfo`

Needs the `identity` and `identity.email` permissions (a new install-time warning), and reports only the **Chrome-level** primary account: a web-only Google sign-in reads as empty, and it cannot tell a valid session from an expired one. Rejected.

## Decision

1. **Two checks, on the node.**
   - **Offline (agent):** reads `<profiles_dir>/<name>/Default/Preferences` read-only, tolerating a partial or locked file. `account_info` with at least one email → `signed_in` (those emails); no `account_info` and an empty `gaia_cookie.last_list_accounts_binary_data` → `signed_out`; no `account_info` but a non-empty cached list → `unknown` (they disagree); a missing file (never launched), unreadable or invalid JSON → `unknown`. It cannot see `expired`. Runs at agent start, after every browser close (close, restart, crash) and on profile creation.
   - **Live (extension):** while the profile's Chrome runs, the service worker `POST`s `ListAccounts` and classifies the answer as above. Any non-200, network error, timeout or unparsable body → `unknown`. Runs at extension start, when the agent asks (every 10 minutes, over the existing native-messaging channel, so no `alarms` permission is needed), and when a tab finishes loading on `accounts.google.com` (fast success detection for E48.4). It uses no tab, focus or debugger, so a run on the profile is unaffected.
2. **Combining.** While the browser runs, the live result wins. When it is stopped, the offline result is used, except that a live `expired` for an account the offline check still lists stays `expired` (Chrome cannot repair a session while stopped). A failure or a disagreement is `unknown`, **never** `signed_out`: no false red warnings.
3. **No new extension permission.** `<all_urls>` and `tabs` already cover the live check.
4. **Transport: a separate route, not the poll query.** The agent reports with `POST /v1/hosts/{host_id}/profile-status` (host credential, body `ProfileStatusReport`), on change and at least once per poll cycle with the cached status. Emails are never put in the long poll's query string, which ends up in URLs and access logs. A report may cover some profiles; the others keep their last status. An agent that never reports leaves its profiles `unknown` (older agents keep working).
5. **Shape (browser-neutral).** `HostView.profile_status: [ProfileStatus { name, running, signin, accounts: [ProfileAccount { provider, email, state }], checked_at }]`, one per name in `profiles`, in the same order. `provider` is `google` first; another identity provider can be added without changing the shape. `profiles` and `running_profiles` are unchanged. The control plane keeps the last status in its state database, so a restart does not lose it. A `signed_in` or `expired` report with no usable account is stored as `unknown`.
6. **Console.** `GET /api/fleet/hosts` profiles gain `signin`, `accounts` and `checkedAt`. A missing or unknown value maps to `unknown`.

## Privacy rules (from the epic)

1. **Only the status leaves the node:** the state, the account email(s) and the time of the check. Cookie values and Google's response never leave the browser: the extension sends only `{ state, email }` per account.
2. **The email is display data.** It is shown in full to users with `fleet:read` (the console's owner owns these accounts). It never goes into an OTel span, a log line, the run trace, an export, a model's context or Hexactra's MCP tools:
   - Rust: `ProfileAccount`'s `Debug` prints `[redacted]`; the route logs only a count; the fabric's `host.profile_signin` event carries the state, never the email; a test (`crates/hexactra-control/tests/profile_status_api.rs`) asserts the email is in neither the log output nor the event stream.
   - Console: the MCP tool `hosts_list` strips `signin`, `accounts` and `checkedAt` (its shape is unchanged; `apps/api/test/fleet.spec.ts`).
   - The control plane's state database holds the last status (with the email) so it survives a restart, like host names.
3. **Sign-in status never authorises anything** and never blocks a run. Policy, gates, approvals, the Knowledge Graph and the agent do not read it.
4. **The fabric never types the Google password.** The person signs in through the desktop.
5. **Audit:** each guided sign-in (started, completed, abandoned) is an audit event (E48.4).

## Consequences

- Detection works on every node mode; only unattended nodes with a desktop get the console's one-click sign-in (E48.4). Attended and browser-only hosts show the status with a hint.
- `expired` is seen only while the browser runs (the live check). A stopped profile whose session expired reads `signed_in` until its browser next runs, unless the live check saw it expired before it stopped.
- If Google changes the `ListAccounts` format, the live check returns `unknown` (never a false `signed_out`), and the offline check still works.
- "Fix sign-ins" (E48.6) runs the guided sign-in for every profile that needs it, one at a time (Google flags simultaneous new-device sign-ins), from `/fleet/signin-queue`. On one host each sign-in starts with `keepLease`, so the person takes over once; the queue releases the lease (`DELETE /api/fleet/hosts/:id/takeover/:leaseId`) when it moves to another host, is stopped or ends. A kept-lease sign-in that times out gives the lease back itself, and a lease the page never released lapses with its five-minute renewal window.
