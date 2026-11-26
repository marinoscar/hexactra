// Diagnostics of web search (E50.13, #983): the staged report of one search provider, for the caller (their effective tier) or for
// the deployment (the deployment's key only: never a user's), stored in the diagnostics history with target kind `search_provider`,
// id `<providerId>`, the caller as owner (or no owner for the deployment's). Stages: `web-search-diagnostics.ts`.
//
// The live query costs what a search costs: it is counted as one call in the usage table (the caller's). A user's report never says
// whether the deployment holds a key the administrator did not share: without a usable key it says `KEY_MISSING`.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { isWebToolError } from '@marinoscar/hexactra-web-agent';

import { DiagnosticsHistory, type StoredDiagnosticReport } from '../diagnostics/diagnostics-history.service';
import { DiagnosticsMetrics } from '../diagnostics/diagnostics.metrics';
import { overall, sanitizeStages, type DiagnosticStage, type DiagnosticTrigger } from '../diagnostics/diagnostic-report';
import { REMEDY_CODES } from '../diagnostics/remedies';
import { runStages, type StageOutcome } from '../diagnostics/stages';
import { SERVICE_CREDENTIAL_PORT, type ServiceCredentialPort, type Who } from '../service-credentials/service-credential.port';
import { credentialRefOf, SearchProviderRegistry, type ProviderAuth, type SearchProvider } from './search-provider';
import { FETCH_CHECK_HOST, FETCH_CHECK_URL, LIMIT_NEAR_RATIO, SEARCH_DIAGNOSTIC_CODES } from './web-search-diagnostics';
import { providerSettingsOf, type ResolvedWebSearchSystemSettings, type WebSearchUserSettings } from './web-search.settings';
import { allowedTiers, WebSearchService } from './web-search.service';
import { WebSearchUsage } from './web-search.usage';

export const SEARCH_REPORT_DEADLINE_MS = 20_000;
export const SEARCH_STAGE_DEADLINE_MS = 12_000;

/**
 * What the `fetch` stage needs from `web_fetch` in the host: bound to `WebFetchDiagnosticBinding` (`fetch/web-fetch.diagnostic.ts`,
 * over `WebFetchService`, E50.6) in `WebSearchModule`. Unbound, the stage is `skipped` (`installed: false`).
 */
export interface WebFetchDiagnosticHook {
  /** The deployment's `webSearch.fetch.enabled`. */
  enabled(): Promise<boolean>;
  /** One read of `url` through the real fetch path (address rules, blocked hosts, caps). Throws `WebToolError`; keeps nothing. */
  read(url: string, signal: AbortSignal): Promise<void>;
}
export const WEB_FETCH_DIAGNOSTIC_HOOK = Symbol('WEB_FETCH_DIAGNOSTIC_HOOK');

/** Whose report: a user (their effective tiers) or the deployment (the system tier only), with who pressed it (the usage row). */
export type SearchDiagnosticScope = { kind: 'user'; who: Who } | { kind: 'deployment'; adminId: string };

@Injectable()
export class WebSearchDiagnostics {
  private readonly log = new Logger('WebSearchDiagnostics');
  /** Tests shorten them. */
  reportDeadlineMs = SEARCH_REPORT_DEADLINE_MS;
  stageDeadlineMs = SEARCH_STAGE_DEADLINE_MS;

  constructor(
    private readonly registry: SearchProviderRegistry,
    private readonly service: WebSearchService,
    @Inject(SERVICE_CREDENTIAL_PORT) private readonly credentials: ServiceCredentialPort,
    private readonly usage: WebSearchUsage,
    private readonly history: DiagnosticsHistory,
    private readonly metrics: DiagnosticsMetrics,
    @Optional() @Inject(WEB_FETCH_DIAGNOSTIC_HOOK) private readonly fetchHook?: WebFetchDiagnosticHook,
  ) {}

  /** The provider a user's report is about: the one that answers for them, else the first listed, else the first installed. */
  async effectiveProvider(who: Who): Promise<string | null> {
    const [s, user] = await Promise.all([this.service.system(), this.service.userSettings(who.userId)]);
    const candidates = s.enabled && user.enabled ? await this.service.candidates(who, s, user).catch(() => []) : [];
    if (candidates[0]) return candidates[0].provider.id;
    return s.order.find((id) => this.registry.get(id)) ?? this.registry.ids()[0] ?? null;
  }

  historyForUser(userId: string, limit?: number): Promise<StoredDiagnosticReport[]> {
    return this.history.listOfKind(userId, 'search_provider', limit);
  }

  historyForDeployment(providerId: string, limit?: number): Promise<StoredDiagnosticReport[]> {
    return this.history.listDeployment('search_provider', providerId, limit);
  }

