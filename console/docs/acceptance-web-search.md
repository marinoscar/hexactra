# Acceptance run for web search and diagnostics (E50)

Epic E50 ([#970](https://github.com/marinoscar/hexactra/issues/970)) gives the agent web search and page reading without the browser, keys of outside services in tiers, and a staged diagnostic report for every connection and search provider ([web-search.md](web-search.md), [connections.md](connections.md#diagnostics-e5010)). This page is the checklist the owner runs on a real deployment, with real keys and accounts, to settle what the automated tests cannot: that the providers, the accounts and the pages behave as their fakes do.

**Status when this was written (2026-11-27, E50.16 #986): not performed.** Every line below is **Not run — no deployed stack/keys in this session**: the session that closed the epic had no deployed stack, no node, no AI provider key, no search key and no real Google, Microsoft or MCP account. The automated evidence (unit, database and scenario tiers in CI) ran against fakes only. Issue #986 stays open until this checklist and the benchmark ([decision record, Benchmark](decisions/web-search.md#benchmark-web-search-against-searching-in-the-browser-e5016)) are run.

## Before you start

You need the deployed stack the real-account verification uses ([#661](https://github.com/marinoscar/hexactra/issues/661); [vps-stack.md](runbooks/vps-stack.md)) at the commit under test, with:

- **The node updated** (`hexactra agent update`, then `hexactra agent doctor`) and an AI provider configured (Administration → AI) for the agent.
- **A Brave Search key** (the default provider; [web-search.md, Getting a key](web-search.md#getting-a-key-at-each-provider)), and a second user account on the console without a key of its own.
- **Optionally** a Tavily or Exa key, a SearXNG instance (public, or on your network with the private-network tick), and the OpenAI key and hosted-tools switch for OpenAI web search.
- **A Google and a Microsoft account** connected through the deployment's apps ([acceptance-connections.md](acceptance-connections.md#before-you-start)), and a public MCP server (from the presets, or by address).
- **A phone** that renders the console at about 390 CSS pixels wide.

## What to record, and what never goes in the issue

Record, for each line: **passed**, **failed** (with the follow-up issue you filed), or **not run and why**; the run ids (`/runs/<id>`); the console version; the closed codes you saw; the times; the estimated cost shown.

**Never put in the issue, a comment or a PR:** a key or any part of it, a query that names you or another person, a page address that identifies you, mailbox content, account addresses, an MCP server's token, or a screenshot that shows any of these. See the next paragraph for what to search.

For the searches, ask a stable public fact you do not mind in the provider's logs (a capital city, the date of a public holiday), never a question about yourself.

## The checklist

| # | Line | Result | Run ids, codes, times, cost | Follow-up issue |
|---|---|---|---|---|
| 1 | **A real Brave key as the deployment key:** Administration → Web search, save the key, **Test** passes every stage (`switches`, `credential`, `network`, `live_query`, `limits`, `fetch`) | Not run — no deployed stack/keys in this session | | |
| 2 | **A chat answers a public question with a search and no browser:** the reply cites the page; no browser session opened | Not run — no deployed stack/keys in this session | | |
| 3 | **The run page shows the steps and the estimated cost:** "Searched the web for …", "Read <host>", the count in the steps header, the search cost apart from the AI cost; Administration → Web search → Usage counts it | Not run — no deployed stack/keys in this session | | |
| 4 | **A user's own key overrides the deployment's:** the second user saves their own key; `hexactra search status` and Settings say it answers with their key; usage counts it under them | Not run — no deployed stack/keys in this session | | |
| 5 | **"Do not share the deployment key":** switch sharing off; a user without a key reads a clear message (`KEY_MISSING`), Test says so, the agent searches in the browser; nobody is told the deployment key exists | Not run — no deployed stack/keys in this session | | |
| 6 | **A wrong key:** Test fails at `live_query` with `SEARCH_KEY_REFUSED` (or `AUTH_REFUSED`) and its remedy; a run falls back to the next provider or to the browser and does not fail | Not run — no deployed stack/keys in this session | | |
| 7 | **Always available:** a brand-new task and a new chat, with nothing ticked, are offered web search, the connected accounts and the enabled MCP tools (the task form's read-only line names them) | Not run — no deployed stack/keys in this session | | |
| 8 | **The switch removes it from the next run:** switch web search (and then one account, and one MCP tool) off on the Connections page; the next run is not offered it; on brings it back | Not run — no deployed stack/keys in this session | | |
| 9 | **A write still asks:** with everything on, a run that would send a mail waits on a card and sends nothing until you approve | Not run — no deployed stack/keys in this session | | |
| 10 | **A task with allowed sites:** search is still offered; its results stay inside the list (and say how many were left out); `web_fetch` refuses an address outside it; OpenAI web search is not used for that run | Not run — no deployed stack/keys in this session | | |
| 11 | **Stop during a search:** press Stop while a search or a page read is in flight; the run stops at once and no later call reaches the provider (usage shows no extra search) | Not run — no deployed stack/keys in this session | | |
| 12 | **Google:** Test on a working account passes; a switched-off Google API is named (`API_DISABLED_*`); a revoked grant fails `sign_in` with `GRANT_REVOKED`; the administrator's **Test app setup** passes and fails with a wrong secret (`APP_CREDENTIALS_REFUSED`) | Not run — no deployed stack/keys in this session | | |
| 13 | **Microsoft:** the same four checks; `MAILBOX_NOT_FOUND` or `LICENSE_MISSING` on an account without a mailbox if you have one | Not run — no deployed stack/keys in this session | | |
| 14 | **An MCP server (a real public one):** add it from a preset or by address; its diagnostics pass; **Try** a Read tool; change a tool on the server (or use one that changes) and see it quarantined (`TOOLS_CHANGED`, off until reviewed) | Not run — no deployed stack/keys in this session | | |
| 15 | **Doctor:** Administration → Doctor shows the `connections.*` and `web_search.*` lines passing; break something (an unshared key with user keys off, a failed deployment test) and see the line change | Not run — no deployed stack/keys in this session | | |
| 16 | **The phone:** at a real 390 px device, the Connections and tools page, the diagnostics panel (full-screen sheet) and the task form are usable with no sideways scroll | Not run — no deployed stack/keys in this session | | |
| 17 | **Each second provider, as available:** Tavily, Exa (key), SearXNG (an instance; with the private-network tick if on your network), OpenAI web search (the AI key, its model, the hosted-tools switch): Test passes, a search answers, the cost is estimated | Not run — no deployed stack/keys in this session | | |
| 18 | **The CLI from a server with no browser:** `hexactra search status`, `search test`, `search query`, `search key set brave --stdin`, `connections diagnose <connection>` print the same codes as the panel, with the documented exit codes | Not run — no deployed stack/keys in this session | | |

## What was not verified, and is yours to confirm

Everything this checklist covers, plus the provider-specific points of [web-search.md, What has not been verified](web-search.md#what-has-not-been-verified) and [connections.md, What has not been verified](connections.md#what-has-not-been-verified-and-what-the-owner-must-do): the exact request and answer shapes of each provider, their quota signals, their prices, the extraction of real pages behind real bot protection, and a key kept in a real Vault.

## When it is done

Comment on #986 with the filled table (no content, see above), link each failure's follow-up issue, and record the benchmark's scorecard in the decision record. Only then is #986 closed.
