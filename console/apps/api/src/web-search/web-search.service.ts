// Web search in the host (E50.5, #975): which provider answers for a user, with which key, within which limits, and one call.
//
// Usable for a user: the deployment's switch and the user's are on, and for some provider in `webSearch.order` (the user's preferred
// provider first) that is installed and switched on, a key resolves through the service credentials port, where the deployment's
// key (system tier) is allowed only while `shareDeploymentKey` is on and the user's own (user tier) only while `allowUserKeys` is on.
//
// One call: check the per-day limit, resolve the key, call the provider, wipe the key, count the call. On `AUTH_REFUSED`,
// `QUOTA_EXCEEDED` or `UNAVAILABLE` the next usable provider is tried ONCE; the result names the provider that answered. A provider
// that fails never surfaces anything but a `WebToolError`. The query is the owner's text: it is not logged and is not a metric label.
//
// Answer-type providers (E50.9, OpenAI web search through the AI service): usable while their own credential check passes (AI on, a
// key resolves, the hosted search switched on, a model chosen). When the run has allowed sites they are skipped for that call, since
// an answer is written from pages nobody here can filter: a result-type provider answers, or the call is `UNAVAILABLE`. An answer
// that reports several searches counts each one for the per-day limit, the per-run limit and the fee.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { WebToolError, isWebToolError, type WebSearchPort, type WebSearchRequest, type WebSearchResult } from '@marinoscar/hexactra-web-agent';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../prisma/prisma.service';
import { SERVICE_CREDENTIAL_PORT, type CredentialTier, type ServiceCredentialPort, type Who } from '../service-credentials/service-credential.port';
import { credentialRefOf, SearchProviderRegistry, type ProviderAuth, type ProviderSearchResult, type SearchProvider, type SearchRequest } from './search-provider';
import { outcomeOf } from './web-search.metrics';
import { providerSettingsOf, resolveWebSearchSystemSettings, webSearchUserOf, type ResolvedWebSearchSystemSettings, type WebSearchUserSettings } from './web-search.settings';
import { WebSearchUsage } from './web-search.usage';

/** How stale the cached system settings may be. */
export const WEB_SEARCH_SETTINGS_CACHE_MS = 5_000;
/** The most searches one answer is counted as (a bound on what a provider reports). */
export const MAX_SEARCHES_PER_CALL = 20;
/** The codes after which the next usable provider is tried once. */
export const FALLBACK_CODES: ReadonlySet<string> = new Set(['AUTH_REFUSED', 'QUOTA_EXCEEDED', 'UNAVAILABLE']);

/** How one call may be answered. */
export interface WebSearchCallOptions {
  /**
   * Only result-type providers (the run has allowed sites): an answer-type provider reads pages that cannot be filtered against
   * the run's sites, so it is skipped for the call (E50.9).
   */
  resultsOnly?: boolean;
}

/** Why search is not available for a user. */
export type WebSearchOffReason = 'disabled_by_admin' | 'disabled_by_you' | 'no_provider' | 'no_key';

export interface Candidate {
  provider: SearchProvider;
  /** The tier of the key that would be used; null for a provider without a key. */
  tier: CredentialTier | null;
}

export interface WebSearchStatus {
  enabled: boolean;
  reason: WebSearchOffReason | null;
  provider: { id: string; label: string; tier: CredentialTier | null } | null;
  today: { calls: number; limit: number | null; remaining: number | null };
  perRunLimit: number | null;
}

export interface WebSearchProviderView {
  id: string;
  label: string;
  kind: 'results' | 'answer';
  credential: 'api_key' | 'none' | 'ai_service';
  needsKey: boolean;
  /** The administrator's switch for this provider. */
  enabled: boolean;
  /** Listed in the deployment's order. */
  listed: boolean;
  /** The tier your requests would use, among the allowed ones; null when none. */
  keyTier: CredentialTier | null;
  /** Which tiers hold a key (allowed or not). */
  keys: Record<CredentialTier, boolean>;
  /** The ESTIMATE in USD per call (the administrator's override, else the provider's default). */
  estimatedCostPerCallUsd: number | null;
}

