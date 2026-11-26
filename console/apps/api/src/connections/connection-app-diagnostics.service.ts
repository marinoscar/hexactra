// Diagnostics of the deployment's app at Google or Microsoft (E50.11, #981), with no user: the administrator tests the client id, the
// secret and the redirect address BEFORE anyone connects.
//
//   1. `app_config`  the code is installed, a client id and a secret are set; the switch off only warns (`PROVIDER_OFF`: the app can be
//                    tested before it is switched on). Its data: the client id's last four characters, never more, never the secret;
//   2. the adapter's `diagnoseApp`: `redirect_uri`, `discovery`, `client_check`, and its own (Google: `picker_key`).
//
// A report is stored in the history with target kind `provider_app`, the provider as its id and no user. Read calls only: the
// `client_check` presents a deliberately invalid code, so nothing is issued. `stages()` returns the same stages without storing them,
// for the Doctor check of E50.13; the provider modules also register each provider's `Diagnosable` with the `DiagnosticsRegistry`.
import { Injectable, Logger } from '@nestjs/common';

import { DiagnosticsHistory, type StoredDiagnosticReport } from '../diagnostics/diagnostics-history.service';
import { DiagnosticsMetrics } from '../diagnostics/diagnostics.metrics';
import { overall, sanitizeStages, type Diagnosable, type DiagnosticStage, type DiagnosticTrigger } from '../diagnostics/diagnostic-report';
import { REMEDY_CODES } from '../diagnostics/remedies';
import { runStages, type StageOutcome } from '../diagnostics/stages';
import { ConnectionApps } from './connection-apps.service';
import { ConnectionProviderRegistry } from './connection-provider.registry';
import type { ConnectionProviderId } from './connections.constants';
import { clientIdEnd } from './oauth-diagnostics';

export const APP_REPORT_DEADLINE_MS = 20_000;
export const APP_STAGE_DEADLINE_MS = 8_000;

/** The stages every provider's `diagnoseApp` returns: shown as `skipped` when `app_config` failed. */
export const APP_STAGE_IDS = ['redirect_uri', 'discovery', 'client_check'] as const;
/** The console's own codes of a provider-app report. */
export const APP_CONFIG_CODES: readonly string[] = ['NOT_INSTALLED', 'APP_NOT_CONFIGURED', 'PROVIDER_OFF', 'UNAVAILABLE', 'TIMEOUT', 'ABORTED', 'DEADLINE_EXCEEDED', 'UNKNOWN'];

export interface AppDiagnoseOptions {
  /** The request's abort. */
  signal?: AbortSignal;
  /** The public address the administrator reached the console on (`https://console.example.test`). */
  publicOrigin?: string | null;
}

/** What a registered provider-app `Diagnosable` gets. */
export interface ProviderAppDiagnosticTarget {
  provider: ConnectionProviderId;
  publicOrigin?: string | null;
}

@Injectable()
export class ConnectionAppDiagnostics {
  private readonly log = new Logger(ConnectionAppDiagnostics.name);
  reportDeadlineMs = APP_REPORT_DEADLINE_MS;
  stageDeadlineMs = APP_STAGE_DEADLINE_MS;
  clock: () => number = Date.now;

  constructor(
    private readonly apps: ConnectionApps,
    private readonly adapters: ConnectionProviderRegistry,
    private readonly history: DiagnosticsHistory,
    private readonly metrics: DiagnosticsMetrics,
  ) {}

  /** Every code a provider-app report of this provider can carry (each has a remedy entry). */
  codes(provider: ConnectionProviderId): string[] {
    return [...new Set([...APP_CONFIG_CODES, ...(this.adapters.get(provider)?.appDiagnosticCodes ?? [])])];
  }

  /** The `Diagnosable` a provider module registers with the `DiagnosticsRegistry` (kind `provider_app`). */
  diagnosable(provider: ConnectionProviderId): Diagnosable<ProviderAppDiagnosticTarget> {
    return {
      codes: this.codes(provider),
      diagnose: (target, ctx) => this.stages(target.provider, { signal: ctx.signal, publicOrigin: target.publicOrigin }),
    };
  }

