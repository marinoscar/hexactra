# Web search

The agent's `web_search` tool asks a search provider for results through the console server, with a key the owner, their organisation or the deployment set (Administration → Web search). The design is in the [decision record](decisions/web-search.md); this page covers the providers and how to add one. (The owner guide and the full threat model of web search are E50.16, #986.)

## Providers

| Id | Provider | Kind | Credential | Hosts | Default estimate per call |
|---|---|---|---|---|---|
| `brave` | Brave Search | results | API key (`web_search.brave`) | `api.search.brave.com` | USD 0.005 |
| `tavily` | Tavily | results | API key (`web_search.tavily`) | `api.tavily.com` | USD 0.008 |
| `exa` | Exa | results | API key (`web_search.exa`) | `api.exa.ai` | USD 0.01 |
| `searxng` | SearXNG (self-hosted) | results | none: an address (`webSearch.providers.searxng.baseUrl`) | the configured host | 0 |

Endpoints, parameters, the fields mapped and the limit signals of each are in the [decision record's provider table](decisions/web-search.md#provider-table). An estimate is a default the administrator overrides; it is never shown as a price.

**Which provider answers.** `webSearch.order` lists the providers in the order they are tried (default `['brave']`). A provider is tried only when it is in the order, switched on (`webSearch.providers.<id>.enabled`) and usable for the caller (a key at an allowed tier, or an address). A user's preferred provider (`webSearch.provider` in their settings) goes first for that user. After `AUTH_REFUSED`, `QUOTA_EXCEEDED` or `UNAVAILABLE` the next usable provider is tried once. A provider is never chosen by a model, a page or a search result: only by settings.

**SearXNG.** Set its address in Administration → Web search (`https://search.example.org`, a path prefix such as `/searx` is kept) and put `searxng` in the order. The instance must answer JSON: add `json` to `search.formats` in its `settings.yml`; otherwise it answers 403, a search moves on to the next provider and Test reports `FORMAT_DISABLED`. An instance on your own network needs the tick "this instance is on my private network" (`allowPrivate`): see the threat model below.

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
10. **Nothing else:** the admin card and the user's provider list read `GET /api/web-search/providers` and `GET /api/web-search/admin` (`label`, `kind`, `credential`, hosts, estimate), so the new provider appears with no web change.

SearXNG (E50.8, #978) was added this way, with the private-network tick (`allowPrivate`: the setting, `ProviderAuth`, and `allowInsecureHttp` on `OutboundHttp`) as its only change outside its own files; the tools did not change.