  /** Runs, stores and counts one report. The provider is installed (the route checked). */
  async diagnose(scope: SearchDiagnosticScope, provider: SearchProvider, trigger: DiagnosticTrigger, opts: { signal?: AbortSignal } = {}): Promise<StoredDiagnosticReport> {
    this.service.invalidate();
    const startedAt = new Date().toISOString();
    const deadline = AbortSignal.timeout(this.reportDeadlineMs);
    const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
    const base = { signal, stageTimeoutMs: this.stageDeadlineMs, abortCode: () => (opts.signal?.aborted ? 'ABORTED' : 'DEADLINE_EXCEEDED') };
    const s = await this.service.system();
    const user = scope.kind === 'user' ? await this.service.userSettings(scope.who.userId) : null;
    const counted = scope.kind === 'user' ? scope.who.userId : scope.adminId;
    const now = () => this.service.clock();

    let auth: ProviderAuth | null = null;
    const head = await runStages(
      [
        { id: 'switches', run: () => this.switches(scope, provider, s, user) },
        {
          id: 'credential',
          run: async () => {
            const r = await this.credential(scope, provider, s);
            auth = r.auth;
            return r.outcome;
          },
        },
      ],
      base,
    );
    const failedBefore = head.some((st) => st.status === 'fail');

    try {
      const limit = s.limits.perUserPerDay;
      const before = scope.kind === 'user' ? await this.usage.callsOn(counted, now()) : 0;
      const reached = scope.kind === 'user' && limit !== null && before >= limit;
      let own: DiagnosticStage[];
      if (failedBefore || !auth) {
        own = [
          { id: 'network', status: 'skipped', code: null, remedy: null, ms: null },
          { id: 'live_query', status: 'skipped', code: null, remedy: null, ms: null },
        ];
      } else {
        own = await this.providerOwn(provider, auth, signal, !reached);
        const live = own.find((st) => st.id === 'live_query');
        if (live && live.status !== 'skipped' && live.code !== 'ABORTED') {
          // The live query costs what a search costs: one call in the usage table.
          await this.usage.record(counted, provider.id, now(), { failed: live.status === 'fail', costUsd: this.service.costOf(s, provider) }).catch((e: unknown) => {
            this.log.warn(`web search diagnostics: the usage row could not be written: ${e instanceof Error ? e.name : 'error'}`);
          });
        }
      }

      const tail = await runStages(
        [
          { id: 'limits', independent: true, run: () => this.limits(scope, s, counted) },
          { id: 'fetch', independent: true, run: (sig) => this.fetch(sig) },
        ],
        base,
      );

      const { stages, dropped } = sanitizeStages([...head, ...own, ...tail], new Set([...SEARCH_DIAGNOSTIC_CODES, ...(provider.diagnosticCodes ?? [])]), REMEDY_CODES);
      if (dropped > 0) this.log.warn(`web search diagnostic: ${dropped} data value(s) refused and dropped (provider ${provider.id})`);
      const report = { target: { kind: 'search_provider' as const, id: provider.id }, trigger, overall: overall(stages), startedAt, finishedAt: new Date().toISOString(), stages };
      const stored = await this.history.record(report, scope.kind === 'user' ? scope.who.userId : null);
      this.metrics.run('search_provider', provider.id, report.overall);
      return stored;
    } finally {
      const a = auth as ProviderAuth | null;
      if (a?.kind === 'api_key') a.key.wipe();
    }
  }

  private async providerOwn(provider: SearchProvider, auth: ProviderAuth, signal: AbortSignal, liveQuery: boolean): Promise<DiagnosticStage[]> {
    let collected: DiagnosticStage[] | null = null;
    const [st] = await runStages(
      [
        {
          id: 'network',
          run: async (sig) => {
            collected = await provider.diagnose(auth, sig, { liveQuery });
            return { status: 'pass' };
          },
        },
      ],
      { signal, stageTimeoutMs: this.reportDeadlineMs, abortCode: () => 'DEADLINE_EXCEEDED' },
    );
    // A provider's diagnose that threw or ran out of time is one failed stage (then the query is skipped); otherwise its own stages.
    if (st!.status === 'pass' && collected) return collected;
    return [st!, { id: 'live_query', status: 'skipped', code: null, remedy: null, ms: null }];
  }

  private switches(scope: SearchDiagnosticScope, provider: SearchProvider, s: ResolvedWebSearchSystemSettings, user: WebSearchUserSettings | null): StageOutcome {
    // The administrator may test the deployment's key before switching search on: the switches only warn in their report.
    const off = scope.kind === 'deployment' ? 'warn' : 'fail';
    if (!s.enabled) return { status: off, code: 'SEARCH_OFF' };
    if (user && !user.enabled) return { status: 'fail', code: 'SEARCH_OFF', remedy: 'SEARCH_OFF_BY_YOU' };
    if (!providerSettingsOf(s, provider.id).enabled) return { status: off, code: 'PROVIDER_OFF' };
    const at = s.order.indexOf(provider.id);
    if (at < 0) return { status: 'warn', code: 'NOT_IN_ORDER' };
    return { status: 'pass', data: { position: at + 1 } };
  }

