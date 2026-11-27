# Web search

The owner's and the administrator's guide to web search (epic E50, #970): what it is, how to switch it on, keys, limits, cost, reading pages, Test and Diagnostics, the CLI, how to add a provider, and what has not been verified. The design is in the [decision record](decisions/web-search.md); what stops each misuse is the [threat model](security-web-search.md); the checklist for a real deployment is [acceptance-web-search.md](acceptance-web-search.md).

**Status, honestly.** Everything on this page is implemented and tested against **fakes**: in-process fakes of each provider's documented API, a fake web for page reading, and a scripted AI provider. **No real search has been made**: no session that built this epic had a search key, an AI key or a node. The comparison with searching in the browser (cost, speed, success) has **not been measured** ([What has not been verified](#what-has-not-been-verified)).

## What web search is, and when the agent uses it

Web search gives the agent two tools that do not need the browser:

- **`web_search`** asks a search provider (Brave Search by default) for results, through the console server, and shows the agent the titles, addresses and excerpts.
- **`web_fetch`** reads one public page as text, from the console server ([What `web_fetch` can and cannot read](#what-web_fetch-can-and-cannot-read)).

The agent reads, in its instructions, to search the web first when it needs to find out something public (a fact, a price, a how-to, which page to use), to read one or two of the best pages when the excerpts are not enough, and to **open the browser** when the job is to act on a site, when a page needs a sign-in or scripts, or when a search did not answer. It can mix them: find the page by search, then act on it in the browser. Your own mail, calendar and files are never a web search: those are your connected accounts ([connections.md](connections.md)).

What a search result, an answer or a page says is **data from third parties**. It is never an instruction to the agent and it cannot change what the agent may do ([threat model](security-web-search.md)).

Where it is: Settings → **Connections and tools**, section **Web search** (your status, switch, own key, Test and Try a search); Administration → **Web search** (the deployment's switches, providers, keys, limits, page reading and usage); the run page (`web_search` steps read "Searched the web for “…”", `web_fetch` steps "Read <host>"); the CLI `hexactra search` ([The CLI](#the-cli)).

## Switching it on (administrator)

Web search is **on by default** for the deployment (`webSearch.enabled`) and for each user (their own `webSearch.enabled`), and Brave Search is first in the order. It works as soon as a provider has a key someone may use. So the administrator's job is to choose how keys are handled:

1. Administration → **Web search**. Check that **Web search** is on.
2. Choose the providers and their **order** (up and down buttons; a provider not in the order is never used) and switch off any you do not want.
3. Choose **how keys are handled**, with the two switches **Share the deployment's key with everyone** (`shareDeploymentKey`, default on) and **Allow users' own keys** (`allowUserKeys`, default on):

   | You want | Deployment key | Share it | Users' own keys |
   |---|---|---|---|
   | **One key for everyone** (the deployment pays) | set | on | off |
   | **Each user's own key** (each user pays; nobody can search without one) | none, or set but not shared | off | on |
   | **Both** (the default: a user's own key wins, the deployment's key for everyone else) | set | on | on |

   A user's own key wins over their organization's, which wins over the deployment's. With the deployment key not shared, a user without their own key is told, on their Web search section and in Test, that they need one (`KEY_MISSING`); the agent searches in the browser instead.
4. Set the deployment's key (a write-only field: after saving it is empty and the row says when it was saved) and press **Test** ([Test and Diagnostics](#test-and-diagnostics)).
5. Check the **limits** and **page reading** ([Limits](#limits-and-what-the-agent-does-when-one-is-reached)).

To switch web search off for everyone, switch **Web search** off: no run or chat is offered `web_search` from its next start, and the agent searches in the browser. A user switches it off for themselves with **Let the agent search the web** (`hexactra search off`).

## Getting a key at each provider

Written on **2026-11-27**, from the providers' documentation as the author knew it; **none of these pages was re-read from the session that wrote this guide** (they are outside its network), and sign-up pages change. Follow the provider's own page; no screenshot of a provider's console is reproduced here.

- **Brave Search** (`brave`): on the Brave Search API page (<https://brave.com/search/api/>), sign up for the API dashboard, subscribe to a plan (a free plan with a small monthly allowance existed; the paid plan was about USD 5 per 1,000 calls), then create an **API key** in the dashboard's keys page. Paste it in the console as the Brave Search key. The key goes in the `X-Subscription-Token` header and never in an address.
- **Tavily** (`tavily`): sign up at <https://app.tavily.com>; the dashboard shows an API key (it starts `tvly-`). A free allowance of 1,000 credits a month existed; a basic search costs one credit.
- **Exa** (`exa`): sign up at <https://dashboard.exa.ai>, open **API keys**, create one. Exa sells credits; a search with one short highlight per result was about USD 0.01.
- **SearXNG** (`searxng`, self-hosted): no key. Run an instance (<https://docs.searxng.org>), add `json` to `search.formats` in its `settings.yml`, and enter its address in Administration → Web search ([SearXNG](#providers)).
- **OpenAI web search** (`openai`): no search key. It uses the OpenAI key of the AI settings (Administration → AI, or your own AI key); an OpenAI key is created at <https://platform.openai.com/api-keys>. The administrator also chooses its model and switches on **Web search** under the hosted tools in Administration → AI ([OpenAI web search](#providers)).

## Where the key is kept, and what that means

A search key is a **key of an outside service**: the console itself uses it when it calls the provider for you. It is not a saved login: the agent never types it into a page, the fabric never receives it, and no tool lists it. Detail: [secrets.md, Keys of outside services](secrets.md#keys-of-outside-services).

- **By default in the console's encrypted credential store**, name `web_search.<provider>`, in three tiers: yours, your organization's and the deployment's. Write-only: no route, page, log, span, step, export, diagnostic report or CLI output shows any part of it.
- **Your own key can live in your secrets provider instead** (your Vault, or the built-in store; E50.3): Settings → Secrets, "Keys of outside services", **Move here**. The organization's and the deployment's keys always stay in the console. A key in your Vault is read for each search through your existing Vault grant (cached in memory for at most 60 seconds); when your Vault cannot answer, the next tier's key is used if the administrator allows it, else the agent is told search is unavailable and uses the browser. A Vault outage never fails a run.
- **The key is resolved on the server at the moment of each request**, by tier, and used only in the one header the provider documents.

## One switch, always available, and allowed sites

**What is switched on is always available.** When web search is set up (a provider has a key you may use) and switched on (the administrator's switch and yours), **every** run and chat of yours is offered `web_search`, and `web_fetch` while page reading is on: a task's run, a one-off run, a chat and the chat's own model. **There is no per-task or per-chat choice**, and nothing a task, a chat, a model or a page says can switch it on or off. Your switch and the administrator's are the only controls (the rule of E50.17, [connections.md](connections.md#how-a-task-chooses-its-tools-967-e5017)). A run decides this once, when it starts: a switch flipped mid-run is honoured by refusing the next call. An AI app's run also follows the app's own limit **Let its runs search the web** (`allowWebSearch`, on by default for a new app).

**Allowed sites bind it.** A task with allowed sites is still offered web search:

- `web_search` leaves out every result outside the allowed sites (and says how many), and with one allowed host it narrows the search to that host; a search aimed at another site is refused;
- `web_fetch` refuses an address outside the list before anything is sent, and checks every redirect against it;
- an answer-type provider (OpenAI web search) is skipped for that run, because its answer is written from pages the console never sees; a result-type provider answers instead.

## Limits, and what the agent does when one is reached

| Limit | Default | Where | When it is reached |
|---|---|---|---|
| Searches per run (`webSearch.limits.perRun`) | 30 | Administration → Web search | the tool answers "limit reached" and the agent uses the browser |
| Searches per user per day, UTC (`webSearch.limits.perUserPerDay`) | 300 | Administration → Web search | the same; Test says `LIMIT_REACHED` and sends nothing; over 80% it warns `LIMIT_NEAR` |
| Pages read per run (`webSearch.limits.fetchPerRun`) | 30 | Administration → Web search | `web_fetch` answers "limit reached"; the agent opens the page in the browser |
| Web calls in the run's agent policy (`budget.maxWebCalls`: searches and page reads together) | Economy 10, Balanced 30, Thorough 100, Unlimited none | the agent policy | "This run has used all its web searches."; the run goes on with the browser |
| Searches a minute from Try a search, Test and the CLI | 10 per user | fixed | `WEB_SEARCH_TEST_RATE_LIMITED` with the seconds to wait |
| Diagnostic reports a minute | 6 per provider | fixed | `DIAGNOSTICS_RATE_LIMITED` |

Each limit can be set to unlimited (`null`). **Reaching a limit never stops a run**: the tool answers a fixed sentence and the agent carries on with the browser. A provider that refuses the key, is out of quota or does not answer is followed once by the next usable provider in the order; if none answers, the agent is told search is not available and uses the browser.

## Cost

**Every price here is an estimate from the provider's published page as the author knew it on 2026-11-26/27; check the provider's page.** The console shows it as "about $x a search (estimate)" and never as a price.

| Provider | Default estimate per search | What else |
|---|---|---|
| Brave Search | USD 0.005 | a small monthly free allowance existed |
| Tavily | USD 0.008 (one credit, basic search) | 1,000 free credits a month existed |
| Exa | USD 0.01 | |
| SearXNG | 0 | your own hosting |
| OpenAI web search | USD 0.01 (the search fee only) | plus the tokens of the pages the model read and of its answer, priced in the AI usage ledger under the feature **Web search** |

- **Where the estimate is shown:** a run's summary counts its searches and page reads and shows the estimated search cost **apart from** the AI cost; Administration → Web search → **Usage** shows searches, failures and the estimated cost by day and provider (no user, no query); `hexactra search admin usage` prints the same.
- **How to correct it:** Administration → Web search, the provider's **estimated cost per search** (`webSearch.providers.<id>.costPerCallUsd`); `null` goes back to the default. It changes the estimate from then on.
- **What it does not include:** the AI tokens of the run (the agent reading the results): those are in [usage.md](usage.md), like every model call.

## What `web_fetch` can and cannot read

`web_fetch` reads **one public page** from the **console server** (not the node): its address, often a datacenter's, makes the request.

- **It reads:** HTML (the main content, headings and lists as lines, links as text with their address; scripts, styles, navigation, forms and hidden parts left out), plain text, JSON, and the text of the first 50 pages of a PDF. The agent gets 12,000 characters by default and at most 50,000; 5 MB is read at most. It follows up to five redirects, each checked.
- **It cannot:** sign in, send a cookie, run a script, click or fill a form, read an image or a video, or reach a private or internal address (each address is checked on every hop, the connection is pinned to the checked address). Only `https`, ports 443 and 8443. A page behind a bot check, a `401`, `403` or `429` answers **blocked**, and the agent opens it in the browser on the node.
- **It honours:** the run's allowed sites at every hop, the administrator's **blocked hosts** (`webSearch.fetch.blockedHosts`), the per-run limit, Stop.
- **It keeps:** a page in memory for 10 minutes per user (checked again against the run's sites when reused); nothing in the database or the object store. The step records the host and path, never the page text. `robots.txt` is not read: one page the owner's agent asked for is a user-initiated read, as in the browser; nothing is crawled.
- **Switch it off** in Administration → Web search (page reading); search stays.

## Test and Diagnostics

**Test** (on your Web search section, the administrator's provider row, or `hexactra search test`) runs a diagnostic report and shows it in the diagnostics panel: each stage in order, its status (Passed, Warning, Failed, Skipped), and for the first failure the remedy, who can fix it and a link.

| Stage | What it checks |
|---|---|
| `switches` | the deployment's switch, yours, the provider's switch, the provider in the order |
| `credential` | a key you may use at an allowed tier (or the address, or the AI checks of an answer-type provider) |
| `network` | the provider's host resolves to a public address and answers (skipped for OpenAI: the AI service holds the connection) |
| `live_query` | **one real search** of a fixed common word, counted as one call of your day (it costs what a search costs) |
| `limits` | today's count against the per-day limit |
| `fetch` | page reading on, and one read of a fixed public page (`https://example.com/`) |

The administrator's Test uses **the deployment's key only**, never a user's, and stores the report with no owner. A report holds codes, counts and timings only: never a key, a query you typed, a provider's message or a page. At most 6 reports a minute per provider. Doctor (Administration → Doctor) reads the stored reports and the usage, never calls a provider ([operations runbook](runbooks/operations.md#reading-the-connections-and-web-search-lines-in-doctor)).

Connections (Google, Microsoft, MCP servers) have their own stages with the same codes, panel and table ([connections.md, Diagnostics](connections.md#diagnostics-e5010)). When web search or a connection stops working: [operations runbook, Web search stopped working](runbooks/operations.md#web-search-stopped-working) and [A connection stopped working](runbooks/operations.md#a-connection-stopped-working).

### Every code and its remedy

The table below is **generated** from `packages/shared/diagnostics.json` (the one table the API, the web app and the CLI read) by `npm run docs:diagnostics`; CI fails when it is stale (`npm run docs:diagnostics -- --check`). Edit the JSON, never the table. `apps/api/test/diagnostics.spec.ts` and `web-search-diagnostics.spec.ts` fail when a code a stage can return has no entry.

<!-- diagnostics-codes:start (generated from packages/shared/diagnostics.json by `npm run docs:diagnostics`; do not edit) -->

98 codes. A report names the code; the web app's diagnostics panel and the CLI print these words.

| Code | Title | What to do | Who can fix it | Where |
|---|---|---|---|---|
| `CONNECTION_PAUSED` | Paused | Nothing uses this connection while it is paused. Resume it to use it again. | You (the owner) | Connections and tools |
| `CONNECTION_NEEDS_RECONNECT` | Needs to be connected again | The service no longer accepts this connection's sign-in. Connect the account again. | You (the owner) | Connections and tools |
| `GRANT_REVOKED` | The access was withdrawn | The access was revoked or expired at the service (a password change, a removed app, an expired test grant). Connect the account again. | You (the owner) | Connections and tools |
| `NO_REFRESH_TOKEN` | The sign-in cannot be renewed | The service did not give a way to stay signed in. Connect the account again. | You (the owner) | Connections and tools |
| `TOKEN_STORE_FAILED` | The sign-in could not be saved | The console could not store the renewed sign-in. Connect the account again; if it happens again, tell your administrator. | You (the owner) | Connections and tools |
| `AUTH_REFUSED` | The sign-in was refused | The server refused the sign-in it was given. Reconnect it with a valid token or sign in again. | You (the owner) | Connections and tools |
| `NO_SECRET` | The saved token is missing | The token or header value saved for this server is gone. Reconnect it with the token. | You (the owner) | Connections and tools |
| `NOT_INSTALLED` | Not installed here | This kind of connection is not installed on this deployment. Ask your administrator. | Your administrator | Administration |
| `PROVIDER_DISABLED` | Switched off here | Your administrator switched this kind of connection off for this deployment. | Your administrator | Administration |
| `APP_NOT_CONFIGURED` | The administrator's app is not set up | The deployment's app at the provider is missing its client id or secret. Ask your administrator to finish the setup. | Your administrator | Administration |
| `APP_REFUSED` | The provider refused the deployment's app | The provider no longer accepts the deployment's app (a changed or expired client secret). Ask your administrator to check it. | Your administrator | The provider's own console |
| `REFUSED` | The provider refused the request | The provider refused to renew the sign-in. Try again later; if it keeps failing, connect the account again. | You (the owner) | Connections and tools |
| `UNAVAILABLE` | The provider could not be reached | The service did not answer or answered with an error. Nothing was changed; try again in a few minutes. | You (the owner) |  |
| `UNAUTHORIZED` | The sign-in was refused | The service did not accept the sign-in. Test again; if it still fails, connect the account again. | You (the owner) | Connections and tools |
| `FORBIDDEN` | The provider refused: the permission is missing | The account signed in but is not allowed to do this. Use "Change what it can do" to ask for the permission again. | You (the owner) | Connections and tools |
| `PERMISSION_MISSING` | A permission is missing | The provider did not grant a permission this capability needs (the report names the capability). Use "Change what it can do" on the connection, sign in again and tick that permission on the provider's consent screen. | You (the owner) | Connections and tools |
| `CAPABILITY_OFF` | Switched off for this account | This capability is switched off for this connection. Switch it on if you want it used. | You (the owner) | Connections and tools |
| `API_DISABLED` | The service is switched off in the administrator's app | The API this capability uses is not enabled in the deployment's project at the provider. Ask your administrator to enable it. | Your administrator | The provider's own console |
| `NO_MAILBOX` | This account has no mailbox | The account has no mailbox the service can read (for example a personal account without mail, or one not licensed for it). Switch Mail off for it, or connect another account. | You (the owner) | Connections and tools |
| `NOT_FOUND` | Not found at the provider | The service answered that the resource this check reads does not exist for this account. | You (the owner) |  |
| `FAILED` | Failed | The service answered in a way the console did not expect. Try again; if it keeps failing, tell your administrator. | You (the owner) |  |
| `RATE_LIMITED` | Asked to slow down | The service asked to slow down. Try again in a minute. | You (the owner) |  |
| `QUOTA_EXCEEDED` | Quota used up | The quota at the service is used up. It resets later; your administrator may raise it at the provider. | Your administrator | The provider's own console |
| `MCP_PROTOCOL` | Not an MCP server | The server did not answer in the MCP protocol this console speaks (Streamable HTTP). Check the address. | You (the owner) | Connections and tools |
| `RPC` | The server answered with an error | The server answered the request with an error. Try again; if it keeps failing, contact whoever runs the server. | You (the owner) |  |
| `REDIRECT` | The server redirected | The server answered with a redirect, which is never followed. Use the server's final address. | You (the owner) | Connections and tools |
| `INVALID_URL` | Not a valid address | The address is not a valid URL. Check it. | You (the owner) | Connections and tools |
| `SCHEME_NOT_ALLOWED` | Only https is allowed | The address must start with https://. | You (the owner) | Connections and tools |
| `USERINFO_NOT_ALLOWED` | A user name in the address | The address must not contain a user name or password. Put a token in the sign-in instead. | You (the owner) | Connections and tools |
| `QUERY_NOT_ALLOWED` | A query in the address | The address must not contain a query or a fragment. Put a token in the sign-in instead. | You (the owner) | Connections and tools |
| `PORT_NOT_ALLOWED` | That port is not allowed | The address uses a port this console does not connect to. | You (the owner) | Connections and tools |
| `PRIVATE_TARGET` | A private address | The address points at a private or internal network, which is not allowed. | You (the owner) | Connections and tools |
| `UNRESOLVABLE` | The address could not be found | The host name could not be resolved. Check the address, or try again later. | You (the owner) |  |
| `HOST_NOT_ALLOWED` | The host is not on the allowed list | Your administrator allows only some hosts, and this one is not among them. | Your administrator | Administration |
| `HOST_BLOCKED` | The host is blocked | Your administrator blocked this host. | Your administrator | Administration |
| `TIMEOUT` | Too slow | The check did not finish in time. Try again in a few minutes. | You (the owner) |  |
| `TOO_LARGE` | The answer was too large | The service answered with more than this console reads. Contact whoever runs the service. | You (the owner) |  |
| `NETWORK` | A network error | The connection to the service failed. Try again in a few minutes. | You (the owner) |  |
| `ABORTED` | Stopped | The check was stopped before it finished. Run it again. | You (the owner) |  |
| `DEADLINE_EXCEEDED` | Out of time | The whole check took longer than 20 seconds and the rest was not run. Try again in a few minutes. | You (the owner) |  |
| `SLOW` | Slow | The checks passed but took more than 5 seconds. The service may be busy; runs that use it may be slow. | You (the owner) |  |
| `MCP_OFF` | MCP servers are switched off here | Your administrator has not switched MCP servers on for this deployment (Administration, Connections). Nothing uses this server until they do. | Your administrator | Administration |
| `TLS_FAILED` | The secure connection failed | The server's certificate was not accepted (expired, self-signed or for another name). Fix the certificate or the address. | Your administrator | Administration |
| `NOT_AN_MCP_SERVER` | Not an MCP server | The address answered, but not as an MCP server (Streamable HTTP): it may be a web page or another kind of endpoint. Check the address in the server's documentation. | You (the owner) | Connections and tools |
| `REVISION_NOT_SPOKEN` | A protocol revision this console does not speak | The server speaks only a revision of the MCP protocol this console does not (it speaks 2025-03-26 and later, over Streamable HTTP). Check whether the server offers a newer endpoint. | You (the owner) | Connections and tools |
| `SECRET_MISSING` | The saved token is missing | The token or header value saved for this server is gone. Give it a new sign-in with the token. | You (the owner) | Connections and tools |
| `OAUTH_DISCOVERY_FAILED` | The server's sign-in service could not be used | The console no longer has, or the server no longer accepts, what it needs to renew the sign-in (the authorization server's details or its registered client). Sign in to the server again. | You (the owner) | Connections and tools |
| `TOOL_LIST_FAILED` | The server could not list its tools | The server answered, but not with its list of tools. Try again; if it keeps failing, contact whoever runs the server. | You (the owner) |  |
| `TOO_MANY_TOOLS` | More than 500 tools | The server offers more tools than the console keeps (500): the rest are not listed. Check whether the server can offer a smaller set. | You (the owner) |  |
| `TOOLS_CHANGED` | Its tools changed | The server's tools differ from the ones you reviewed (new, changed or removed). Use Refresh tools and review them: a changed tool stays off until you decide again. | You (the owner) | Connections and tools |
| `NO_TOOL_ENABLED` | No tool is switched on | Every tool of this server is off, so the agent is offered nothing from it. Open its tools and switch on the ones it may use. | You (the owner) | Connections and tools |
| `TOOLS_NOT_OFFERED` | Some switched-on tools cannot be offered | The parameters of some tools you switched on cannot be described to the model or checked, so runs are not offered them. Contact whoever runs the server, or switch them off. | You (the owner) | Connections and tools |
| `PROVIDER_OFF` | Switched off here | The administrator's switch for this provider is off: nobody can connect it until it is switched on in Administration, Connections. The app can still be tested. | Your administrator | Administration |
| `APP_CREDENTIALS_REFUSED` | The provider refused the app's client id or secret | The provider does not accept the deployment's client id or client secret (a wrong, deleted or expired secret, or an app that no longer exists). Create a new secret in the provider's console and save it in Administration, Connections. | Your administrator | The provider's own console |
| `ADMIN_CONSENT_REQUIRED` | An administrator has to approve the app | The account's organization requires an administrator to approve this app before anyone can use it. Send the approval link from the Connect dialog to your organization's administrator, then connect again. | You (the owner) | Connections and tools |
| `REFRESH_STALE` | Not renewed for a long time | The sign-in was last renewed more than 44 hours ago, although the daily job should keep it fresh. It may still work; if the console's jobs are not running, tell your administrator. | Your administrator | Administration |
| `CLOCK_SKEW` | The server's clock is off | The console's clock differs from the provider's by more than two minutes, and sign-ins fail when it drifts further. Set the server to synchronise its clock (NTP). | Your administrator |  |
| `MAILBOX_NOT_FOUND` | The account has no mailbox | This Microsoft account has no Exchange Online mailbox (it may be a OneDrive-only, on-premises or inactive account). Switch Mail off for it, or connect an account that has a mailbox. | You (the owner) | Connections and tools |
| `LICENSE_MISSING` | The account has no licence for this service | The account's organization has not assigned it a licence for this service (Exchange Online for mail, OneDrive for documents). Ask the organization's administrator to assign one, or switch the capability off. | You (the owner) | Connections and tools |
| `REDIRECT_NOT_HTTPS` | The redirect address is not https | The address the provider sends people back to must be https (http works only on this machine's own loopback address). Set the console's public address (APP_URL) to its https address and register that redirect address at the provider. | Your administrator | Administration |
| `APP_URL_MISMATCH` | The redirect address is not the one you are on | The redirect address the console sends is built from APP_URL, which differs from the address you reached the console on. Set APP_URL to the public address and register the same redirect address in the provider's console. | Your administrator | Administration |
| `TENANT_NOT_FOUND` | The Microsoft tenant does not exist | Microsoft does not know the tenant set for the app. Set the tenant in Administration, Connections to common, organizations, consumers or your directory (tenant) id from the Azure portal. | Your administrator | Administration |
| `NEEDS_A_SIGN_IN` | Can only be checked by connecting | The provider's answer does not tell whether the client id and secret are accepted. Connect a test account to check them. | Your administrator |  |
| `PICKER_KEY_MISSING` | The file picker has no API key | Owners cannot pick Google files in the picker until a browser API key is saved: in Google Cloud, APIs & Services, Credentials, create an API key restricted to the Google Picker API and this console's address, and save it in Administration, Connections. Files can still be used by their link. | Your administrator | Administration |
| `API_DISABLED_GMAIL` | The Gmail API is not enabled | In the Google Cloud project that owns the deployment's sign-in client: APIs & Services, Library, Gmail API, Enable. Then test again. | Your administrator | The provider's own console |
| `API_DISABLED_CALENDAR` | The Google Calendar API is not enabled | In the Google Cloud project that owns the deployment's sign-in client: APIs & Services, Library, Google Calendar API, Enable. Then test again. | Your administrator | The provider's own console |
| `API_DISABLED_DRIVE` | The Google Drive API is not enabled | In the Google Cloud project that owns the deployment's sign-in client: APIs & Services, Library, Google Drive API, Enable. Documents also need the Google Docs API and the Google Sheets API. Then test again. | Your administrator | The provider's own console |
| `API_DISABLED_DOCS` | The Google Docs API is not enabled | In the Google Cloud project that owns the deployment's sign-in client: APIs & Services, Library, Google Docs API, Enable. Then test again. | Your administrator | The provider's own console |
| `API_DISABLED_SHEETS` | The Google Sheets API is not enabled | In the Google Cloud project that owns the deployment's sign-in client: APIs & Services, Library, Google Sheets API, Enable. Then test again. | Your administrator | The provider's own console |
| `API_DISABLED_PEOPLE` | The People API is not enabled | In the Google Cloud project that owns the deployment's sign-in client: APIs & Services, Library, People API, Enable. Then test again. | Your administrator | The provider's own console |
| `SEARCH_OFF` | Web search is switched off | Your administrator switched web search off for this deployment; the agent searches in the browser instead. | Your administrator | Administration |
| `SEARCH_OFF_BY_YOU` | You switched web search off | Web search is off in your own settings; the agent searches in the browser instead. Switch it on to use it. | You (the owner) | Connections and tools, Web search |
| `SEARCH_PROVIDER_OFF` | This search provider is switched off | The administrator switched this search provider off. Another provider in the order may still answer. | Your administrator | Administration |
| `NOT_IN_ORDER` | Not in the provider order | This provider is not listed in the deployment's order, so searches never use it. Add it to the order in Administration → Web search. | Your administrator | Administration |
| `KEY_MISSING` | No key to search with | No key you may use is set for this provider. Add your own key in your Web search settings, or ask your administrator to share one. | You (the owner) | Connections and tools, Web search |
| `DEPLOYMENT_KEY_MISSING` | No deployment key | The deployment has no key for this provider. Set one in Administration → Web search, or leave it to each user's own key. | Your administrator | Administration |
| `DEPLOYMENT_KEY_NOT_SHARED` | The deployment key is not shared | The deployment's key works but users may not use it: each needs their own key. Switch on sharing in Administration → Web search if everyone should use it. | Your administrator | Administration |
| `USER_KEYS_NOT_ALLOWED` | Your own key is not allowed here | Your administrator does not allow users' own search keys on this deployment, so the key you saved is not used. | Your administrator | Administration |
| `SECRETS_PROVIDER_UNAVAILABLE` | The key could not be read | The place your key is kept (the credential store or your secrets provider) did not answer. Try again; if it keeps failing, check Settings → Secrets. | You (the owner) | Connections and tools, Web search |
| `MODEL_NOT_CHOSEN` | No model chosen | This search provider answers through AI and no model is chosen for it. Your administrator picks one in Administration → Web search. | Your administrator | Administration |
| `AI_OFF` | AI is off | This search provider answers through AI, and AI (or its OpenAI provider) is switched off. Your administrator switches it on in Administration → AI. | Your administrator | Administration |
| `HOSTED_TOOL_DISABLED` | Web search is off in the AI settings | The AI settings do not allow the provider-hosted web search. Your administrator switches on Web search under hosted tools in Administration → AI. | Your administrator | Administration |
| `AI_KEY_MISSING` | No OpenAI key | No OpenAI key you may use is set in the AI settings: add your own in your AI settings, or ask your administrator for the organization's or the deployment's. | You (the owner) |  |
| `AI_MODEL_NOT_REACHABLE` | The search model cannot be used | The model chosen for web search is not enabled, cannot be reached with the OpenAI key that would pay, or does not support web search. Your administrator picks another one in Administration → Web search, or enables it in Administration → AI. | Your administrator | Administration |
| `ADDRESS_MISSING` | No address set | This self-hosted search provider has no address. Your administrator sets it in Administration → Web search. | Your administrator | Administration |
| `SEARCH_PRIVATE_TARGET` | A private address | The provider's address points at a private or internal network, which the console does not call. Use a public address. | Your administrator | Administration |
| `SEARCH_KEY_REFUSED` | The provider refused the key | The search provider did not accept the key (wrong, revoked or for another plan). Replace the key where it is set. | You (the owner) | Connections and tools, Web search |
| `SEARCH_RATE_LIMITED` | The provider asked to slow down | The search provider is limiting requests for this key. Try again in a minute; frequent limits mean the plan is too small. | You (the owner) |  |
| `SEARCH_QUOTA_EXCEEDED` | The key's quota is used up | The plan of this key at the search provider has no searches left this period. It resets later, or raise the plan at the provider. | You (the owner) | The provider's own console |
| `SEARCH_UNAVAILABLE` | The search provider did not answer | The search provider answered with an error or not at all. Nothing was changed; try again in a few minutes. | You (the owner) |  |
| `FORMAT_DISABLED` | The JSON answer is switched off | The self-hosted search server does not answer in JSON. Enable the json format in its settings (search.formats). | Your administrator | Administration |
| `NO_RESULTS` | No results | The test search answered but found nothing for a common word. The provider may be misconfigured; searches may come back empty. | Your administrator | Administration |
| `LIMIT_REACHED` | Today's limit is reached | You used today's web search limit; the test search was not sent. It resets at midnight UTC, or your administrator raises it. | You (the owner) |  |
| `LIMIT_NEAR` | Today's limit is nearly reached | More than 80% of today's web search limit is used. It resets at midnight UTC, or your administrator raises it. | You (the owner) |  |
| `FETCH_OFF` | Reading pages is switched off | The agent cannot read pages on the server (web_fetch is off); it opens them in the browser instead. Your administrator switches it on in Administration → Web search. | Your administrator | Administration |
| `BLOCKED` | The page is blocked | The console's rules refused to read the test page (a blocked host or a private address). Check the blocked hosts in Administration → Web search. | Your administrator | Administration |
| `FETCH_UNAVAILABLE` | The test page could not be read | The console could not read a well-known public page from the server. The server may have no internet access, or a proxy blocks it. | Your administrator | Administration |
| `UNKNOWN` | Failed | Something failed that the console has no words for. Try again; if it keeps failing, tell your administrator. | You (the owner) |  |

<!-- diagnostics-codes:end -->

## The CLI

From E50.15 (#985). The CLI prints the same codes and remedies as the panel; exit code 0 for pass or warn, 1 for a failure, 2 when the command could not run.

| Command | What it does |
|---|---|
| `hexactra search status` | on or off and why, the provider and the tier of its key, today's count and limit |
| `hexactra search on` / `off` | your own switch |
| `hexactra search providers` | the providers installed here and whether you can use each |
| `hexactra search test [--provider <id>]` | your diagnostic report; an administrator adds `--deployment --provider <id>` to test the deployment's key |
| `hexactra search query "<text>"` | one search (counted against your day), numbered titles, addresses and excerpts |
| `hexactra search keys` | which tiers hold a search key and which one you use; never a key |
| `hexactra search key set <provider>` | stores a key typed at a hidden prompt or read with `--stdin` (`--deployment`, `--org` pick the tier); **a key given as an argument is refused**, because it would stay in your shell history |
| `hexactra search key rm <provider>` | removes a key |
| `hexactra search admin show` / `set <field> <value>` / `usage` | the administrator's settings and the usage with the estimated cost |
| `hexactra connections diagnose <connection>` | a connection's report (`--json` for the API's report, with no label unless `--include-names`) |
| `hexactra connections diagnostics <connection>` | its last reports |
| `hexactra connections try <connection> <tool>` | one call of an MCP server's Read tool |
| `hexactra connections app-test google\|microsoft` | the administrator's test of the deployment's app |
| `hexactra tasks show <task>` | one line of what its runs can use (no per-task flag exists) |

There is no MCP tool for web search or diagnostics: a hosted assistant has its own web search, and a diagnostic describes the owner's accounts ([parity.md](parity.md#what-web-search-and-diagnostics-added-e50)).

## Providers

| Id | Provider | Kind | Credential | Hosts | Default estimate per call |
|---|---|---|---|---|---|
| `brave` | Brave Search | results | API key (`web_search.brave`) | `api.search.brave.com` | USD 0.005 |
| `tavily` | Tavily | results | API key (`web_search.tavily`) | `api.tavily.com` | USD 0.008 |
| `exa` | Exa | results | API key (`web_search.exa`) | `api.exa.ai` | USD 0.01 |
| `searxng` | SearXNG (self-hosted) | results | none: an address (`webSearch.providers.searxng.baseUrl`) | the configured host | 0 |
| `openai` | OpenAI web search | answer | the AI settings' OpenAI key (`ai_service`): no search key | `api.openai.com`, through the AI service | USD 0.01 (the search fee only) |

Endpoints, parameters, the fields mapped and the limit signals of each are in the [decision record's provider table](decisions/web-search.md#provider-table). An estimate is a default the administrator overrides; it is never shown as a price.

**Which provider answers.** `webSearch.order` lists the providers in the order they are tried (default `['brave']`). A provider is tried only when it is in the order, switched on (`webSearch.providers.<id>.enabled`) and usable for the caller (a key at an allowed tier, or an address). A user's preferred provider (`webSearch.provider` in their settings) goes first for that user. After `AUTH_REFUSED`, `QUOTA_EXCEEDED` or `UNAVAILABLE` the next usable provider is tried once. A provider is never chosen by a model, a page or a search result: only by settings.

**SearXNG.** Set its address in Administration → Web search (`https://search.example.org`, a path prefix such as `/searx` is kept) and put `searxng` in the order. The instance must answer JSON: add `json` to `search.formats` in its `settings.yml`; otherwise it answers 403, a search moves on to the next provider and Test reports `FORMAT_DISABLED`. An instance on your own network needs the tick "this instance is on my private network" (`allowPrivate`): see [A self-hosted provider on a private network](#a-self-hosted-provider-on-a-private-network).

**OpenAI web search (E50.9, #979).** An answer-type provider: it writes an answer from a web search and cites the pages; the cited pages become the hits (title, address, the cited sentence as the snippet, no date) and their addresses `answer.citations`. It calls `AiService.forUser(<you>, { feature: 'web_search' })` with the hosted `web_search` tool, a fixed instruction ("Answer the question from a web search. Cite the pages."), a small output cap (800 tokens) and the model the administrator chose. No key is handled by web search: the AI service resolves your OpenAI key at its tiers (your own, your organization's, the deployment's, under the AI policy). It is usable when all of these hold, each a code of its diagnostic report's `credential` stage:

- a model is chosen in Administration → Web search (`webSearch.providers.openai.model`, a model id of the AI catalogue; there is no default) — else `MODEL_NOT_CHOSEN`;
- AI and its OpenAI provider are on — else `AI_OFF`;
- the administrator switched on Web search under the hosted tools in Administration → AI (`ai.hostedTools.web_search`, off by default) — else `HOSTED_TOOL_DISABLED`;
- an OpenAI key you may use reaches that model, with responses and hosted tools — else `AI_KEY_MISSING` or `AI_MODEL_NOT_REACHABLE`.

Its `network` stage is skipped (the AI service holds the connection; the live query proves the path). The model is not a run's tier model: a web search call is not a `browser_agent` call, so the agent policy's tiers do not apply to it (console AGENTS.md, "Agent run policies", rule 1).

**Answers and allowed sites.** An answer is written from pages the console never sees, so it cannot be filtered against a task's allowed sites. When a run has allowed sites, an answer-type provider is skipped for every search of that run and the next usable result-type provider answers (its hits are filtered as always). If none is usable the search answers "Web search is not available right now" for that call; the tool stays offered. Without allowed sites, the answer is shown to the model as third-party text inside the same wrapper as hits: a model wrote it from pages nobody here read.

**The hosted search is used only by this provider.** It is never attached to the agent's own model calls, where it would run inside the model provider and skip `executeTool`, Stop, the gates and the step record. `apps/api/test/architecture/hosted-web-search.spec.ts` fails when `web_search` appears as a hosted tool type outside `apps/api/src/web-search/`.

### The cost of an answer-type provider

A search through a result-type provider costs its fee per call. An answer-type provider costs two parts, each counted once:

- **The search fee**, per search: in `web_search_usage` with the other providers (Administration → Web search, Usage). An answer that reports several searches (OpenAI's `hosted_tool_call` items of type `web_search`) counts each one: for the fee, for the per-day limit and for the run's limit. `estimatedCostPerCallUsd` is the fee only.
- **The tokens** of the pages the model read and of its answer: only in the AI usage ledger, under the feature **Web search** (Administration → AI → Usage), priced like every other AI call. The web search usage never adds them.

### A second answer-type provider (finding, E50.9)

Checked, not built. A second answer-type provider is one adapter file plus its contract spec (`kind: 'answer'`), with no change to the service, the tools or the web app:

- **Perplexity (Sonar)** and **xAI (Grok with live search)** speak an OpenAI-compatible chat API. The platform's AI service can reach an OpenAI-compatible endpoint (its `openai_compatible` provider slot), but it carries only the hosted tool types it models (`web_search` is OpenAI's Responses tool) and the citations it maps from OpenAI's annotations. Perplexity's search runs on every call without a tool, and its citations come back in a top-level `citations` / `search_results` field; xAI's search options are a `search_parameters` body field. The AI service's `providerOptions` escape hatch passes provider body fields, but the response's citation fields are not mapped into `AiMessageOutputItem.citations`, so the adapter would get the answer without its sources.
- **So:** through the AI service, either needs a platform seam (map the provider's citation fields into `citations`, and let a provider declare that search is built in) — an EnterpriseAppBase seam request when one is wanted. Without it, the adapter is a keyed one over `OutboundHttp` (`credential: 'api_key'`, the provider kit, the same contract spec), with its own key under `web_search.<id>` and no AI usage ledger row (its fee and tokens are one price, the estimate per call).
- **Not re-read:** the Perplexity and xAI API references were not fetched from this session (outside its network); the shapes above are as the author knew them on 2026-11-27.


## How to add a search provider

A provider is one file plus its tests. Follow this list; the service, the tools and the web app do not change.

1. **The adapter:** `apps/api/src/web-search/providers/<id>.provider.ts`, an `@Injectable()` implementing `SearchProvider` (`search-provider.ts`) that calls `this.registry.register(this)` from `onModuleInit`. The id is permanent (lower case: it names the stored key, the settings, the usage rows and a metric label). Use `providers/provider-kit.ts`: `sendProviderRequest` (one request through `OutboundHttp`, Stop → `ABORTED`, transport → `UNAVAILABLE`), `hitOf`/`hitsOf` (web addresses only, cleaned and capped), `siteOperand`, `clampCount`, `statusFailure` and `rateLimited`. Throw nothing but `WebToolError`; read a provider's body for a code at most, never copy it. Ask for the cheaper plain search and no page text.
2. **The credential reference:** `credential: 'api_key'` registers `{ service: 'web_search', name: '<id>' }` with every tier for you; send the key in its documented header only, read inside `auth.key.expose(...)`. `'none'` for a provider with an address (its settings `baseUrl` and `allowPrivate`); `'ai_service'` for one that calls the AI service (E50.9).
3. **The cost:** `estimatedCostPerCallUsd` from the published price, with the date, in a comment.
4. **The fake endpoint:** `apps/api/src/web-search/testing/fake-<id>.ts`, extending `FakeJsonEndpoint`: the documented request checked, the documented answer with invented data (`*.example.test`), an unknown key refused as the provider refuses it.
5. **The contract spec:** `apps/api/test/search-provider-<id>.spec.ts` calling `searchProviderContract(...)` with `httpContractHarness` (the key's header, the hosts, how results and the quota signal look, how `site` and `freshness` appear in the request), plus the provider's own request details.
6. **The egress hosts:** `hosts` lists every host it calls (a self-hosted provider lists none: the egress entry names the configured host).
7. **The diagnostic stages:** `diagnose` built with `providerStages` (`web-search-diagnostics.ts`): `network` with `probeHost` on its root, `live_query` with `DIAGNOSTIC_QUERY` and `count: 1`. A code of its own goes in `diagnosticCodes` with an entry in `packages/shared/diagnostics.json`.
8. **Register it:** add the class to `providers` in `web-search.module.ts`.
9. **The docs:** a row in the [decision record's provider table](decisions/web-search.md#provider-table) (dated, with whether the reference was re-read) and in the table above.
10. **An answer-type provider** (`kind: 'answer'`): map the answer to `answer.text` (cleaned, capped at 4,000) and the cited pages to `hits` and `answer.citations`; return `searches` when the provider says how many it made. Through the AI service, use `credential: 'ai_service'`, implement `diagnoseCredential` (the service offers the provider only while it passes) and run the contract with `kind: 'answer', probe: false` against `test/support/fake-ai-search.ts`. Never attach a hosted tool anywhere else.
11. **Nothing else:** the admin card and the user's provider list read `GET /api/web-search/providers` and `GET /api/web-search/admin` (`label`, `kind`, `credential`, hosts, estimate), so the new provider appears with no web change.

SearXNG (E50.8, #978) was added this way, with the private-network tick (`allowPrivate`: the setting, `ProviderAuth`, and `allowInsecureHttp` on `OutboundHttp`) as its only change outside its own files; the tools did not change.

## A self-hosted provider on a private network

SearXNG on your own network needs the administrator's tick **This instance is on my private network** (`allowPrivate`, off by default), which allows a private address and `http` for that one configured host only. What it allows and does not, and the residual risk: [the threat model, row 8](security-web-search.md#8-a-self-hosted-searxng-on-a-private-address).

## What is not offered

On purpose, or not yet:

- **A per-task or per-chat choice** of web search: what is switched on is always available (E50.17). Use allowed sites to bind where it goes.
- **Reading a page that needs a sign-in, scripts, a cookie or a residential address** with `web_fetch`: the browser on the node does that.
- **Page extraction by the provider** (Tavily extract, Exa page text, Firecrawl): `web_fetch` reads pages; a follow-up ([#1035](https://github.com/marinoscar/hexactra/issues/1035)).
- **More answer-type providers** (Perplexity, xAI): checked, not built ([A second answer-type provider](#a-second-answer-type-provider-finding-e509)); a follow-up ([#1038](https://github.com/marinoscar/hexactra/issues/1038)).
- **Image, news or video search**, and a provider-hosted search attached to the agent's own model calls (never: it would skip `executeTool`, Stop and the gates).
- **A TUI screen** for web search and diagnostics: the CLI commands exist, the terminal UI has no screen yet ([#1037](https://github.com/marinoscar/hexactra/issues/1037)).
- **An MCP tool** for web search or diagnostics on Hexactra's own MCP server ([parity.md](parity.md)).
- **A price as a fact**: every cost is an estimate the administrator can correct.

## What has not been verified

Everything below is implemented and tested against fakes only. The owner's checklist to settle it on a deployed stack is [acceptance-web-search.md](acceptance-web-search.md); every line of it is **Not run** as of 2026-11-27.

- **No real search with any provider.** Brave, Tavily, Exa, a SearXNG instance and OpenAI web search are tested against in-process fakes built from their documented request and answer shapes. The providers' references were not re-read from the sessions that built them (outside their network): an endpoint, a header, a field or a quota signal may differ in detail.
- **Every price and free allowance** on this page and in the decision record is from documentation as known on 2026-11-26/27, not re-checked.
- **The benchmark against searching in the browser is not run** (no node, AI key or search key in the session; [decision record, Benchmark](decisions/web-search.md#benchmark-web-search-against-searching-in-the-browser-e5016)). So **no claim is made that web search is cheaper or faster than the browser**: that is what the benchmark is for (building and running it: [#1040](https://github.com/marinoscar/hexactra/issues/1040)). (The agent's own instructions still say a web search is faster than opening a search engine in the browser; that sentence is part of the prompt and is to be kept or changed with the benchmark's numbers.)
- **`web_fetch` on real sites**: the extraction, the bot-check markers and PDF reading are tested on fixtures, not on real pages behind real bot protection.
- **A key in a real Vault** (E50.3): tested against the fake Vault (contract 1.4) and the built-in store in process.
- **The diagnostics panel and the Web search section at a real 390 px phone**: checked with the screen script and component tests, not on a device.
- **The OpenAI web search call itself**: tested against the platform's AI runtime harness with a scripted provider; the five-question comparison with Brave of E50.9 is not run.
