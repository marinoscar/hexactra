# Saved approvals

A saved approval is the owner's standing answer to one kind of question: "on this site, do not ask me before this step". It is kept as a **structured rule the server matches**, never as a sentence the model is trusted to obey. This page covers the rules, how they match, the limits and **Pause all**, the page and the API (#554), and how a rule is made from a request card ("Don't ask again") and used in a run (#555).

## What a rule is

| Field | Meaning |
|---|---|
| `kind` | `gate`: a step the server's confirmation gate stops for, because the clicked element commits something (a payment, a purchase, a send, a delete, a submit; see [questions.md, "The confirmation gate"](questions.md)). `ask`: a question the agent asks on its own about a step the server would not stop for (opening a menu, choosing a date). |
| `host` | The **registrable domain** of the page: `bankofamerica.com` for `https://www.secure.bankofamerica.com/…`. Never empty, never a wildcard. |
| `category` | For `gate`: `payment`, `purchase`, `send`, `delete` or `submit`. Empty for `ask`. |
| `matchKey` | For `gate`: the element's label, normalised (below). For `ask`: a topic from a fixed list: `open_menu`, `choose_date`, `choose_option`, `fill_form`, `navigate`, `dismiss_dialog`, `scroll_or_expand`, `download`, `upload` (`other` is never remembered). |
| `summary` | What the owner reads: "Press 'Pay' on bankofamerica.com", "Choose dates on bankofamerica.com". |
| `taskId`, `conversationId` | Optional scope: only runs of this task, or of this chat. |
| `maxAmount` | Optional: only when the amount at stake is known and not larger. |
| `expiresAt` | Optional: the rule stops matching after this time. |
| `enabled` | The owner's switch for this rule. |
| `useCount`, `lastUsedAt`, `lastUsedRunId` | How often it was used, and the last run (cleared when that run is deleted). |

Rules live in `approval_rules`; each use is a row of `approval_rule_uses` (rule, run, step, time), the newest 200 per rule kept. Both are deleted with the user (`approvals.ownership.ts`), are part of the user's data export, and are in the Danger Zone's "Browser tasks and runs" category.

## How a rule comes to exist