  /**
   * The stages of the deployment's app, sanitized, NOT stored: what the Doctor check of E50.13 shows. Never throws for a provider
   * answer; a provider not installed is one failed `app_config` stage.
   */
  async stages(provider: ConnectionProviderId, opts: AppDiagnoseOptions = {}): Promise<DiagnosticStage[]> {
    const deadline = AbortSignal.timeout(this.reportDeadlineMs);
    const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
    const base = { signal, stageTimeoutMs: this.stageDeadlineMs, abortCode: () => (opts.signal?.aborted ? 'ABORTED' : 'DEADLINE_EXCEEDED'), errorCode: () => 'UNAVAILABLE', clock: this.clock };
    const adapter = this.adapters.get(provider);

    const [config] = await runStages([{ id: 'app_config', run: () => this.appConfig(provider) }], base);
    const all: DiagnosticStage[] = [config!];
    if (config!.status === 'fail') {
      for (const id of APP_STAGE_IDS) all.push({ id, status: 'skipped', code: null, remedy: null, ms: null });
    } else if (adapter?.diagnoseApp) {
      let collected: DiagnosticStage[] | null = null;
      const [stage] = await runStages(
        [
          {
            id: 'provider',
            run: async (s) => {
              const app = await this.apps.app(provider, { ignoreSwitch: true });
              if (!app) return { status: 'fail', code: 'APP_NOT_CONFIGURED' };
              const pickerApiKey = provider === 'google' ? (await this.apps.system()).google.pickerApiKey : null;
              collected = await adapter.diagnoseApp!({ app, publicOrigin: opts.publicOrigin ?? null, pickerApiKey, signal: s });
              return { status: 'pass' };
            },
          },
        ],
        { ...base, stageTimeoutMs: this.reportDeadlineMs },
      );
      all.push(...(stage!.status === 'pass' && collected ? (collected as DiagnosticStage[]) : [stage!]));
    }
    const { stages, dropped } = sanitizeStages(all, new Set(this.codes(provider)), REMEDY_CODES);
    if (dropped > 0) this.log.warn(`provider app diagnostic: ${dropped} data value(s) refused and dropped (provider ${provider})`);
    return stages;
  }

  /** `POST /connections/admin/apps/{provider}/diagnose`: runs the report, stores it (no user) and returns it. */
  async diagnose(provider: ConnectionProviderId, trigger: DiagnosticTrigger, opts: AppDiagnoseOptions = {}): Promise<StoredDiagnosticReport> {
    const startedAt = new Date(this.clock()).toISOString();
    const stages = await this.stages(provider, opts);
    const report = { target: { kind: 'provider_app' as const, id: provider }, trigger, overall: overall(stages), startedAt, finishedAt: new Date(this.clock()).toISOString(), stages };
    const stored = await this.history.record(report, null);
    this.metrics.run('provider_app', provider, report.overall);
    return stored;
  }

  /** The last reports of a provider's app, newest first. */
  historyOf(provider: ConnectionProviderId, limit?: number): Promise<StoredDiagnosticReport[]> {
    return this.history.listUnowned('provider_app', provider, limit);
  }

  private async appConfig(provider: ConnectionProviderId): Promise<StageOutcome> {
    if (!this.adapters.has(provider)) return { status: 'fail', code: 'NOT_INSTALLED' };
    this.apps.invalidate();
    const s = (await this.apps.system())[provider];
    const hasSecret = await this.apps.hasSecret(provider);
    const end = s.clientId ? clientIdEnd(s.clientId) : null;
    const data = { client_id_set: Boolean(s.clientId), secret_set: hasSecret, enabled: s.enabled, ...(end ? { client_id_end: end } : {}) };
    if (!s.clientId || !hasSecret) return { status: 'fail', code: 'APP_NOT_CONFIGURED', data };
    if (!s.enabled) return { status: 'warn', code: 'PROVIDER_OFF', data };
    return { status: 'pass', data };
  }
}
