# AI usage and cost

What the console's AI costs, in tokens and dollars: per user and for the whole deployment, over a week, a month, a quarter or a year. Epic #730.

## Where to look

| Who | Where | Permission |
|---|---|---|
| Each user, their own usage | Settings → **My usage & cost** (`/settings/usage`) | `usage:read` (every role) |
| An AI administrator, everyone | Administration → **AI usage & cost** (`/admin/settings/usage`) | `ai_config:read` |
| Scripts | `GET /api/usage/report`, `GET /api/usage/export.csv` | as above |
| The CLI | `hexactra usage report [--range 7d\|30d\|90d\|1y] [--by model\|tokenType\|feature\|provider\|user] [--all] [--json]`, `hexactra usage export [-o file]` | as above |
| A hosted AI app (ChatGPT, Claude) | MCP tool `usage_report` (the caller's own usage), scope `usage:read` (low risk, ticked by default) | `usage:read` |

The page shows:
- **Period:** 7, 30 or 90 days by day, or **1 year** by month, in your time zone setting.
- **Cost** or **tokens** per period, stacked by **model**, **token type** (uncached input, cached input, output, reasoning), **feature** (browser agent, chat, task builder) or, for administrators, **user** or **provider**.
- **Tiles:** cost, tokens, model calls (and failures), **cache hit rate** (cached ÷ input tokens) and **cost per successful run**.
- **Cost by token type**, and a **table per model** with its share of the cost.
- **Export CSV:** one line per period × provider × model × feature (× user for administrators). The columns are requests, failed, input, cached input, output, reasoning and total tokens, `cost_usd` (empty when the model has no price) and `cost_known`. A cell that starts with `=`, `+`, `-` or `@` is prefixed with `'`, so a spreadsheet never runs it.

## How cost is computed

- Every model call is recorded by the platform's AI gateway in `ai_usage_events`, with its tokens. Catalogue syncs are recorded too, but carry no tokens and are left out of these reports.
- Cost = tokens × the price of the model that served the call, in USD per million tokens:
  - **Input:** the uncached part at the input price, the cached part at `cachedInputPerMTok` (or the input price when unset).
  - **Output:** reasoning tokens are billed as output.
- **Prices:** Administration → Model prices (`agentPricing`). A model with no price makes the cost a lower bound, shown as "≥ $x". The page names the unpriced models.
- **Your own prices:** Settings → **My model prices** (`agentPricing` in `PATCH /api/user-settings`). For a user whose own key pays a different rate. Your price replaces the deployment's price for the same model in:
  - your usage report (`pricing.overridesApplied: true`);
  - your runs' cost and cost budgets, from each run's next job.

  It never changes the deployment-wide report or anyone else's. Send `{ "agentPricing": null }` to clear it.
- The report prices at **today's** prices. A run's own stored cost (its page, the runs list, task spend) keeps the prices of the day it ran.

## How it stays fast for a year

- The ledger is summed per UTC hour into `ai_usage_hourly` by the job `usage.rollup`, every 15 minutes.
- A report reads the rollups up to `ai_usage_rollup_state.rolled_until` and the ledger after it, so it is current and never counts an hour twice.
- Rollups are kept 25 months; the ledger keeps `ai.usageRetentionDays` (180 by default).
- Details: [operations runbook, "AI usage rollups"](runbooks/operations.md#ai-usage-rollups).

## Alerts

The rule **Monthly AI spend** (`hexactra.ai_spend_monthly`, Administration → Alerts) is off by default.
- It fires when this calendar month's AI spend (UTC, at the deployment's prices) reaches `warnAtPercent` (80) of `maxDeploymentUsd` for the deployment, or of `maxUserUsd` for any one user.
- Leave either amount `null` to skip that check.
- An incident names a user by id only.

## When the numbers look wrong

- **Requests but 0 tokens.** The Doctor check `ai.usage_ledger` (Administration → Doctor) compares the runs' own token counters with the ledger, and fails when model calls are not being recorded (#731). Look for `Could not record AI usage` in the API log.
- **Cost "≥" or missing.** A model has no price. Add it in Administration → Model prices, or in My model prices for your own report.
- **A day looks short.** The rollups may be behind: `SELECT rolled_until FROM ai_usage_rollup_state;` should be within the last hour. Reports still add the ledger rows after it.
