# Web search

The agent's `web_search` tool asks a search provider for results through the console server, with a key the owner, their organisation or the deployment set (Administration → Web search). The design is in the [decision record](decisions/web-search.md); this page covers the providers and how to add one. (The owner guide and the full threat model of web search are E50.16, #986.)

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

**SearXNG.** Set its address in Administration → Web search (`https://search.example.org`, a path prefix such as `/searx` is kept) and put `searxng` in the order. The instance must answer JSON: add `json` to `search.formats` in its `settings.yml`; otherwise it answers 403, a search moves on to the next provider and Test reports `FORMAT_DISABLED`. An instance on your own network needs the tick "this instance is on my private network" (`allowPrivate`): see the threat model below.

**OpenAI web search (E50.9, #979).** An answer-type provider: it writes an answer from a web search and cites the pages; the cited pages become the hits (title, address, the cited sentence as the snippet, no date) and their addresses `answer.citations`. It calls `AiService.forUser(<you>, { feature: 'web_search' })` with the hosted `web_search` tool, a fixed instruction ("Answer the question from a web search. Cite the pages."), a small output cap (800 tokens) and the model the administrator chose. No key is handled by web search: the AI service resolves your OpenAI key at its tiers (your own, your organization's, the deployment's, under the AI policy). It is usable when all of these hold, each a code of its diagnostic report's `credential` stage:

- a model is chosen in Administration → Web search (`webSearch.providers.openai.model`, a model id of the AI catalogue; there is no default) — else `MODEL_NOT_CHOSEN`;
- AI and its OpenAI provider are on — else `AI_OFF`;
- the administrator switched on Web search under the hosted tools in Administration → AI (`ai.hostedTools.web_search`, off by default) — else `HOSTED_TOOL_DISABLED`;
- an OpenAI key you may use reaches that model, with responses and hosted tools — else `AI_KEY_MISSING` or `AI_MODEL_NOT_REACHABLE`.

Its `network` stage is skipped (the AI service holds the connection; the live query proves the path). The model is not a run's tier model: a web search call is not a `browser_agent` call, so the agent policy's tiers do not apply to it (console AGENTS.md, "Agent run policies", rule 1).

**Answers and allowed sites.** An answer is written from pages the console never sees, so it cannot be filtered against a task's allowed sites. When a run has allowed sites, an answer-type provider is skipped for every search of that run and the next usable result-type provider answers (its hits are filtered as always). If none is usable the search answers "Web search is not available right now" for that call; the tool stays offered. Without allowed sites, the answer is shown to the model as third-party text inside the same wrapper as hits: a model wrote it from pages nobody here read.

**The hosted search is used only by this provider.** It is never attached to the agent's own model calls, where it would run inside the model provider and skip `executeTool`, Stop, the gates and the step record. `apps/api/test/architecture/hosted-web-search.spec.ts` fails when `web_search` appears as a hosted tool type outside `apps/api/src/web-search/`.

## Cost

A search through a result-type provider costs its fee per call. An answer-type provider costs two parts, each counted once:

- **The search fee**, per search: in `web_search_usage` with the other providers (Administration → Web search, Usage). An answer that reports several searches (OpenAI's `hosted_tool_call` items of type `web_search`) counts each one: for the fee, for the per-day limit and for the run's limit. `estimatedCostPerCallUsd` is the fee only.
- **The tokens** of the pages the model read and of its answer: only in the AI usage ledger, under the feature **Web search** (Administration → AI → Usage), priced like every other AI call. The web search usage never adds them.

## A second answer-type provider (finding, E50.9)

Checked, not built. A second answer-type provider is one adapter file plus its contract spec (`kind: 'answer'`), with no change to the service, the tools or the web app:

- **Perplexity (Sonar)** and **xAI (Grok with live search)** speak an OpenAI-compatible chat API. The platform's AI service can reach an OpenAI-compatible endpoint (its `openai_compatible` provider slot), but it carries only the hosted tool types it models (`web_search` is OpenAI's Responses tool) and the citations it maps from OpenAI's annotations. Perplexity's search runs on every call without a tool, and its citations come back in a top-level `citations` / `search_results` field; xAI's search options are a `search_parameters` body field. The AI service's `providerOptions` escape hatch passes provider body fields, but the response's citation fields are not mapped into `AiMessageOutputItem.citations`, so the adapter would get the answer without its sources.
- **So:** through the AI service, either needs a platform seam (map the provider's citation fields into `citations`, and let a provider declare that search is built in) — an EnterpriseAppBase seam request when one is wanted. Without it, the adapter is a keyed one over `OutboundHttp` (`credential: 'api_key'`, the provider kit, the same contract spec), with its own key under `web_search.<id>` and no AI usage ledger row (its fee and tokens are one price, the estimate per call).
- **Not re-read:** the Perplexity and xAI API references were not fetched from this session (outside its network); the shapes above are as the author knew them on 2026-11-27.

## Threat model: a self-hosted provider on a private network

The console calls no private, loopback, link-local (cloud metadata included) or carrier-grade-NAT address, and only `https`, for any provider (`OutboundHttp`, checked when the address is saved and again on every request, the connection pinned to the checked address, no redirect followed). A SearXNG instance usually runs on the owner's own network, so one exception exists:

- **Who sets it:** only an administrator (`system_settings:write`), by ticking `allowPrivate` for the SearXNG address. It is off by default. No user, model, page, search result or run can set or widen it.
- **What it allows:** a private address and `http` **for the one configured host**, exactly (the request carries `allowedHosts: [<that host>]` and `allowInsecureHttp`, which accepts `http` only for a host in `allowedHosts`). Every other host stays under the full check, and the port rule (80, 443, 8443 or from 1024) still applies.
- **What it does not allow:** a redirect (never followed), another host, a page a search result names (`web_fetch` has its own rules and never takes this exemption), a user name or password in the address, a query or fragment in it.
- **Where it shows:** the egress list (Doctor) names the configured host under `web_search.searxng`, with "private network allowed for its configured host" in its label, so the exception is visible to the administrator.
- **Residual risk:** an administrator who points the address at another internal service lets the console send GET requests with search words to it, and read its JSON back as search results (cleaned, capped and marked as third-party data). This is the administrator's own decision about their own network, like a Vault address on `secrets.vault.allowedHosts`.

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
