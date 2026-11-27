# Threat model: web search, page reading and diagnostics

Epic E50 (#970). The agent can search the public web (`web_search`) and read public pages from the console server (`web_fetch`) in every run and chat while web search is set up and switched on ([web-search.md](web-search.md)); keys of outside services are kept in tiers ([secrets.md](secrets.md#keys-of-outside-services)); every connection and search provider has a staged diagnostic report ([connections.md](connections.md#diagnostics-e5010)). This page says, for each misuse, **what stops it, what does not, and which test proves the claim**. It follows the model of [security-connections.md](security-connections.md); the threats of connected accounts and MCP servers in general are there, of saved secrets in [security-secrets.md](security-secrets.md).

**How to read the "Tested by" lines.** Each names a test file and the title (or the start of the title) of a test in it. Every one of those tests runs against **fakes**: in-process fakes of each provider's documented API (`apps/api/src/web-search/testing/`), a fake web with a scripted DNS (`fake-web.ts`), a scripted AI provider, a fake MCP server, the fake Vault. **No real provider, page, Vault or MCP server was used.** A test proves the console's own rules; it does not prove a provider behaves as its fake does. "By design" means a property of the code's structure with no test that would fail if it changed. "Not verified" is for the owner's acceptance run ([acceptance-web-search.md](acceptance-web-search.md)).

## What is at stake

- **The owner's data**: what the agent knows in a run (the goal, task values, mail it read through a connection, page text) could leave in a search query or a page address.
- **The keys**: a search provider's key at each tier (the owner's, the organization's, the deployment's), the AI key an answer-type provider uses.
- **The console's network position**: `web_fetch` and SearXNG requests leave from the console server, which can reach addresses the public cannot (cloud metadata, the private network).
- **Money**: each search costs a fee; an answer-type search also costs AI tokens.
- **The record**: the steps, the usage table, the diagnostic reports, Doctor.

## Who can attack, and what they hold

| Actor | Holds | Wants |
|---|---|---|
| A malicious web page or search result | Text in front of the model (an excerpt, a page read by `web_fetch`, an answer) | To make the agent act on it, or carry the owner's data out |
| A hostile search provider, or one that was compromised | The answers to every search, and the queries | To inject text, oversized or hostile content; to read queries |
| A hostile MCP server | Its tools' descriptions and results, and the arguments of Try a tool | To steer the agent or the owner through Try or a preset |
| Another user of the same deployment | Their own account | The deployment's key the administrator did not share; another user's key or report |
| A hosted AI app | An OAuth token confined to `/api/mcp` | To search or diagnose on the owner's behalf, or read a key |
| The administrator, by mistake | The settings | (Not an attacker: an address on the private network, an estimate wrong) |

## The threats, one by one

### 1. A search result or a page tells the agent to do something (prompt injection)

**What stops it.** A hit, an answer and a page are wrapped as third-party data (the wrapper of MCP results) and cleaned of markup, control and invisible characters; the instructions say what a search or a page says is never an instruction. Nothing in a result can change the tools offered, a gate, the run's allowed sites, its approvals, recipients, connections or secrets: those are read from the run's own settings by the server. Every tool the agent runs after it (a send, a change, a payment click) goes through `executeTool`, the gates and, for a commit, the owner's card.

