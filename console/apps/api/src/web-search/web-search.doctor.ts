// The Doctor's view of web search (E50.5, #975; E50.13, #983). Read-only, as the Doctor requires: settings, whether the deployment's
// key exists (its row, never its value), the last DEPLOYMENT report in `connection_diagnostics` and yesterday's usage totals. No call
// to a provider, no write, no audit row, no job, nothing that identifies a user or a query. Doctor never runs a live query: the remedy
// sends the administrator to Test on the settings page.
//
//   web_search.provider   pass: a provider is usable for the deployment tier and its last deployment report passed (or search is off)
//                         warn: no deployment key (users need their own), the last report warned, is older than 30 days or missing,
//                               or yesterday's failures were over 20% of calls
//                         fail: a key is set and the last report failed
import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import { DoctorCheckRegistry, EgressRegistry, egressDependency, type DoctorCheck, type DoctorCheckOutcome, type EgressContributor, type EgressDependency } from '@marinoscar/platform-api/doctor';

import { DiagnosticsHistory } from '../diagnostics/diagnostics-history.service';
import { SERVICE_CREDENTIAL_PURPOSE } from '../service-credentials/service-credentials.credentials';
import { storedName } from '../service-credentials/service-credential.port';
import { credentialRefOf, SearchProviderRegistry, type SearchProvider } from './search-provider';
import { FETCH_CHECK_HOST } from './web-search-diagnostics';
import { providerSettingsOf, type ResolvedWebSearchSystemSettings } from './web-search.settings';
import { WebSearchService } from './web-search.service';
import { isoDay, utcDay, WebSearchUsage } from './web-search.usage';

/** Where an administrator configures web search. */
export const WEB_SEARCH_SETTINGS_PATH = '/admin/settings/web-search';
/** A deployment report older than this warns. */
export const REPORT_STALE_DAYS = 30;
/** Yesterday's failures over this share of calls warn. */
export const FAILURE_RATE_WARN = 0.2;

const DAY_MS = 86_400_000;

