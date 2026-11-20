# Runbook: request history and the default wait (E40.4)

What agents ask their owners (codes, sign-ins, approvals, choices, the details to start a task) is kept as **request history**: the Inbox's History tab, the request cards in chats, and the question view of a run's trace. A value such as a password or a code is never stored, only that it was provided.

Two settings, in **Admin → Settings → Request history** (`/admin/settings/request-history`, the `questions` namespace of the system settings; reading needs `system_settings:read`, saving `system_settings:write`):

| Setting | Default | Range | What it does |
|---|---|---|---|
| `historyKeepDays` | 7 | 1 to 3650 | Answered, declined and expired requests are deleted this many days after they ended (answered or declined: `answeredAt`; expired: `expiresAt`), with their `request` message in a chat. A request still waiting is never deleted. |
| `defaultWaitMinutes` | 60 | 1 to 1440 | How long a question waits when its asker set no time. Then it expires and its run goes on without the answer. Applies to questions a run asks in the browser (a code, a sign-in, a CAPTCHA: the fabric's handoff gets the same time) and without it. Approvals for a connected account and the details to start a task keep 24 hours; a caller's own `timeoutMs` wins. |

## The nightly job

- Job type `questions.history.retention` (housekeeping, server-only), enqueued at 03:50 server time by a cron that only enqueues.
- It deletes in batches of 500, at most 50,000 per night; the rest goes the next night.
- Each pass writes an audit event `questions.history.purged` with `{ deleted, messages, keepDays, ms }`.
- A run is not deleted: its answer step keeps its summary ("The owner provided it") until the run's own retention ([run-retention.md](run-retention.md)) removes it; the step's link to the question is cleared, and a chat's card for it is removed.

## Check it

```bash
# The settings as stored (an admin token).
curl -s "$HEXACTRA_CONSOLE_URL/api/system-settings" -H "Authorization: Bearer $TOKEN" | jq '.data.questions'
# Change them.
curl -s -X PATCH "$HEXACTRA_CONSOLE_URL/api/system-settings" -H "Authorization: Bearer $TOKEN" -H "If-Match: <version>" \
  -H 'Content-Type: application/json' -d '{"questions":{"historyKeepDays":14,"defaultWaitMinutes":240}}'
```

The last passes are in the Jobs admin page (type `questions.history.retention`) and the audit log (`questions.history.purged`).

## Recover

Deleted history is not recoverable except from a [database backup](run-retention.md#recover-from-a-rule-that-deleted-too-much). Raise `historyKeepDays` before an investigation that needs older requests.
