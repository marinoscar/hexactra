// THE client of the agent policy feature (epic #398): every HTTP call the
// policy pages, the task form, the schedule editor and "Run with..." make is a
// typed function here, so a change of a route or a field name is one edit.
//
// Routes (all relative to `/api`):
// - `/agent-policies` CRUD, duplicate, `/default` (#401);
// - `/agent-policies/export`, `/agent-policies/import` (#402);
// - `/agent-policies/model-tiers/effective` (#403);
// - `/system-settings` namespaces `agentPricing` (#400), `browserAgentTiers`
//   (#403) and `browserAgentCeilings` (#404), and the `browserAgent.tiers` field
//   of `/user-settings` (#403): the platform's settings routes.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

import type {
  AgentPolicy,
  AgentPolicySpec,
  AgentPricing,
  AgentSystemSettings,
  BudgetCeilings,
  ConflictMode,
  DefaultPolicy,
  EffectiveTiers,
  ImportResult,
  ModelTiers,
  ModelTiersOverride,
} from './types';

const enc = encodeURIComponent;

// ---- Policies (#401) ----

export function listPolicies(api: PlatformApiClient): Promise<AgentPolicy[]> {
  return api.get<AgentPolicy[]>('/agent-policies');
}

export function getPolicy(api: PlatformApiClient, id: string): Promise<AgentPolicy> {
  return api.get<AgentPolicy>(`/agent-policies/${id}`);
}

export function getDefaultPolicy(api: PlatformApiClient): Promise<DefaultPolicy> {
  return api.get<DefaultPolicy>('/agent-policies/default');
}

/** `null` goes back to the system default (Balanced). */
export function setDefaultPolicy(api: PlatformApiClient, policyId: string | null): Promise<DefaultPolicy> {
  return api.put<DefaultPolicy>('/agent-policies/default', { policyId });
}

export interface PolicyInput {
  name: string;
  description: string | null;
  spec: AgentPolicySpec;
}

export function createPolicy(api: PlatformApiClient, input: PolicyInput): Promise<AgentPolicy> {
  return api.post<AgentPolicy>('/agent-policies', input);
}

/** A conditional edit: `If-Match: <version>`; a stale version answers 412 `POLICY_VERSION_CONFLICT`. */
export function updatePolicy(api: PlatformApiClient, id: string, patch: Partial<PolicyInput>, version: number): Promise<AgentPolicy> {
  return api.patch<AgentPolicy>(`/agent-policies/${id}`, patch, { ifMatch: String(version) });
}

/** 409 `POLICY_IN_USE` (details: the tasks and schedules) unless `reassignTo` names their new policy. */
export function deletePolicy(api: PlatformApiClient, id: string, reassignTo?: string): Promise<void> {
  const query = reassignTo ? `?reassignTo=${enc(reassignTo)}` : '';
  return api.delete<void>(`/agent-policies/${id}${query}`);
}

export function duplicatePolicy(api: PlatformApiClient, id: string, name: string): Promise<AgentPolicy> {
  return api.post<AgentPolicy>(`/agent-policies/${id}/duplicate`, { name });
}

// ---- Export and import (#402) ----

export interface ExportedFile {
  blob: Blob;
  filename: string;
}

/** `ids`: `'all'` or policy ids. The response is the file itself (no envelope), with its name in `Content-Disposition`. */
export async function exportPolicies(api: PlatformApiClient, ids: 'all' | readonly string[], includePins: boolean): Promise<ExportedFile> {
  if (!api.getBlob) throw new Error('This client cannot download files');
  const list = ids === 'all' ? 'all' : ids.map(enc).join(',');
  const res = await api.getBlob(`/agent-policies/export?ids=${list}&includePins=${includePins ? 'true' : 'false'}`);
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `agent-policies-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.json`;
  return { blob: res.blob, filename };
}

/** Atomic: an invalid file answers 400 `POLICY_IMPORT_INVALID` and nothing is created. */
export function importPolicies(api: PlatformApiClient, file: unknown, onConflict: ConflictMode): Promise<ImportResult> {
  return api.post<ImportResult>('/agent-policies/import', { file, onConflict });
}

// ---- Model tiers (#403) ----