**Tested by.**
- `packages/hexactra-web-agent/test/web-search.spec.ts`: "a hit that says "ignore your rules" changes neither the offered tools nor a gate"; "returns numbered hits inside the third-party wrapper, …".
- `apps/api/test/scenarios/routing/web-injection.scenario.json` ("a search hit and a page tell the agent to send the owner's files") and `web-injection-answer.scenario.json` (the same from an answer-type provider's written answer), run by `npm run scenarios --workspace=api`.

**What does not stop it.** The model reading the text at all: like any page in the browser, a result can mislead what the agent believes (a wrong fact). Remedies: allowed sites on tasks that matter, Stop, the step record ("Searched the web for …", "Read <host>").

### 2. The agent is led to put the owner's data in a query or an address (data leaving through search or fetch)

**What stops it.** A query or an address that matches the sensitive patterns (a card number, a code, a token shape) is refused with a fixed sentence and stored masked; nothing is sent. `web_fetch` refuses an address that holds secret material, and an address outside the run's allowed sites at any hop. Each query is recorded in the step (masked), so the owner sees what left. The per-run and per-day limits bound how much can leave.

**Tested by.**
- `packages/hexactra-web-agent/test/web-search.spec.ts`: "refuses a query that matches a sensitive pattern, with a fixed sentence, and stores it masked"; "narrows the search to the one allowed host and drops hits outside the list, saying how many"; "refuses a search narrowed to a site outside the list, …".
- `packages/hexactra-web-agent/test/web-fetch.spec.ts`: "refuses http, a non-web address and an address that holds secret material, and sends nothing"; "refuses an address outside the allowed sites with the browser site gate…".
- `apps/api/test/web-fetch.spec.ts`: "a redirect that leaves the run's allowed sites is NOT_ALLOWED, and nothing is sent to it".

**The residual risk, plainly.** A pattern list is best effort. **The agent can still carry ordinary words out** (a name, an address, a sentence from a mail it read) in a search query or a page address, to the search provider and to whatever site it reads, exactly as it can by typing them into a page in the browser. This is the browser's residual risk, not a new one; it is not removed by a restriction that would only limit the agent. The limits that exist: the sensitive patterns, the allowed sites at every hop, the per-run and per-day counts, the step that records every query and page, Stop, and the owner's switch (web search off, or page reading off).

### 3. The fetch is aimed at a private address, cloud metadata, or redirected there (SSRF, rebinding)

**What stops it.** Every hop of `web_fetch` (the first and each redirect, at most five, followed by the console itself) is refused before a byte is sent when it is not `https`, carries a user name or password, uses a port other than 443 or 8443, names `localhost`, `*.local`, `*.internal` or a single-label host, is a non-public literal address, or matches the blocked hosts. `OutboundHttp` then checks **every** address the name resolves to and pins the connection to the checked address, so a second lookup cannot rebind it. These checks hold in every environment; the development conveniences never apply to `web_fetch`. A search provider is called the same way (only its declared hosts; SearXNG is row 8).

**Tested by.** `apps/api/test/web-fetch.spec.ts`, "SSRF: refused before a byte is sent to the target": "a public name that resolves to a private, loopback or metadata address (and a redirect to it)"; "a name with one public and one private answer is refused (every address is checked)"; "rebinding: public on the first lookup, private on the second; …"; "a URL with a user name or password, a non-standard port, plain http"; "the production transport refuses a private target too, with the development conveniences on"; and "follows up to 5 redirects itself, relative ones included, and refuses a sixth". For providers: `apps/api/test/support/search-provider-contract.ts`, "the key is in exactly one header of each search and nowhere else; every request went to a declared host" (run by every `search-provider-*.spec.ts`).

**What does not stop it.** A public site the agent may read, read from the console's address: `web_fetch` is a public reader from a datacenter, by design.

### 4. A key leaks through a response, a log, a span, a step, an export, a diagnostic report or the CLI

**What stops it.** Keys are service credentials, write-only, resolved on the server at the moment of each request and put only in the one header the provider documents. No route returns a key or any part of it; audit rows name the reference and tier; the span records the provider id, the hit count, the kind and the outcome, never the query or a key; a provider's own error text is never copied; a diagnostic report holds codes, counts and timings only; the CLI refuses a key given as an argument (it would stay in the shell history) and never prints one.

**Tested by.**
- `apps/api/test/web-search.db.spec.ts`, "the marker scan": "no key in a response, an audit row, a log line or a usage row".
- `apps/api/test/web-search-diagnostics.db.spec.ts`, "the marker scan": "no key in a response or a stored report".
- `apps/api/test/web-search-providers.db.spec.ts`, "the marker scan": "no key in a response, a usage row or a fake request log".
- `apps/api/test/service-credentials.db.spec.ts`: "no response, audit row, log line or stored row holds a seeded value; …"; "a personal access token can set and list its owner's key but never read a value: there is no read route".
- `apps/api/test/support/search-provider-contract.ts`: "turns every failure into a closed code that carries no provider text, query or key".
- `apps/api/test/web-search-openai.db.spec.ts`: "never answers with the AI key".
- `packages/hexactra-web-agent/test/web-search.spec.ts`: "never copies an error's own text: an unknown error is UNAVAILABLE"; `web-fetch.spec.ts`: "names the kind and the outcome of the call, never the address".
- `apps/web/src/__tests__/WebSearch.test.tsx`: "a saved key is said in words with its date, never shown; …"; `DiagnosticsPanel.test.tsx`: "copies codes and statuses with the version, never a label, an address or a host unless asked".
- `apps/cli/src/web-search.test.ts` (E50.15, #985): "refuses a key passed as an argument, and sends nothing"; "reads the key from a hidden prompt, stores your own key, and never prints it".

**What does not stop it.** The key crosses the console's Node process for each call (the console makes the call). A compromised console or a compromised provider holds it ([security-secrets.md](security-secrets.md)).

### 5. A user uses the deployment's key when the administrator did not share it; a user reads another user's key or report

**What stops it.** The tiers are resolved by the server: the deployment's key is used only while `shareDeploymentKey` is on, a user's own key only while `allowUserKeys` is on; a user is told only that they need a key, never that an unshared one exists. A key is only ever resolved for the caller's own user and organization. A diagnostic report and its history belong to their owner; another user gets a 404. The deployment's report is an administrator's (`system_settings:write`) and uses the deployment's key only.

**Tested by.**
- `apps/api/test/web-search.spec.ts`: "the deployment key is used only while shared; user keys only while allowed"; "allows the system tier only when shared and the user tier only when allowed".
- `apps/api/test/web-search.db.spec.ts`: "the deployment's key is used only while the administrator shares it"; "a viewer reads the status but cannot search; a contributor cannot reach the admin routes".
- `apps/api/test/web-search-diagnostics.db.spec.ts`: "the deployment's report uses the deployment key only, stored with no owner; a user is never told about an unshared key"; "a viewer reads their reports but cannot run one; a contributor cannot reach the deployment routes; …".
- `apps/api/test/service-credentials.db.spec.ts`: "each role: own key for contributors and admins; the deployment key for administrators; …"; "a hosted AI app's OAuth token reaches none of the routes".
- `apps/api/test/connection-diagnostics.db.spec.ts`: "another user's connection is a 404 on every route, and an unauthenticated caller is refused".

### 6. A provider returns hostile markup or oversized content

**What stops it.** Every hit is cleaned (markup, control and invisible characters removed), kept only with an `http` or `https` address, and capped (title 200, excerpt 400, address 2,000; an answer 4,000; the whole result 12,000 characters); a provider's answer is read up to a size cap. A page read by `web_fetch` is parsed into a tree that is only read (no script runs, no sub-resource is fetched), its scripts, styles, forms and hidden parts dropped, read up to 5 MB and cut at the run's character limit; a PDF is read in a worker with a memory limit.

**Tested by.**
- `apps/api/test/support/search-provider-contract.ts`: "maps a success to cleaned, capped hits with web addresses only, at most `count`" (every provider).
- `packages/hexactra-web-agent/test/web-search.spec.ts`: "cleans titles and excerpts (markup, control and invisible characters) and drops hits that are not web addresses"; "caps a title at 200, an excerpt at 400, the answer at 4,000 and the whole result at 12,000 characters".
- `apps/api/test/web-fetch.spec.ts`: "reads the main content: …, scripts, styles, navigation, forms and hidden elements dropped"; "cuts the text at maxChars and says so"; "gives each error code" (`TOO_LARGE` over 5 MB); "Stop ends the PDF worker at once".

### 7. An MCP server abuses Try a tool or a preset

**What stops it.** Try calls **one Read tool** the owner switched on, exactly as a run would: the stored tool unchanged since the owner decided, the arguments validated against its schema, credentials redacted, the result cleaned, capped, shown as third-party text and not stored; never a Write tool; 6 a minute per connection; another user gets a 404. A preset only fills the Add form: it is a reviewed file, carries no secret and no tool mode, the server is tested before anything is kept and every tool starts off; a preset on a blocked host is not offered.

**Tested by.**
- `apps/api/test/mcp-diagnostics.db.spec.ts`, "Try a tool": "calls a read tool exactly as a run would: validated, redacted, capped, audited without values, not stored"; "is limited to 6 a minute per connection, and another user gets a 404"; "presets": "lists the reviewed presets, leaves out a blocked host, and is empty while MCP servers are off".
- `apps/api/test/mcp-diagnostics.spec.ts`, "the presets file": "is well formed: https addresses …"; "never carries a secret or a tool mode".
- `apps/cli/src/connections-diagnose.test.ts` (E50.15): "refuses a Write tool and a non-MCP connection without calling the tool, …".

### 8. A self-hosted SearXNG on a private address

**What stops it.** By default a SearXNG address must be `https` and public, checked when saved and on every request. The scoped exception, **This instance is on my private network** (`allowPrivate`), is set only by an administrator, is off by default, and allows a private address and `http` **for the one configured host only** (`allowedHosts: [<that host>]`): no redirect is followed, no other host is allowed, a page a search result names is never read under it (`web_fetch` never takes the exemption), and no user name, password, query or fragment may be in the address. The egress list (Doctor) names the host with "private network allowed for its configured host".

**Tested by.**
- `apps/api/test/search-provider-searxng.spec.ts`: "a private address: refused without the tick; with it, accepted for the configured host only"; "http: refused without the tick, accepted with it; a private literal address likewise"; "the cloud metadata address is refused without the tick".
- `apps/api/test/web-search-providers.db.spec.ts`: "its address: a private http address is refused without the tick and saved with it; then searches go to that host".
- `apps/api/test/web-search.spec.ts`: "a self-hosted provider's address and its private-network tick (E50.8): off by default, kept per field".

**Residual risk.** An administrator who points the address at another internal service lets the console send GET requests with search words to it and read its JSON back as search results (cleaned, capped and marked as third-party data). That is the administrator's decision about their own network.

### 9. An answer-type provider's answer is treated as trusted

**What stops it.** An answer (OpenAI web search) is shown to the model inside the same third-party wrapper as hits, with its cited pages as hits: a model wrote it from pages nobody here read. Because the console cannot filter an answer against allowed sites, an answer-type provider is **skipped** for every search of a run with allowed sites. The provider-hosted search is used only by this provider and is never attached to the agent's own model calls, where it would skip `executeTool`, Stop and the gates.

**Tested by.**
- `apps/api/test/web-search-answer.spec.ts`: "with allowed sites the answer-type provider is skipped for the call and a result-type provider answers"; "with allowed sites and no result-type provider usable: UNAVAILABLE for that call, nothing sent or counted".
- `packages/hexactra-web-agent/test/web-search.spec.ts`: "shows an answer-type result: the answer first, then its citations as hits".
- `apps/api/test/architecture/hosted-web-search.spec.ts`: "holds in every source file of the API and the agent packages"; "fires on a model call of the runner or a package that attaches it, …".
- `apps/api/test/scenarios/routing/web-injection-answer.scenario.json`.

### 10. A diagnostic used to probe an account or to change something

**What stops it.** A diagnostic makes **read calls only** and stores codes, counts and timings: never content, a provider's message, an address or a token (a zod schema drops any value that looks like an email address, a token, a URL path or query, or prose). It changes nothing a test would not change; an MCP diagnostic stores nothing in the server's tool list; Doctor reads stored state only. Only the owner runs or reads a connection's report, at most 6 a minute per target; the web search Test sends one fixed common word, never a query a person typed.

**Tested by.**
- `apps/api/test/diagnostics.spec.ts`: "refuses a value that looks like an email address, a token, a URL, a path, a query or prose"; "sanitizes stages: drops every refused value, closes the code, …"; "keeps a code from the closed list and replaces anything else with UNKNOWN".
- `apps/api/test/mcp-diagnostics.db.spec.ts`: "tool_changes: TOOLS_CHANGED with counts, and the diagnostic stores NOTHING in connection_mcp_tools".
- `apps/api/test/web-search-diagnostics.db.spec.ts`: "the six checks are registered and read stored state only: no outbound request, no row written"; "at most 6 reports a minute for one provider".
- `apps/api/test/web-search-diagnostics.spec.ts`: "every stage in order, passing; the live query is the fixed word, counted as one call; …".
- `apps/api/test/connection-diagnostics.db.spec.ts`: "at most 6 a minute per connection"; "no response and no stored report holds a token, an account email, the app secret, the bearer token or a mail subject".

**What does not stop it.** A diagnostic is a real sign-in and a real read at the provider, so it appears in the provider's own logs, and the web search Test costs one search.

### 11. Cost: a loop of searches

**What stops it.** Searches per run (30), per user per day (300, UTC) and pages per run (30), each a setting; the agent policy's `maxWebCalls` (Economy 10, Balanced 30, Thorough 100); at most 10 searches a minute from Try a search, Test and the CLI. Reaching a limit answers a fixed sentence and **does not stop the run**: the agent goes on with the browser. Each search an answer-type provider reports is counted (fee, day, run). The run's AI budget still bounds the model calls that would make searches.

**Tested by.**
- `apps/api/test/web-search.spec.ts`: "the per-day limit reached gives LIMIT_REACHED before any call"; "the per-run limit counts the calls of one port".
- `apps/api/test/web-availability.spec.ts`: "counts searches and reads together, from the earlier jobs: over the budget, LIMIT_REACHED and no call"; "reaching the budget does not stop the run: the tool answers its sentence".
- `apps/api/test/web-search.db.spec.ts`: "the route allows 10 searches a minute".
- `apps/api/test/web-search-answer.spec.ts`: "each search an answer reports counts: the per-day count, the fee (per search) and the per-run limit; …".
- `apps/api/test/scenarios/routing/web-budget.scenario.json` ("the web call budget refuses a call and the run goes on").

**What does not stop it.** An estimate that is wrong: the console estimates, never bills. The provider's own dashboard is the truth.

### 12. Stop, and the switches that must hold

**What stops it.** Stop cuts a search or a page read in flight (also a DNS lookup that never answers); nothing reaches the provider after it. With web search switched off at any level, nothing is registered and a run is byte-identical to how it ran before the epic. Nothing but the owner's and the administrator's switches decides availability.

**Tested by.**
- `apps/api/test/web-availability.spec.ts`: "a Stop pressed while a search is in flight cancels it, and nothing reaches the provider after it"; "has no other input: a task, a chat, allowed sites or a model cannot turn it on or off".
- `apps/api/test/web-fetch.spec.ts`: "Stop cancels a slow read within one second: ABORTED, not counted"; "Stop during a lookup that never answers still ends the call at once".
- `packages/hexactra-web-agent/test/web-search.spec.ts`: "Stop before the call: executeTool returns before the port is called and nothing is recorded".
- `apps/api/test/runner-characterisation.db.spec.ts`: the four earlier fixtures unchanged with web search off; "pins a run with web search on: …".
- `apps/api/test/tools-always-available.db.spec.ts`: "the deployment or the user switch off removes web_search from the next run, and on brings it back"; "a switch flipped mid-run does not change what that run is offered: the snapshot decides, and the service refuses the call".

## The residual risk, in plain words

Web search adds a way out for words the agent holds: whatever it puts in a query goes to the search provider, and whatever it puts in an address goes to that site. The patterns stop the shapes of secrets, not the meaning of ordinary text. A page or a result can mislead the agent about a fact. These are the browser's risks, from the console's address instead of the node's; they are bounded by allowed sites, the limits, the step record, Stop and the owner's switch, and not removed.

## Not covered here

The general threats of connected accounts, MCP servers and deliveries ([security-connections.md](security-connections.md)), saved secrets and the Vault ([security-secrets.md](security-secrets.md)), hosted AI apps ([security-hosted-clients.md](security-hosted-clients.md)), and a compromised console, node or administrator (as in those pages).
