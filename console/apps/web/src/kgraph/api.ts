// The Knowledge Graph's client (E46.20, #794): the routes of apps/api/src/kgraph/*.controller.ts, as the pages read them.
// Every label in an answer is masked by the API (a saved login by its label, a sensitive parameter by its name); the pages render
// each one as plain text.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

export type KgMode = 'off' | 'learn' | 'reuse';
export type KgHealth = 'healthy' | 'degraded' | 'failing' | 'unknown';
export type KgVersionState = 'candidate' | 'verified' | 'active' | 'suspended' | 'retired' | 'rejected';
export type KgChangeClass = 'initial' | 'structural' | 'sensitive';
export type KgStepHow = 'replayed' | 'recovered' | 'judged' | 'agent' | 'not_reached';

/** `GET /api/kgraph/status`. */
export interface KgStatus {
  deployment: boolean;
  user: boolean;
  available: boolean;
}

/** `GET|PUT /api/tasks/{id}/kgraph`. */
export interface TaskKgraph {
  taskId: string;
  mode: KgMode;
  available: boolean;
}

export interface KgCounts {
  successes: number;
  failures: number;
  repairs: number;
}

export interface KgProcedureItem {
  id: string;
  taskId: string;
  taskName: string;
  name: string;
  versionId: string | null;
  versionNumber: number | null;
  state: KgVersionState | null;
  health: KgHealth;
  steps: number;
  updatedAt: string;
  ledger: { runs: number; procedureRuns: number; cleanReplayRate: number | null };
}

export interface KgStepArg {
  name: string;
  source: 'literal' | 'parameter' | 'output' | 'judge' | 'secret';
  detail: string | null;
}

export interface KgStep {
  id: string;
  kind: string;
  label: string;
  tool: string | null;
  target: string | null;
  usesAi: boolean;
  commitClass: boolean;
  health: KgHealth;
  counts: KgCounts;
  args: KgStepArg[];
}

export interface KgVersionDetail {
  id: string;
  number: number;
  state: KgVersionState;
  changeClass: KgChangeClass;
  parentId: string | null;
  sourceRunId: string | null;
  createdAt: string;
  health: KgHealth;
  counts: KgCounts;
  steps: KgStep[];
  parameters: { name: string; type: string; sensitive: boolean; required: boolean }[];
  outputs: { name: string; sensitive: boolean }[];
  sites: string[];
  accounts: { connectionId: string; provider: string }[];
  savedLogins: { kind: 'login' | 'identity' | 'card'; label: string }[];
}

export interface KgProcedureDetail extends KgProcedureItem {
  enabled: boolean;
  activeVersion: KgVersionDetail | null;
  versions: number;
}

export interface KgVersionItem {
  id: string;
  number: number;
  state: KgVersionState;
  changeClass: KgChangeClass;
  parentId: string | null;
  sourceRunId: string | null;
  createdAt: string;
  health: KgHealth;
  counts: KgCounts;
  steps: number;
}

interface KgDiffStep {
  id: string;
  kind: string;
  label: string;
  tool: string | null;
}

export interface KgDiff {
  enabled: boolean;
  procedureId: string;
  from: number | null;
  to: number;
  changes: { change: 'unchanged' | 'relocated' | 'inserted' | 'removed' | 'rebound' | 'retargeted'; before: KgDiffStep | null; after: KgDiffStep | null; args: string[]; text: string }[];
}

/** `GET /api/kgraph/runs/{runId}`. */
export interface KgRun {
  enabled: boolean;
  runId: string;
  taskId: string | null;
  mode: KgMode;
  aiOnly: boolean;
  outcome: string | null;
  procedureId: string | null;
  versionId: string | null;
  versionNumber: number | null;
  steps: { id: string; kind: string; label: string; tool: string | null; how: KgStepHow }[];
  ledger: { replayed: number; recovered: number; judge: number; agent: number } | null;
  /** The site facts the run used (#854). Absent from a console without it: the run page then shows no list. */
  kgFactIds?: readonly string[] | null;
}

export type KgReviewStatus = 'pending' | 'approved' | 'declined' | 'expired';
export interface KgReview {
  id: string;
  versionId: string;
  procedureId: string | null;
  status: KgReviewStatus;
  changes: { reason: string; text: string }[];
  createdAt: string;
  expiresAt: string;
}

