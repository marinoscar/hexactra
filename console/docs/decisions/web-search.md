# Decision: web search, keys of outside services, and diagnostics for every connection

**Status:** accepted (E50.1, #971, epic E50 #970), 2026-11-26. **Scope:** the agent packages, the runner host, connections, secrets, the console web app, the CLI and the SDK.

Every statement below says how it was established:

- **[code]**: read in this repository or in an installed package's typings, at the commit this record was merged on.
- **[docs]**: from the provider's public API reference as the author knew it on 2026-11-26. It was not fetched again for this record and not tried with a key. No session of this epic has had a search provider key or an AI provider key. E50.5 and E50.8 re-read the reference before coding each adapter and correct this table in the same PR.
- **[decided]**: a choice this record makes.

## 1. The provider interface: results and answers in one shape

The epic's `WebSearchResult` is **confirmed** with one clarification. [decided]

```ts
export interface WebSearchResult {
  provider: string;                                       // bounded id: 'brave', 'tavily', 'exa', 'searxng', 'openai'
  hits: WebSearchHit[];                                   // always present; may be empty
  answer: { text: string; citations: string[] } | null;  // answer-type providers only
}
```

- A **result-type** provider (Brave, Tavily, Exa, SearXNG) fills `hits` and sets `answer` to `null`. Tavily can also write an answer (`include_answer`); the adapter does **not** ask for it, so Tavily stays a result-type provider and costs one credit.
- An **answer-type** provider (OpenAI hosted web search; later Perplexity Sonar, xAI) fills `answer` and maps its citations to `hits` (title, URL, an empty snippet unless the provider gives one, `publishedAt: null`). `answer.citations` holds the URLs in the provider's order, so the model can match the text to the hits.
- **What the model reads**: the `web_search` tool result is wrapped like an MCP result (the third-party wrapper in `@marinoscar/hexactra-agent`): first `answer.text` when present, inside the wrapper, then the hits as a numbered list, each hit `n. title — url` with its snippet on the next line (as `formatSearch` in `@marinoscar/hexactra-web-agent` writes it; corrected in E50.5, #975). Text is cleaned (control characters removed, the sensitive patterns applied) and capped (snippet 400 characters, answer 4,000, the whole result 12,000). The result is data and never an instruction.
- `provider` is recorded on the step and the span; it is a bounded id, never a URL.

### Provider table

| Provider | Kind | Endpoint | Auth | Parameters used | Response fields mapped | Limit and quota signals | Published price (2026-11-26) | Source |
|---|---|---|---|---|---|---|---|---|
| Brave Search | results | `GET https://api.search.brave.com/res/v1/web/search` | header `X-Subscription-Token: <key>` (never in the URL) | `q`, `count` (1 to 20), `freshness` (`pd`/`pw`/`pm`/`py`), `site:` in `q` | `web.results[].title`, `.url` (http and https only), `.description` (HTML marks stripped) → snippet, `.page_age` → `publishedAt`; no `web` key is an empty list | `401`/`403` key refused; `429` rate (`Retry-After`, else the first value of `X-RateLimit-Reset`, in seconds); quota: `402`, or `429` whose last `X-RateLimit-Remaining` value (per second, per month) is `0` or whose `error.code` names a quota | about USD 5 per 1,000 calls on the paid plan; a small monthly free allowance | [docs], not re-read in E50.5 (the reference was not reachable from the session: `api-dashboard.search.brave.com` is outside its network); as implemented in `apps/api/src/web-search/providers/brave.provider.ts` |
| Tavily | results | `POST https://api.tavily.com/search` | header `Authorization: Bearer <key>` | `query`, `max_results` (≤ 20), `search_depth: "basic"`, `time_range` (`day`/`week`/`month`/`year`), `include_domains` | `results[].title`, `.url`, `.content` → snippet, `.published_date` | `401` key refused; `429` rate; `432` plan limit; `433` pay-as-you-go limit | 1 credit per basic search; about USD 0.008 per credit pay-as-you-go; 1,000 free credits a month | [docs] |
| Exa | results | `POST https://api.exa.ai/search` | header `x-api-key: <key>` | `query`, `numResults` (≤ 25), `type: "auto"`, `startPublishedDate`, `includeDomains`, `contents.highlights` | `results[].title`, `.url`, `.highlights[0]` or `.text` → snippet, `.publishedDate` | `401`/`403` key refused; `429` rate; `402` credits exhausted | about USD 5 per 1,000 searches (1 to 25 results), contents extra | [docs] |
| SearXNG (self-hosted) | results | `GET <base>/search?format=json` | none (optional basic auth or a header set by the operator's proxy) | `q`, `time_range` (`day`/`month`/`year`), `categories=general`, `site:` in `q` | `results[].title`, `.url`, `.content` → snippet, `.publishedDate` | `403` when the instance has not enabled the `json` format; `429` from its limiter | free; the operator's own hosting | [docs] |
| OpenAI web search | answer | through `AiService.forUser(...)` with `tools: [{ type: 'web_search' }]` | the platform's AI key (user, organization or deployment tier) | `searchContextSize`, `userLocation` | message `text` → `answer.text`; `citations[]` (`url`, `title`) → `answer.citations` and `hits`; `hosted_tool_call` items with `tool: 'web_search'` → the count of searches | the platform's AI errors (`AiError` codes) | per 1,000 hosted search calls plus the model's tokens (about USD 10 per 1,000 calls for the standard search tool) | typings [code], price [docs] |

Prices change: `estimatedCostPerCallUsd` is a default the administrator overrides (E50.5), and the UI says "estimate".

## 2. OpenAI as a search provider

**Answer: yes, the platform already supports it. No seam request is needed.** [code]

Read in `@marinoscar/platform-api` `0.1.0-next.40` and `@marinoscar/platform-ai-providers`:

- `runtime/ai-run-request.d.ts`: a `responses` call accepts `tools: [{ type: 'web_search', searchContextSize?, userLocation? }]` next to function tools.
- `config/dto/update-ai-config.dto.d.ts`, `ai.system-settings.d.ts`: `ai.hostedTools.web_search` is a per-deployment switch for the hosted tool type (#442 upstream).
- `core/types/responses.types.d.ts` (`platform-ai-providers`): `AiMessageOutputItem.citations?: AiUrlCitation[]` (`url`, `title`, `startIndex`, `endIndex`), and `AiHostedToolCallItem` with `tool: 'web_search'` and `result?: AiWebSearchCallResult` (`queries[]`, `sources[].url`). The number of `hosted_tool_call` items with `tool === 'web_search'` is the number of searches made.
- `runtime/ai.service.d.ts`: `AiCallTarget.hostedTools` puts the hosted tool types (never their options) on the span.

The call E50.9 makes, inside the OpenAI search provider adapter only:

```ts
const ai = this.aiService.forUser(userId);
const res = await ai.responses({
  feature: 'web_search',                   // a registered AI feature, so usage is attributed and metered
  input: [{ role: 'user', content: query }],
  tools: [{ type: 'web_search', searchContextSize: 'low' }],
  toolChoice: 'required',
  maxOutputTokens: 800,
});
// answer.text = message text; citations → hits; searches = hosted_tool_call items with tool 'web_search'
```

E50.9 still needs the deployment's `ai.hostedTools.web_search` switch on; when it is off, the adapter's diagnostic says `HOSTED_TOOL_DISABLED` and the provider is not offered.

**Rule kept** [decided]: the hosted search is used **only inside the search provider adapter**, which runs because the agent called `web_search` through `executeTool`. It is never attached to the agent's own model calls, where it would skip Stop, Pause, the gates, the span and the step record. An architecture test in E50.9 asserts that `web_search` as a hosted tool type appears only under `apps/api/src/web-search/`.

E50.9's prerequisite "the platform release that answers E50.1's seam request" is therefore **already met** by the installed platform. It still waits for E50.5 and E50.8.

## 3. Keys of outside services in the Vault feature

### What exists [code]

- `apps/api/src/secrets/secrets-provider.port.ts`: `SecretsProviderPort.lookup(ownerId, origin, kind)` and `release(req)`, where `ItemKind = 'login' | 'identity' | 'card'` and every `ReleaseRequest` carries an `origin` read by the fabric from the browser. A release goes to the fabric, which types the value and wipes it. Nothing releases a value to console server code.
- `@marinoscar/vault-contract` `0.1.0-next.6`: item types `login`, `identity` and `card`; release purposes `login`, `signup`, `password_change`, `mfa`, `save_login`. There is no item without an origin and no purpose for server use.
- The built-in store (`apps/api/src/secrets/builtin/`) embeds `@marinoscar/vault-api` and `@marinoscar/vault-db` in the console's own process; the ciphertext is in the console's database.
- `secrets.agentUse.enabled` (system and user, default off) is the kill switch for agent use (`secrets-policy.service.ts`).

### Decision [decided]

1. **Item kind `api_key`.** One secret value, plus a `service` (`web_search`) and a `name` (`brave`). No origin, no allowed-sites list. Shown in the owner's Vault and built-in store as "Service key".
2. **Release path for server use.** A new, separate method on a provider that supports it, so the origin-bound `release` is not widened:

   ```ts
   // optional on SecretsProviderPort; a provider without it cannot hold service keys
   releaseServiceKey?(req: { ownerId: string; service: string; name: string; purpose: 'service_call' }): Promise<SecretBytes>;
   ```

   - **Caller:** the console API process only, from the service credentials port (E50.2), never from the fabric or a tool.
   - **Credential:** for the remote Vault, the owner's existing Vault connection token with a new scope `vault:service_keys_read`; for the built-in store, the in-process call the store already uses.
   - **Bound to:** the owner, the `service` and the `name`. Nothing from a model or a page selects which key is released: the provider id comes from the deployment's settings.
   - **Audit:** a secrets activity event `service_key_released` with `service`, `name`, the tier and the run id; never the value.
   - **Rate limit:** per owner and service, 120 releases a minute (a search is about one release; the port caches the value for at most 60 seconds in memory, wiped on expiry).
   - **Kill switch:** `secrets.agentUse.enabled` off at the system level stops every service key release from Vault or the built-in store; the port then falls back to the next tier (organization, deployment), which live in the credential store.
3. **Built-in store:** the value already crosses the console's process. It needs the `api_key` item type in the embedded packages (`vault-contract` item type and validation, `vault-db` storage, `vault-api` route) and a new method in `store.provider.ts`. The packages are released from `marinoscar/vault`, so the built-in store binding waits for the same upstream release as the remote Vault.
4. **Remote Vault:** needs `GET /service-keys/{service}/{name}` with scope `vault:service_keys_read`, audited on Vault's side, refused when Vault's own agent access switch is off. **This does not exist in Vault yet.** The upstream issue is drafted on #971; it was not filed, because this session had no access to `marinoscar/vault`. E50.3 (#973) waits for it.
5. **Tiers:** a Vault item belongs to one owner. The **organization and deployment tiers stay in the platform credential store**. Only the **user tier** may be bound to the Vault or the built-in store, by the owner's choice on the web search settings page.
6. **The cost, plainly:** with the user tier bound to the Vault, a Vault that cannot be reached means that user's own key cannot be read. The port then falls back to the organization or deployment key if the administrator allows its use; otherwise `web_search` answers `NOT_CONFIGURED` with a remedy, the run continues, and the agent may use the browser. A Vault outage never fails a run.

## 4. Do Google and Microsoft need a refactor?

**Answer: no rewrite.** [code] [decided]

Read: `connections/provider.ts`, `capabilities.ts`, `capability-hub.ts`, `google/google.adapter.ts`, `microsoft/microsoft.adapter.ts`.

- `ConnectionProviderAdapter` already isolates each provider behind `scopesFor`, `authorizeUrl`, `exchangeCode`, `refresh`, `revoke` and `probe(ProbeInput): Promise<ProbeResult>`, where `ProbeResult` is `{ ok: true } | { ok: false; code }` with a closed, data-free code vocabulary.
- The capability hub is the one gate: it re-reads the connection on every call and refuses a capability that is off.
- **Change:** `ConnectionProviderAdapter` gains an optional `diagnose(input): Promise<DiagnosticStage[]>` (E50.10, E50.11). `probe` stays for `POST /api/connections/{id}/test` so existing clients do not change shape.
- **Web search is not a `Connection` row.** A connection is an account or a server one owner adds; web search is a deployment capability with tiered keys (user, organization, deployment), an administrator switch, and no OAuth or account identity. Making it a row would give it a fake account, put a deployment key under one owner, and change the shape of the connections API. Under the rule of E50.17 both are still "set up and switched on means available", implemented by two functions (`runConnections` and `web-availability.ts`).
- **What would change the answer:** a provider whose sign-in is not OAuth with a refresh token (for example a device code flow with no refresh), or a capability that cannot be expressed as one of the capability ids. Neither is in this epic.

## 5. Smaller decisions [decided]

- **`web_fetch` runs on the console server, not on the node.** Consequences: the request leaves from the console's address (often a datacenter address), with no sign-in and no scripts. It reads public HTML and plain text only. The browser on the node stays the way to read anything that needs a residential address, a sign-in or scripts; `web_fetch` says so in its `BLOCKED` and `UNSUPPORTED_TYPE` answers. It goes through `OutboundHttp` (address check, pinned address, each redirect checked).
- **A search query is recorded in the step in full**, after the sensitive patterns are applied. It is the owner's own run, and the owner needs it to understand what the agent did. The span records only the provider id, the hit count and the timing, never the query.
- **A hosted AI app's run:** an app limit `allowWebSearch`, like `allowConnections`. Its default follows the rule of E50.17 (on for new apps; stored values kept).
- **A search provider that cannot be reached never fails a run.** The tool answers `UNAVAILABLE` (or `RATE_LIMITED`, `QUOTA_EXCEEDED`) and the agent may use the browser.

## Upstream requests

| Repository | Request | Needed by | Number |
|---|---|---|---|
| `marinoscar/EnterpriseAppBase` | none: the hosted `web_search` tool, citations and hosted tool call items already exist in `0.1.0-next.40` | E50.9 | — |
| `marinoscar/vault` | an `api_key` item type and `GET /service-keys/{service}/{name}` (scope `vault:service_keys_read`), embedded and remote | E50.3 | drafted on #971, not filed yet (no access to the repository from the session that wrote this record) |

## What stayed unverified

- Every price and limit in the provider table: read from documentation, not re-fetched, not tried with a key.
- The OpenAI search call itself: the typings allow it; no AI key was available to run it.
- The Vault route: designed here, not built.

## Implementation notes (E50.5, #975)

- The host's registry, Brave adapter, settings (`webSearch`, system and user), usage table (`web_search_usage`) and routes (`/api/web-search`) are in `apps/api/src/web-search/`. A provider with a key registers its service credential `web_search.<id>` (label "<label> API key", every tier) when it registers itself.
- The instruments are `app.web_search.calls` (`provider`, `outcome`) and `app.web_search.duration`: the console's own instruments are named `app.*` (the epic wrote `hexactra.web_search.*`).
- `diagnose` returns a locally declared `DiagnosticStage` (`apps/api/src/web-search/diagnostic-stage.ts`), the shape of the epic's Design §4, until the diagnostics framework (E50.10) is on `main`.
- `limits.perRun` is counted by the port: `WebSearchService.forUser` returns a new port that counts its own calls, so E50.7 binds one per run.
- The fallback is one step: after `AUTH_REFUSED`, `QUOTA_EXCEEDED` or `UNAVAILABLE` from the first usable provider, the next usable one is tried once; both calls are counted in the usage table. The user's preferred provider (`webSearch.provider`) goes first when it is usable.
- No real search was made: no session had a Brave key, and Brave's reference was not re-read (not reachable from the session). The adapter is tested against an in-process fake built from the documented shape (`apps/api/src/web-search/testing/fake-brave.ts`).

## Implementation notes (E50.3, #973)

- Released upstream as `@marinoscar/vault-{contract,db,api,web}@0.1.0-next.7` (marinoscar/vault#241, PR #242): the system type **Service Key** (`service`, `key_name`, sensitive `key`, `notes`), `GET /api/agent/v1/service-keys/{service}/{name}` (contract 1.4, scope `vault:service_keys_read`, permission `agent_service_keys:read`, 120 a minute per owner and service, audited `agent.service_key.read`, `409 SERVICE_KEY_AMBIGUOUS`) and the embedded `ServiceKeyReleasePort`. No new migration in `vault-db`.
- `releaseServiceKey?` is on `SecretsProviderPort` as designed; the built-in store implements it. The remote Vault is read by `VaultApiClient.serviceKey`. Both are reached through `SecretsServiceKeys` (`apps/api/src/secrets/service-keys.ts`), which picks the owner's active provider.
- The two bindings of §3 are one class, `SecretsProviderServiceCredentials` (`apps/api/src/service-credentials/secrets-provider.binding.ts`, the cache and the miss mapping), over `SecretsServiceKeys`, instead of the two files the issue named: which of Vault and the built-in store answers is the owner's `secrets.provider`, already decided by the secrets feature.
- The owner's choice is per key: `serviceCredentials.binding` is the default for a new key and `serviceCredentials.keys[<ref>]` records where each key is, so a change of the default never strands one.
- The kill switch is the deployment's `secrets.agentUse.enabled` only (§3.2); the owner's own switch is about pages.
- The console cannot write into a remote Vault (the agent API has no write for a service key): Move into Vault checks that Vault answers with the key the owner added there, then removes the console's copy. Move out of Vault leaves Vault's copy.
- The audit is an Activity row (event `service_key`: the column is 16 characters, so the name `service_key_released` is the row's meaning, not its event value) plus Vault's own row.
- `ServiceCredentialPort.resolveDetailed` returns the reason `PROVIDER_UNAVAILABLE`; web search turns it into `UNAVAILABLE` (a fallback code).
- Verified only against the fake Vault (contract 1.4) and the built-in store in process; no real Vault deployment.
