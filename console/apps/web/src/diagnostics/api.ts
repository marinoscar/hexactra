// The wire shapes and calls of diagnostics (E50.10, #980; panel E50.14, #984). A report holds codes, remedy keys, counts, timings and
// host names: never content, an address, an account or a key. One panel serves a connection, a provider app and a search provider.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

export type StageStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export interface DiagnosticStage {
  /** `status`, `sign_in`, `capability:mail_read`, `server`, `live_query`, ... */
  id: string;
  status: StageStatus;
  /** A closed code (`GRANT_REVOKED`), never provider text. */
  code: string | null;
  /** A key of the remedy table (`packages/shared/diagnostics.json`). */
  remedy: string | null;
  ms: number | null;
  data?: Record<string, string | number | boolean>;
}

export interface DiagnosticReport {
  id: string;
  target: { kind: 'connection' | 'provider_app' | 'search_provider'; id: string };
  trigger: 'owner' | 'admin' | 'cli' | 'health_job';
  overall: StageStatus;
  startedAt: string;
  finishedAt: string;
  stages: DiagnosticStage[];
}

/** The last result of one of the owner's connections ("Working · checked 2 h ago"). */
export interface DiagnosticSummary {
  targetId: string;
  overall: StageStatus;
  at: string;
}

/** What the panel checks. `name` is shown in the panel's title only: it never goes into a copied report. */
export type DiagnosticTarget =
  | { kind: 'connection'; id: string; provider: 'google' | 'microsoft' | 'mcp'; capabilities: readonly string[]; name: string; host?: string | null }
  | { kind: 'provider_app'; provider: 'google' | 'microsoft'; name: string; host?: string | null }
  | { kind: 'search_provider'; id: string; scope: 'user' | 'deployment'; name: string };

/** The provider a report is about, for the copied report: `google`, `mcp`, `brave`. */
export function providerOf(t: DiagnosticTarget): string {
  return t.kind === 'search_provider' ? t.id : t.provider;
}

const HISTORY = 5;

/** Runs a new report (one request; the stages come back together). */
export function diagnose(api: PlatformApiClient, t: DiagnosticTarget): Promise<DiagnosticReport> {
  switch (t.kind) {
    case 'connection':
      return api.post<DiagnosticReport>(`/connections/${t.id}/diagnose`, {});
    case 'provider_app':
      return api.post<DiagnosticReport>(`/connections/admin/apps/${t.provider}/diagnose`, {});
    case 'search_provider':
      return t.scope === 'deployment'
        ? api.post<DiagnosticReport>(`/web-search/admin/providers/${t.id}/diagnose`, {})
        : api.post<DiagnosticReport>(`/web-search/diagnose?provider=${encodeURIComponent(t.id)}`, {});
  }
}

/** The last five reports of the target, newest first. */
export async function historyOf(api: PlatformApiClient, t: DiagnosticTarget): Promise<DiagnosticReport[]> {
  switch (t.kind) {
    case 'connection':
      return api.get<DiagnosticReport[]>(`/connections/${t.id}/diagnostics?limit=${HISTORY}`);
    case 'provider_app':
      return api.get<DiagnosticReport[]>(`/connections/admin/apps/${t.provider}/diagnostics?limit=${HISTORY}`);
    case 'search_provider': {
      if (t.scope === 'deployment') return api.get<DiagnosticReport[]>(`/web-search/admin/providers/${t.id}/diagnostics?limit=${HISTORY}`);
      // The user's history holds every provider: keep this one's.
      const all = await api.get<DiagnosticReport[]>(`/web-search/diagnostics?limit=20`);
      return all.filter((r) => r.target.id === t.id || r.target.id.endsWith(`:${t.id}`)).slice(0, HISTORY);
    }
  }
}

export const getDiagnosticSummary = (api: PlatformApiClient) => api.get<DiagnosticSummary[]>('/connections/diagnostics/summary');