  private async credential(scope: SearchDiagnosticScope, provider: SearchProvider, s: ResolvedWebSearchSystemSettings): Promise<{ outcome: StageOutcome; auth: ProviderAuth | null }> {
    if (provider.credential === 'none') {
      const baseUrl = providerSettingsOf(s, provider.id).baseUrl;
      if (!baseUrl) return { outcome: { status: 'fail', code: 'ADDRESS_MISSING' }, auth: null };
      return { outcome: { status: 'pass', data: { host: new URL(baseUrl).hostname } }, auth: { kind: 'none', baseUrl } };
    }
    if (provider.credential === 'ai_service') {
      const who = scope.kind === 'user' ? scope.who : null;
      const outcome = (await provider.diagnoseCredential?.(who)) ?? { status: 'pass' };
      const authWho = scope.kind === 'user' ? scope.who : { userId: scope.adminId, orgId: null };
      return { outcome, auth: outcome.status === 'fail' ? null : { kind: 'ai_service', userId: authWho.userId, orgId: authWho.orgId } };
    }
    const ref = credentialRefOf(provider.id);
    const who: Who = scope.kind === 'user' ? scope.who : { userId: scope.adminId, orgId: null };
    // The deployment's report reads the system tier ONLY: never a user's key.
    const tiers = scope.kind === 'user' ? allowedTiers(s) : (['system'] as const);
    try {
      const st = await this.credentials.status(ref, who, { allowTiers: tiers });
      if (!st.tier) {
        if (scope.kind === 'deployment') return { outcome: { status: 'fail', code: 'KEY_MISSING', remedy: 'DEPLOYMENT_KEY_MISSING' }, auth: null };
        // Only the caller's own tier is named; whether the deployment holds a key it does not share is never said.
        if (!s.allowUserKeys && st.tiers.user) return { outcome: { status: 'fail', code: 'USER_KEYS_NOT_ALLOWED' }, auth: null };
        return { outcome: { status: 'fail', code: 'KEY_MISSING' }, auth: null };
      }
      const r = await this.credentials.resolve(ref, who, { allowTiers: tiers });
      if (!r) return { outcome: { status: 'fail', code: 'KEY_MISSING', remedy: scope.kind === 'deployment' ? 'DEPLOYMENT_KEY_MISSING' : 'KEY_MISSING' }, auth: null };
      const data = { tier: r.tier, binding: st.binding };
      const auth: ProviderAuth = { kind: 'api_key', key: r.value };
      if (scope.kind === 'deployment' && !s.shareDeploymentKey) return { outcome: { status: 'warn', code: 'DEPLOYMENT_KEY_NOT_SHARED', data }, auth };
      return { outcome: { status: 'pass', data }, auth };
    } catch {
      return { outcome: { status: 'fail', code: 'SECRETS_PROVIDER_UNAVAILABLE' }, auth: null };
    }
  }

  private async limits(scope: SearchDiagnosticScope, s: ResolvedWebSearchSystemSettings, counted: string): Promise<StageOutcome> {
    const limit = s.limits.perUserPerDay;
    if (scope.kind === 'deployment') {
      // The per-day limit is per user: the deployment's report says what it is, not anyone's count.
      return { status: 'pass', data: limit === null ? { unlimited: true } : { limit } };
    }
    const calls = await this.usage.callsOn(counted, this.service.clock());
    if (limit === null) return { status: 'pass', data: { calls, unlimited: true } };
    if (calls >= limit) return { status: 'fail', code: 'LIMIT_REACHED', data: { calls, limit } };
    if (calls > limit * LIMIT_NEAR_RATIO) return { status: 'warn', code: 'LIMIT_NEAR', data: { calls, limit } };
    return { status: 'pass', data: { calls, limit } };
  }

  private async fetch(signal: AbortSignal): Promise<StageOutcome> {
    if (!this.fetchHook) return { status: 'skipped', data: { installed: false } };
    // Switched off by the administrator: nothing is read; the agent opens pages in the browser instead.
    if (!(await this.fetchHook.enabled())) return { status: 'skipped', code: 'FETCH_OFF' };
    try {
      await this.fetchHook.read(FETCH_CHECK_URL, signal);
      return { status: 'pass', data: { host: FETCH_CHECK_HOST } };
    } catch (e) {
      const code = isWebToolError(e) && (e.code === 'BLOCKED' || e.code === 'NOT_ALLOWED') ? 'BLOCKED' : 'UNAVAILABLE';
      return { status: 'fail', code, remedy: code === 'BLOCKED' ? 'BLOCKED' : 'FETCH_UNAVAILABLE', data: { host: FETCH_CHECK_HOST } };
    }
  }
}