interface Figures {
  runs: number;
  modelCalls: number;
  costUsd: number;
  costKnown: boolean;
  activeMs: number;
}
export interface KgTaskSummary {
  taskId: string;
  taskName: string;
  runs: number;
  procedureRuns: number;
  cleanReplayRate: number | null;
  baseline: Figures | null;
  note: string | null;
  procedureFigures: Figures | null;
  saving: { modelCalls: number; costUsd: number; costKnown: boolean; activeMs: number } | null;
}

/** `GET /api/kgraph/graph`: the Map's view model (`@marinoscar/hexactra-kgraph/view`), every label masked by the API. */
export type KgViewNodeType = 'Procedure' | 'Step' | 'Site' | 'Account' | 'Tool' | 'SecretRef' | 'Parameter' | 'Output';
export type KgViewEdgeType = 'has' | 'then' | 'feeds' | 'uses';
export interface KgViewNode {
  id: string;
  type: KgViewNodeType;
  label: string;
  health: KgHealth;
  counts: KgCounts & { uses: number };
  /** A connected account, added tool or saved login that no procedure uses yet. */
  unused: boolean;
  /** `site:<domain>` or `account:<connection id>`. */
  cluster: string | null;
  /** The procedure node (`procedure:<id>`) a step, parameter or output belongs to. */
  procedure: string | null;
}
export interface KgViewEdge {
  type: KgViewEdgeType;
  from: string;
  to: string;
}
export interface KgGraph {
  enabled: boolean;
  nodes: KgViewNode[];
  edges: KgViewEdge[];
  clusters: { id: string; kind: 'site' | 'account'; label: string; nodes: string[] }[];
  collapsed: boolean;
  truncated: boolean;
  totalNodes: number;
  nodeLimit: number;
  nextCursor: number | null;
}

/** The deployment settings (`kgraph` of the system settings). */
export interface KgAdminSettings {
  enabled: boolean;
  auditEvery: number;
  suspendAfterFailures: number;
  retentionDays: number | null;
  pacing: 'human' | 'fast';
}

export const getKgStatus = (api: PlatformApiClient) => api.get<KgStatus>('/kgraph/status');
export const getTaskKgraph = (api: PlatformApiClient, taskId: string) => api.get<TaskKgraph>(`/tasks/${taskId}/kgraph`);
export const putTaskKgraph = (api: PlatformApiClient, taskId: string, mode: KgMode) => api.put<TaskKgraph>(`/tasks/${taskId}/kgraph`, { mode });
export const listProcedures = (api: PlatformApiClient) => api.get<{ enabled: boolean; procedures: KgProcedureItem[] }>('/kgraph/procedures');
export const getProcedure = (api: PlatformApiClient, id: string) => api.get<KgProcedureDetail>(`/kgraph/procedures/${encodeURIComponent(id)}`);
export const listVersions = (api: PlatformApiClient, id: string) => api.get<{ enabled: boolean; procedureId: string; versions: KgVersionItem[] }>(`/kgraph/procedures/${encodeURIComponent(id)}/versions`);
export const getVersionDiff = (api: PlatformApiClient, id: string, version: number) => api.get<KgDiff>(`/kgraph/procedures/${encodeURIComponent(id)}/versions/${version}/diff`);
export const getKgRun = (api: PlatformApiClient, runId: string) => api.get<KgRun>(`/kgraph/runs/${runId}`);
export const listReviews = (api: PlatformApiClient, status?: KgReviewStatus) => api.get<KgReview[]>(status ? `/kgraph/reviews?status=${status}` : '/kgraph/reviews');
/** Answered only from a signed-in browser session: the API refuses a token, an OAuth app or MCP (`403 KGRAPH_REVIEW_CONSOLE_ONLY`). */
export const answerReview = (api: PlatformApiClient, id: string, approve: boolean) => api.post<KgReview>(`/kgraph/reviews/${id}/answer`, { approve });
/** The Map's view model; `cursor` is the previous page's `nextCursor` (the API folds and pages above 2,000 nodes). */
export const getKgGraph = (api: PlatformApiClient, cursor?: number) => api.get<KgGraph>(cursor ? `/kgraph/graph?cursor=${cursor}` : '/kgraph/graph');
export const getKgSummary = (api: PlatformApiClient) => api.get<{ tasks: KgTaskSummary[] }>('/kgraph/summary');
export const restoreVersion = (api: PlatformApiClient, procedureId: string, versionId: string) => api.post<{ procedureId: string; restoredFrom: string; versionId: string }>(`/kgraph/procedures/${encodeURIComponent(procedureId)}/restore`, { versionId });
export const forgetProcedure = (api: PlatformApiClient, procedureId: string) => api.post<{ procedureId: string; retired: number }>(`/kgraph/procedures/${encodeURIComponent(procedureId)}/forget`, {});
export const purgeKgraph = (api: PlatformApiClient) => api.delete<{ deleted: Record<string, number> }>('/kgraph');
export const getKgAdminSettings = (api: PlatformApiClient) => api.get<KgAdminSettings>('/admin/kgraph/settings');
export const putKgAdminSettings = (api: PlatformApiClient, body: Partial<KgAdminSettings>) => api.put<KgAdminSettings>('/admin/kgraph/settings', body);
/** The owner's own switch: `kgraph.enabled` of the user settings (the CLI's `kgraph on` and `off` do the same). */
export const setKgUserSwitch = (api: PlatformApiClient, enabled: boolean) => api.patch<unknown>('/user-settings', { kgraph: { enabled } });