/** The caller's resolved tiers, with where each value came from. */
export async function getEffectiveTiers(api: PlatformApiClient, policyId?: string): Promise<EffectiveTiers> {
  // The route answers `{ policy, tiers }` (#403): the tiers a run of that policy (default: the user's default) would use.
  const q = policyId ? `?policyId=${encodeURIComponent(policyId)}` : '';
  const res = await api.get<{ policy: unknown; tiers: EffectiveTiers }>(`/agent-policies/model-tiers/effective${q}`);
  return res.tiers;
}

interface UserSettingsDoc {
  version: number;
  browserAgent?: { defaultPolicyRef?: string | null; tiers?: ModelTiersOverride } | null;
}

/** The user's own tier overrides (`browserAgent.tiers` of the user settings) and the document version. */
export async function getUserTiers(api: PlatformApiClient): Promise<{ tiers: ModelTiersOverride; version: number }> {
  const doc = await api.get<UserSettingsDoc>('/user-settings');
  return { tiers: doc.browserAgent?.tiers ?? {}, version: doc.version };
}

/**
 * Save the user's tier overrides. Per tier and per field; a `null` field clears
 * it (the tier then inherits that field from the deployment).
 */
export async function saveUserTiers(api: PlatformApiClient, tiers: ModelTiersOverride, version: number): Promise<{ tiers: ModelTiersOverride; version: number }> {
  const doc = await api.patch<UserSettingsDoc>('/user-settings', { browserAgent: { tiers } }, { ifMatch: String(version) });
  return { tiers: doc.browserAgent?.tiers ?? {}, version: doc.version };
}

// ---- System settings namespaces (#400, #403, #404) ----

export function getAgentSystemSettings(api: PlatformApiClient): Promise<AgentSystemSettings> {
  return api.get<AgentSystemSettings>('/system-settings');
}

type AgentNamespaces = {
  agentPricing: Pick<AgentPricing, 'models'>;
  browserAgentTiers: ModelTiers;
  browserAgentCeilings: BudgetCeilings;
};

/** The signed-in user's own model prices (`agentPricing` of `/user-settings`, #735) and the document version. */
export async function getUserModelPrices(api: PlatformApiClient): Promise<{ version: number; agentPricing?: Pick<AgentPricing, 'models'> }> {
  return api.get<{ version: number; agentPricing?: Pick<AgentPricing, 'models'> }>('/user-settings');
}

/** Saves the user's own prices (the whole table; an empty one clears them). `If-Match` is the document version. */
export async function patchUserModelPrices(api: PlatformApiClient, models: AgentPricing['models'], version: number): Promise<{ version: number; agentPricing?: Pick<AgentPricing, 'models'> }> {
  const value = Object.keys(models).length === 0 ? null : { models };
  return api.patch<{ version: number; agentPricing?: Pick<AgentPricing, 'models'> }>('/user-settings', { agentPricing: value }, { ifMatch: String(version) });
}

/** `PATCH /system-settings` with one namespace; `If-Match` is the document version (409 when it moved). */
export function patchAgentSystemSettings<K extends keyof AgentNamespaces>(
  api: PlatformApiClient,
  namespace: K,
  value: AgentNamespaces[K],
  version: number,
): Promise<AgentSystemSettings> {
  return api.patch<AgentSystemSettings>('/system-settings', { [namespace]: value }, { ifMatch: String(version) });
}

/**
 * The deployment's budget ceilings, for the policy editor's helper text. Only
 * a viewer who may read the system settings can see them; for anyone else this
 * resolves to null (there is no per-user ceilings route yet).
 */
export async function getCeilings(api: PlatformApiClient, canReadSystemSettings: boolean): Promise<BudgetCeilings | null> {
  if (!canReadSystemSettings) return null;
  try {
    return (await getAgentSystemSettings(api)).browserAgentCeilings ?? null;
  } catch {
    return null;
  }
}

// ---- Runs ("Run with...") ----

/** Run a saved task now, under `policyId` for this run only (or its usual policy when omitted), with values for its parameters (#552). */
export function runTaskWith(api: PlatformApiClient, taskId: string, policyId?: string, inputs?: Record<string, string>): Promise<{ id: string }> {
  return api.post<{ id: string }>(`/tasks/${taskId}/runs`, { ...(policyId ? { policyId } : {}), ...(inputs && Object.keys(inputs).length ? { inputs } : {}) });
}

// ---- Browser helpers ----

/** Save a downloaded file through the browser. */
export function saveFile({ blob, filename }: ExportedFile): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