/** The tiers the settings allow. */
export function allowedTiers(s: Pick<ResolvedWebSearchSystemSettings, 'allowUserKeys' | 'shareDeploymentKey'>): CredentialTier[] {
  return [...(s.allowUserKeys ? (['user'] as const) : []), 'organization', ...(s.shareDeploymentKey ? (['system'] as const) : [])];
}

@Injectable()
export class WebSearchService {
  private readonly log = new Logger('WebSearch');
  private cached: { at: number; value: ResolvedWebSearchSystemSettings } | null = null;

  /** The wall clock; tests replace it. */
  clock: () => Date = () => new Date();

  constructor(
    private readonly registry: SearchProviderRegistry,
    @Inject(SERVICE_CREDENTIAL_PORT) private readonly credentials: ServiceCredentialPort,
    private readonly usage: WebSearchUsage,
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SystemSettingsService,
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  // ---- settings ----

  /** The deployment's settings, at most a few seconds old. A failed read keeps the last good value, or the defaults. */
  async system(): Promise<ResolvedWebSearchSystemSettings> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < WEB_SEARCH_SETTINGS_CACHE_MS) return this.cached.value;
    let value: ResolvedWebSearchSystemSettings;
    try {
      value = resolveWebSearchSystemSettings((await this.settings?.getNamespace('webSearch')) ?? null);
    } catch (e) {
      this.log.warn(`web search settings could not be read (${e instanceof Error ? e.name : 'error'}); using the last known values`);
      value = this.cached?.value ?? resolveWebSearchSystemSettings(null);
    }
    this.cached = { at: now, value };
    return value;
  }

  invalidate(): void {
    this.cached = null;
  }

  async userSettings(userId: string): Promise<WebSearchUserSettings> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    return webSearchUserOf(row?.value);
  }

  /** The cost estimate of a provider: the administrator's override, else the provider's default. */
  costOf(s: ResolvedWebSearchSystemSettings, p: SearchProvider): number | null {
    return providerSettingsOf(s, p.id).costPerCallUsd ?? p.estimatedCostPerCallUsd;
  }

  // ---- who answers ----

  /** The providers that could answer for `who`, in the order they are tried. Never reads a key's value. */
  async candidates(who: Who, s: ResolvedWebSearchSystemSettings, user: WebSearchUserSettings): Promise<Candidate[]> {
    const ids = s.order.filter((id) => this.registry.get(id) && providerSettingsOf(s, id).enabled);
    if (user.provider && ids.includes(user.provider)) ids.unshift(...ids.splice(ids.indexOf(user.provider), 1));
    const out: Candidate[] = [];
    for (const id of ids) {
      const provider = this.registry.get(id)!;
      if (provider.credential === 'api_key') {
        const st = await this.credentials.status(credentialRefOf(id), who, { allowTiers: allowedTiers(s) });
        if (st.tier) out.push({ provider, tier: st.tier });
      } else if (provider.credential === 'none') {
        if (providerSettingsOf(s, id).baseUrl) out.push({ provider, tier: null });
      } else if (await this.aiServiceUsable(provider, who)) {
        out.push({ provider, tier: null });
      }
    }
    return out;
  }

  /** An `ai_service` provider is usable while its own credential check does not fail (AI on, a key, the switch, a model). */
  private async aiServiceUsable(provider: SearchProvider, who: Who): Promise<boolean> {
    if (!provider.diagnoseCredential) return true;
    try {
      return (await provider.diagnoseCredential(who)).status !== 'fail';
    } catch {
      return false;
    }
  }

  private async offReason(who: Who, s: ResolvedWebSearchSystemSettings, user: WebSearchUserSettings): Promise<{ reason: WebSearchOffReason | null; candidates: Candidate[] }> {
    if (!s.enabled) return { reason: 'disabled_by_admin', candidates: [] };
    if (!user.enabled) return { reason: 'disabled_by_you', candidates: [] };
    if (!s.order.some((id) => this.registry.get(id) && providerSettingsOf(s, id).enabled)) return { reason: 'no_provider', candidates: [] };
    const candidates = await this.candidates(who, s, user);
    return { reason: candidates.length ? null : 'no_key', candidates };
  }

  /**
   * The port the agent's `web_search` tool is bound to (E50.7), or `null` when nothing is usable for this user. One port counts its
   * own calls against `limits.perRun`: bind one per run. `resultsOnly`: the run has allowed sites (answer-type providers skipped).
   */
  async forUser(userId: string, orgId: string | null, opts: WebSearchCallOptions = {}): Promise<WebSearchPort | null> {
    const who = { userId, orgId };
    const [s, user] = await Promise.all([this.system(), this.userSettings(userId)]);
    const { reason } = await this.offReason(who, s, user);
    if (reason) return null;
    let used = 0;
    return {
      search: async (req: WebSearchRequest): Promise<WebSearchResult> => {
        const limit = (await this.system()).limits.perRun;
        if (limit !== null && used >= limit) {
          this.metrics?.add('webSearchCalls', 1, { provider: 'none', outcome: 'limit' });
          throw new WebToolError('LIMIT_REACHED');
        }
        used += 1;
        const { searches, ...result } = await this.searchCounted(who, req, opts);
        // An answer that made several searches counts each one against the run's limit too.
        if (searches && searches > 1) used += searches - 1;
        return result;
      },
    };
  }

  /** `GET /api/web-search/status`: on or off and why, the provider that answers and its key's tier, today's count and limit. No key. */
  async status(userId: string, orgId: string | null): Promise<WebSearchStatus> {
    const who = { userId, orgId };
    const [s, user, calls] = await Promise.all([this.system(), this.userSettings(userId), this.usage.callsOn(userId, this.clock())]);
    const { reason, candidates } = await this.offReason(who, s, user);
    const first = candidates[0] ?? null;
    const limit = s.limits.perUserPerDay;
    return {
      enabled: reason === null,
      reason,
      provider: first ? { id: first.provider.id, label: first.provider.label, tier: first.tier } : null,
      today: { calls, limit, remaining: limit === null ? null : Math.max(0, limit - calls) },
      perRunLimit: s.limits.perRun,
    };
  }

  /** `GET /api/web-search/providers`: every installed provider, and for the caller whether a key is there and at which tier. */
  async providers(userId: string, orgId: string | null): Promise<WebSearchProviderView[]> {
    const who = { userId, orgId };
    const s = await this.system();
    const out: WebSearchProviderView[] = [];
    for (const p of this.registry.list()) {
      let keyTier: CredentialTier | null = null;
      let keys: Record<CredentialTier, boolean> = { user: false, organization: false, system: false };
      if (p.credential === 'api_key') {
        const st = await this.credentials.status(credentialRefOf(p.id), who, { allowTiers: allowedTiers(s) });
        keyTier = st.tier;
        keys = st.tiers;
      }
      out.push({
        id: p.id,
        label: p.label,
        kind: p.kind,
        credential: p.credential,
        needsKey: p.credential === 'api_key',
        enabled: providerSettingsOf(s, p.id).enabled,
        listed: s.order.includes(p.id),
        keyTier,
        keys,
        estimatedCostPerCallUsd: this.costOf(s, p),
      });
    }
    return out;
  }

  // ---- one search ----

  /** One search for `who`: limited per day, counted, with one fallback. Throws `WebToolError` only. */
  async search(who: Who, req: WebSearchRequest, opts: WebSearchCallOptions = {}): Promise<WebSearchResult> {
    const { searches: _searches, ...result } = await this.searchCounted(who, req, opts);
    return result;
  }

  /** {@link search}, with the number of searches an answer-type provider reported (more than one only). */
  private async searchCounted(who: Who, req: WebSearchRequest, opts: WebSearchCallOptions): Promise<ProviderSearchResult> {
    const [s, user] = await Promise.all([this.system(), this.userSettings(who.userId)]);
    const off = await this.offReason(who, s, user);
    if (off.reason) throw new WebToolError('NOT_CONFIGURED');
    // The run has allowed sites: an answer-type provider is skipped for this call; with no result-type provider left, the call
    // says search is not available (the tool stays offered, E50.17) and nothing is sent or counted.
    const candidates = opts.resultsOnly ? off.candidates.filter((c) => c.provider.kind === 'results') : off.candidates;
    if (candidates.length === 0) throw new WebToolError('UNAVAILABLE');
    const limit = s.limits.perUserPerDay;
    if (limit !== null && (await this.usage.callsOn(who.userId, this.clock())) >= limit) {
      this.metrics?.add('webSearchCalls', 1, { provider: candidates[0]!.provider.id, outcome: 'limit' });
      throw new WebToolError('LIMIT_REACHED');
    }
    const sreq: SearchRequest = { query: req.query, count: req.count, freshness: req.freshness, site: req.site, signal: req.signal };
    let last: WebToolError = new WebToolError('NOT_CONFIGURED');
    for (let i = 0; i < Math.min(2, candidates.length); i++) {
      try {
        return await this.callOne(who, candidates[i]!.provider, s, sreq);
      } catch (e) {
        last = e as WebToolError;
        if (!FALLBACK_CODES.has(last.code) || req.signal.aborted) throw last;
      }
    }
    throw last;
  }

  /** One call to one provider: resolve its key, call, wipe, count. Throws `WebToolError` only. */
  private async callOne(who: Who, provider: SearchProvider, s: ResolvedWebSearchSystemSettings, req: SearchRequest): Promise<ProviderSearchResult> {
    let auth: ProviderAuth | null;
    try {
      auth = await this.authFor(who, provider, s);
    } catch (e) {
      // The owner's secrets provider could not answer (E50.3): counted as this provider unavailable, so the fallback may try the next.
      this.metrics?.add('webSearchCalls', 1, { provider: provider.id, outcome: outcomeOf('UNAVAILABLE') });
      throw isWebToolError(e) ? e : new WebToolError('UNAVAILABLE');
    }
    if (!auth) throw new WebToolError('NOT_CONFIGURED'); // removed between the check and the call; never counted
    const started = Date.now();
    let code: string | null = null;
    let searches = 1;
    try {
      const result = await provider.search(req, auth);
      searches = Math.max(1, Math.min(MAX_SEARCHES_PER_CALL, Math.floor(result.searches ?? 1)));
      return { provider: provider.id, hits: result.hits, answer: result.answer, ...(searches > 1 ? { searches } : {}) };
    } catch (e) {
      const err = isWebToolError(e) ? e : new WebToolError('UNAVAILABLE');
      code = err.code;
      throw err;
    } finally {
      if (auth.kind === 'api_key') auth.key.wipe();
      const ms = Date.now() - started;
      if (code !== 'ABORTED') {
        this.metrics?.add('webSearchCalls', 1, { provider: provider.id, outcome: outcomeOf(code) });
        this.metrics?.record('webSearchDuration', ms / 1000, { provider: provider.id });
        await this.usage.record(who.userId, provider.id, this.clock(), { failed: code !== null, costUsd: this.costOf(s, provider), calls: code === null ? searches : 1 }).catch((e: unknown) => {
          this.log.warn(`web search: the usage row could not be written: ${e instanceof Error ? e.name : 'error'}`);
        });
      }
    }
  }

  private async authFor(who: Who, provider: SearchProvider, s: ResolvedWebSearchSystemSettings): Promise<ProviderAuth | null> {
    if (provider.credential === 'api_key') {
      const r = await this.credentials.resolveDetailed(credentialRefOf(provider.id), who, { allowTiers: allowedTiers(s) });
      if (r.found) return { kind: 'api_key', key: r.found.value };
      // The user's key is in their secrets provider and it could not answer, and no later tier held one (E50.3): "not available",
      // never a failed run; the agent may use the browser. Counted as an unavailable call of this provider.
      if (r.reason === 'PROVIDER_UNAVAILABLE') throw new WebToolError('UNAVAILABLE');
      return null;
    }
    if (provider.credential === 'none') {
      const { baseUrl, allowPrivate } = providerSettingsOf(s, provider.id);
      return baseUrl ? { kind: 'none', baseUrl, allowPrivate } : null;
    }
    return { kind: 'ai_service', userId: who.userId, orgId: who.orgId };
  }
}