// ---------------------------------------------------------------- site facts (phase 5, E46.31 and E46.33)

/** What a fact is about (`SITE_FACT_KINDS` of `@marinoscar/hexactra-kgraph`). */
export const SITE_FACT_KINDS = ['navigation', 'sign_in', 'quirk', 'timing', 'other'] as const;
export type KgSiteFactKind = (typeof SITE_FACT_KINDS)[number];
export type KgSiteFactSource = 'owner' | 'derived' | 'agent_proposed';
export type KgSiteFactStatus = 'proposed' | 'active' | 'archived';
/** The longest text a fact may have. */
export const SITE_FACT_MAX_TEXT = 300;

/** One fact, as the API shows it. Its text is data about the site; the pages render it as text. */
export interface KgSiteFact {
  id: string;
  site: string;
  kind: KgSiteFactKind;
  text: string;
  source: KgSiteFactSource;
  status: KgSiteFactStatus;
  /** What a proposal came from: the run and how many of its calls and screens. */
  evidence: { runId: string | null; steps: number; screens: number };
  declinedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
/** `GET /api/kgraph/sites`. */
export interface KgSiteSummary {
  site: string;
  active: number;
  proposed: number;
  archived: number;
}

const sitePath = (site: string) => `/kgraph/sites/${encodeURIComponent(site)}/facts`;
export const listKgSites = (api: PlatformApiClient) => api.get<KgSiteSummary[]>('/kgraph/sites');
export const listSiteFacts = (api: PlatformApiClient, site: string, status?: KgSiteFactStatus) => api.get<KgSiteFact[]>(status ? `/kgraph/sites/${encodeURIComponent(site)}/facts?status=${status}` : sitePath(site));
/** Active at once: the owner's own words. `422 KGRAPH_SITE_FACT_REFUSED` (with `details.rules`) for a secret, an instruction or another site. */
export const createSiteFact = (api: PlatformApiClient, site: string, body: { kind: KgSiteFactKind; text: string }) => api.post<KgSiteFact>(`/kgraph/sites/${encodeURIComponent(site)}/facts`, body);
export const updateSiteFact = (api: PlatformApiClient, id: string, body: { kind?: KgSiteFactKind; text?: string; status?: 'active' | 'archived' }) => api.patch<KgSiteFact>(`/kgraph/site-facts/${encodeURIComponent(id)}`, body);
export const deleteSiteFact = (api: PlatformApiClient, id: string) => api.delete<void>(`/kgraph/site-facts/${encodeURIComponent(id)}`);
export const listSiteFactReviews = (api: PlatformApiClient) => api.get<KgSiteFact[]>('/kgraph/reviews/site-facts');
/** Answered only from a signed-in browser session (`403 KGRAPH_REVIEW_CONSOLE_ONLY` otherwise). `kind` and `text` approve with the owner's edit. */
export const answerSiteFactReview = (api: PlatformApiClient, id: string, body: { approve: boolean; kind?: KgSiteFactKind; text?: string }) =>
  api.post<KgSiteFact>(`/kgraph/reviews/site-facts/${encodeURIComponent(id)}/answer`, body);
/** The Sites tab, optionally on one site. */
export const sitesTabPath = (site?: string) => (site ? `/kgraph?tab=sites&site=${encodeURIComponent(site)}` : '/kgraph?tab=sites');