**Only one way: the owner ticks "Don't ask again" on a request the server issued** (#555). The answer handler calls `ApprovalRulesService.createFromAnswer(question, choice)` (`apps/api/src/approvals/approval-rules.service.ts`) with the facts the **server** worked out for that question: the page's registrable domain from the fabric's report of the active tab, the gate's verdict, or the topic. A second identical tick returns the same rule.

There is **no route, CLI command or MCP tool that creates a rule**, and there must never be one: `apps/api/test/approval-rules.spec.ts` enumerates every REST operation, every MCP tool and the CLI's sources and fails if one appears. A personal access token with `approvals:write` may list, narrow, disable, re-enable and delete rules; it cannot create or loosen one. Web pages, model output and memories never create, widen or match a rule.

## "Don't ask again" on a request (#555)

**Which requests offer it.** A confirmation the server marked **rememberable**: the question's `rememberable` (`{ kind, host, category, matchKey, summary, scopes }`) is computed by the runner, never taken from the model or a request body:

- **A gate question.** The confirmation gate stopped a click (#550): `kind: gate`, the registrable domain of the active tab's URL as the fabric reports it, the verdict's category and the element's label read from the page.
- **An ask.** The agent asked on its own (`request_human` with `kind: confirmation`, input `confirm` or `none`) and named a `topic` from the fixed list. The runner reads the page's URL itself. A topic outside the list is `other`, and `other` is never rememberable.

A secret, a sign-in, a code, a choice and a question without a known site are never rememberable.

**The card.** Under Allow and Deny: a checkbox, **off by default**, "Don't ask again: Press 'Pay' on bankofamerica.com". Ticked, it opens **Limit it**: where (everywhere on this site, only this task, only this chat; the scopes the run has), up to an amount (for `payment`, `purchase` and `send`) and for how long (always, 30 days, 7 days), all optional. For `payment`, `purchase`, `send` and `delete` a warning line says the agent will do this without asking. The settled card reads "Allowed · won't ask again" with a link to the rule.

**The answer.** `POST /api/questions/{id}/answer` with `rememberRule: { enabled: true, scope?, maxAmount?, expiresInDays? }` (distinct from `remember`, a site's own "remember me", #527). It is accepted only:

- with an approval (`value: approve` on a `confirm`, or Done on a `none` confirmation);
- on a question the server marked rememberable;
- from the signed-in **web** or **Android** app: the declared channel must be `web` or `android_app` **and** the request's credential must be the console's own session (its origin, from the credential, is `web` or `android`). A notification button, the answer link, a webhook, the MCP relay, an elicitation form, an MCP Apps card, a hosted AI app, the CLI and a personal access token approve **once** and get `422` (`REMEMBER_NOT_ALLOWED_HERE`, `NOT_REMEMBERABLE`, `REMEMBER_NEEDS_APPROVAL`); the question stays answerable once from there.

The rule is created by `createFromAnswer` **in the same transaction as the answer**: both happen or neither. A second identical tick returns the same rule. The response's `ruleId` names it.

**In the run** (`apps/api/src/runner/goal-runner.service.ts`):

- **Gate.** Where a click would be refused, the runner first asks `ApprovalRulesService.match` with the page's registrable domain, the verdict's category and the normalised label, the run's task and chat, and the amount when the owner's inputs make one known (the one `money` parameter of the task, #552; otherwise unknown). On a match the click is carried out, the step's `args.approval = { ruleId }` and its summary says "allowed by a saved approval: …", the use is recorded, and the step is a confirmed action "by saved approval" (#540). A rule applies only when the page itself described the target: never when that read failed or the target is in a cross-origin frame.
- **Ask.** `request_human` with `kind: confirmation` and a `topic`: on a matching `ask` rule the tool answers "The owner has a standing approval for this on this site. Go ahead." No question is created; a `handoff` step with `action: pre_approved` is recorded and it is not an action (no budget, no stall count).
- **Telling the model.** The volatile tail of the model input carries one line for the current site when it has `ask` rules: "On bankofamerica.com the owner does not want to be asked before: choosing dates, opening menus." Gate rules are never announced; the gate simply does not fire. The line is advice that lowers questions; it never authorises a step.
- **AI apps.** In a run an AI app started with its "confirm purchases" limit on (#464), a gate question is always asked, whatever rules exist. That limit is the app's own setting, separate from a personal rule.

**Notifications.** At the end of a run in which a `gate` rule was used: one notification, "2 steps went ahead on saved approvals: Press 'Pay' on bankofamerica.com.", linking to the run (event `runs.saved_approvals_used`, browser and push). A chat's result card shows the same line. `ask` rules do not notify.

## How a rule matches

`apps/api/src/approvals/approval-match.ts`, pure and table-tested (`test/approval-match.spec.ts`):

- **Site.** `registrableDomain(url)` uses the public-suffix list (the `tldts` package, private suffixes included): `www.secure.bankofamerica.com` and `bankofamerica.com` are the same site; `bankofamerica.com.evil.com` is `evil.com`; `someone.github.io` is its own site. An IP address, `localhost`, a host without a public suffix, `file:`, `data:`, `chrome:` and `about:` pages **never** match.
- **Label.** `normaliseLabel(label)`: lower-case, trademark signs removed, every number replaced by `#`, whitespace collapsed, punctuation at the ends removed, at most 200 characters. "Pay $10.00" and "Pay $975.10" are both `pay $#`. Two labels match **only when equal** after this: no prefix, substring or pattern matching, so "pay" never matches "pay all" or "prepay".
- **Rule.** `findRule(rules, query)` matches a rule when it is enabled, not expired, its host, kind, category and key equal the query's, its task or chat scope (when set) equals the run's, and, when it has `maxAmount`, an amount is known and not larger. **A rule with `maxAmount` and an unknown amount does not match.** The most specific match wins: a scoped rule before an unscoped one.
- **Pause all.** While the owner's `approvals.paused` user setting is on, nothing matches.

## What a rule never does

- Apply on another registrable domain, or when the page's address is unknown.
- Apply to a label that differs after normalisation.
- Answer a password, a code, a sign-in or a choice (#555): those questions are never rememberable, and the answer handler refuses a tick on anything but a confirmation.
- Apply when the page could not describe the clicked element (a cross-origin frame, a failed read).
- Get created, claimed or widened by the model: a `rememberable`, `gate` or host in `request_human`'s arguments is dropped.
- Override the task's allowed sites, or an AI app's own "confirm purchases" limit (#464): a gate question in that app's runs is always asked.
- Apply while Pause all is on.

## Limits can be tightened, never loosened

`PATCH /api/approval-rules/{id}` takes only `enabled`, `maxAmount`, `expiresAt`, `taskId` and `conversationId`, and only to **narrow**:

| Field | Allowed | Refused (`400 RULE_CANNOT_WIDEN`) |
|---|---|---|
| `maxAmount` | Set one where there was none; lower it | Raise it; remove it (`null`) |
| `expiresAt` | Set one; bring it forward | Move it later; remove it |
| `taskId`, `conversationId` | Add a scope | Remove or change a scope |
| `enabled` | Turn off; turn back on | |

A looser rule is made by answering a new request with "Don't ask again" ticked.

## The page

**Settings → Browser agent → Saved approvals** (`/settings/approvals`, `approvals:read`): rules grouped by site, each with its summary, a category chip (payment, purchase, send and delete in the warning colour), its limits in words ("up to $50.00 · only in the task Weekly groceries · until Dec 31, 2026"), how often it was used with a link to the last run, and a switch. The row menu has **Add a limit** (amount, end date, task; it refuses to loosen and says why) and **Delete** (asks first). **Pause all** in the header turns every rule off and shows a banner while it is on. Without `approvals:write` the page is read-only. A run step that a saved approval allowed (#555) links to its rule (`/settings/approvals#rule-<id>`).

## API

| Route | Permission | Notes |
|---|---|---|
| `GET /api/approval-rules?host=&enabled=` | `approvals:read` | `{ paused, rules }`: the caller's rules, newest first, and whether Pause all is on. |
| `GET /api/approval-rules/{id}` | `approvals:read` | The rule with its newest 20 uses (run, step, time). |
| `PATCH /api/approval-rules/{id}` | `approvals:write` | Narrow, disable or re-enable (above). |
| `DELETE /api/approval-rules/{id}` | `approvals:write` | Permanent, with its uses. |
| `PUT /api/approval-rules/paused` | `approvals:write` | `{ paused }`: Pause all. |

`approvals:read` is granted to contributors, viewers and organization admins; `approvals:write` to contributors and organization admins (like `runs:delete`). Another user's rule is `404 APPROVAL_RULE_NOT_FOUND`, the same as a missing one. Hosted AI apps (MCP) cannot read, create or change saved approvals; the CLI has no command for them (`packages/shared/capabilities.json`, `approvals.list` and `approvals.manage`).

## Audit, metrics and the alert

- **Audit events** (`audit_events`): `approval_rule.created`, `approval_rule.used`, `approval_rule.narrowed` (with the fields), `approval_rule.disabled`, `approval_rule.enabled`, `approval_rule.deleted`, `approvals.paused`, `approvals.resumed`. They carry ids, the host, the category and the kind; never a page's label.
- **Metrics:** `app.approvals.rules` (gauge of enabled rules, by `kind`) and `app.approvals.uses` (counter, by `kind` and `category`).
- **Alert:** "Saved approval used a lot" (`hexactra.approval_busy`, kind `hexactra_approval_busy`, on by default): one rule used more than 20 times in 24 hours, so a loop that keeps pressing a remembered button is noticed. Administrators tune it at Administration → Alerts.

## The residual risk

"Anything I tick" removes the last brake on a remembered payment: a page on the same site that manages to steer the agent could reach the remembered button. The server matching the page's real site and the element's exact label, the owner's optional limits, the recorded and audited uses, the alert and Pause all lower that risk; they do not remove it.

### With saved logins and a schedule (epic E37)

A saved login changes what a remembered approval can do, so the risk is stated again here: **a saved login plus a remembered approval plus a schedule can move money with nobody watching.** The origin binding of a saved login stops a look-alike site; it does not stop a real page on the saved site steering the agent to the remembered button. Two brakes are built for exactly this (the first is a default the owner can lift, and a remembered rule can still let a click through):

- A run that signed in from a saved login and was **not started from a chat** (a schedule, the API, MCP) keeps the confirmation before payments on unless the task says `unattendedPayments: allow` ([secrets.md](secrets.md#how-the-agent-signs-in)). **A saved approval the owner made still applies as they defined it**, so a payment a remembered rule covers goes ahead: that is the combination to be careful with, and the reason a rule can carry an amount, an expiry and a scope. A scheduled run that used a saved login sends one notification at its end.
- A **card** is never covered by a site-wide rule: it needs an approval bound to the merchant **and** the card with a required amount limit, and **no rule covers every merchant** ([Cards](#cards-e377)).

Saved logins never create an approval and an approval never releases a secret: the rule decides only whether the owner is asked before a click, and the value is released by the provider under its own rules. The threats this does not stop are in [security-secrets.md](security-secrets.md).