@Injectable()
export class WebSearchProviderCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'web_search.provider';
  readonly label = 'Web search provider';
  readonly category = 'web_search';
  readonly settingsPath = WEB_SEARCH_SETTINGS_PATH;

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  constructor(
    private readonly doctor: DoctorCheckRegistry,
    private readonly registry: SearchProviderRegistry,
    private readonly service: WebSearchService,
    private readonly history: DiagnosticsHistory,
    private readonly usage: WebSearchUsage,
    @Optional() private readonly systemCredentials?: CredentialsService,
  ) {}

  onModuleInit(): void {
    this.doctor.register(this);
  }

  /** Whether the provider can answer with the deployment tier: a stored deployment key (its row only), an address, or AI. */
  private async deploymentUsable(p: SearchProvider, s: ResolvedWebSearchSystemSettings): Promise<boolean> {
    if (p.credential === 'none') return !!providerSettingsOf(s, p.id).baseUrl;
    if (p.credential === 'ai_service') return true;
    return (await this.systemCredentials?.describe(SERVICE_CREDENTIAL_PURPOSE, storedName(credentialRefOf(p.id)))) != null;
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      this.service.invalidate();
      const s = await this.service.system();
      if (!s.enabled) return { status: 'pass', detail: 'Web search is switched off for the deployment; the agent searches in the browser.', data: { enabled: false } };
      const listed = s.order.map((id) => this.registry.get(id)).filter((p): p is SearchProvider => !!p && providerSettingsOf(s, p.id).enabled);
      if (listed.length === 0) {
        return { status: 'warn', detail: 'Web search is on but no installed provider is switched on and listed in the order.', remedy: 'Switch a provider on and put it in the order in Administration → Web search.', data: { enabled: true, providers: 0 } };
      }
      let usable: SearchProvider | null = null;
      for (const p of listed) {
        if (await this.deploymentUsable(p, s)) {
          usable = p;
          break;
        }
      }
      const yesterday = await this.yesterday();
      const data = { enabled: true, providers: listed.length, deploymentKey: usable !== null, shared: s.shareDeploymentKey, userKeys: s.allowUserKeys, callsYesterday: yesterday.calls, failuresYesterday: yesterday.failures };
      if (!usable) {
        return {
          status: 'warn',
          detail: s.allowUserKeys ? 'Web search is on but no deployment key is set: each user needs their own key.' : 'Web search is on but no deployment key is set, and users may not use their own: nobody can search.',
          remedy: 'Set the deployment key in Administration → Web search, then press Test.',
          data,
        };
      }
      const last = await this.history.lastDeployment('search_provider', usable.id);
      const label = usable.label;
      if (last?.overall === 'fail') {
        return { status: 'fail', detail: `The last deployment test of ${label} failed.`, remedy: 'Open Administration → Web search, read the failed stage and press Test again after fixing it.', data: { ...data, provider: usable.id, lastReport: 'fail' } };
      }
      const ageDays = last ? Math.floor((this.clock() - Date.parse(last.at)) / DAY_MS) : null;
      const withLast = { ...data, provider: usable.id, lastReport: last?.overall ?? 'none', lastReportDays: ageDays };
      if (!last) return { status: 'warn', detail: `${label} has a deployment key but was never tested.`, remedy: 'Press Test in Administration → Web search (one search, counted as a call).', data: withLast };
      if (last.overall === 'warn') return { status: 'warn', detail: `The last deployment test of ${label} warned.`, remedy: 'Open Administration → Web search and read the stage that warned.', data: withLast };
      if (ageDays !== null && ageDays > REPORT_STALE_DAYS) return { status: 'warn', detail: `The last deployment test of ${label} is ${ageDays} days old.`, remedy: 'Press Test in Administration → Web search.', data: withLast };
      if (yesterday.calls > 0 && yesterday.failures / yesterday.calls > FAILURE_RATE_WARN) {
        return { status: 'warn', detail: `${yesterday.failures} of yesterday's ${yesterday.calls} searches failed.`, remedy: 'Press Test in Administration → Web search to see which stage fails.', data: withLast };
      }
      return { status: 'pass', detail: `${label} answers with the deployment key${s.shareDeploymentKey ? '' : ' (not shared with users)'}; its last test passed.`, data: withLast };
    } catch {
      return { status: 'fail', detail: 'The check could not run.', remedy: 'Look at the API log for the web search check.' };
    }
  }

  /** Yesterday's (UTC) calls and failures, every provider together. */
  private async yesterday(): Promise<{ calls: number; failures: number }> {
    const now = new Date(this.clock());
    const day = isoDay(new Date(utcDay(now).getTime() - DAY_MS));
    const rows = (await this.usage.totals(now, 2)).filter((r) => r.day === day);
    return { calls: rows.reduce((a, r) => a + r.calls, 0), failures: rows.reduce((a, r) => a + r.failures, 0) };
  }
}

/**
 * The egress list's view of web search (E50.5): one dependency per installed provider, with its hosts and the fixed page host of the
 * diagnostics' `fetch` stage (E50.13). No call to a provider, no key, nothing that identifies a user.
 */
@Injectable()
export class WebSearchEgressContributor implements EgressContributor, OnModuleInit {
  readonly id = 'web_search';

  constructor(
    private readonly egress: EgressRegistry,
    private readonly registry: SearchProviderRegistry,
    private readonly service: WebSearchService,
  ) {}

  onModuleInit(): void {
    this.egress.register(this);
  }

  async describe(): Promise<EgressDependency[]> {
    const s = await this.service.system();
    return this.registry.list().map((p) => {
      const ps = providerSettingsOf(s, p.id);
      return egressDependency({
        id: `web_search.${p.id}`,
        capability: `Web search (${p.label})`,
        direction: 'server',
        enabled: s.enabled && ps.enabled && s.order.includes(p.id),
        required: false,
        hosts: [...(p.credential === 'none' ? [ps.baseUrl ?? ''] : p.hosts), FETCH_CHECK_HOST],
        degradation: 'The agent searches in the browser instead',
        settingsPath: WEB_SEARCH_SETTINGS_PATH,
      });
    });
  }
}
