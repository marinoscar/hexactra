// The wire shapes and calls of web search (E50.5, #975; screens E50.14, #984). No response holds a key or any part of one: the keys
// go through `/api/service-credentials`, write-only.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

export type Tier = 'user' | 'organization' | 'system';
/** The service of every search provider's key (`web_search.<provider>`). */
export const SERVICE = 'web_search';

export interface WebSearchStatus {
  enabled: boolean;
  reason: 'disabled_by_admin' | 'disabled_by_you' | 'no_provider' | 'no_key' | null;
  provider: { id: string; label: string; tier: Tier | null } | null;
  today: { calls: number; limit: number | null; remaining: number | null };
  perRunLimit: number | null;
}

export interface WebSearchProvider {
  id: string;
  label: string;
  /** `ai_service`: answers through the AI settings' key (OpenAI web search, E50.9); no key field. */
  credential?: 'api_key' | 'none' | 'ai_service';
  needsKey: boolean;
  enabled: boolean;
  listed: boolean;
  keyTier: Tier | null;
  keys: Record<Tier, boolean>;
  estimatedCostPerCallUsd: number | null;
}

export interface SearchResult {
  provider: string;
  hits: { title: string; url: string; snippet: string }[];
  /** An answer-type provider's written answer (E50.9): third-party text, shown as text. */
  answer?: { text: string; citations: string[] } | null;
}

export interface AdminSettings {
  enabled: boolean;
  providers: Record<string, { enabled: boolean; costPerCallUsd: number | null; baseUrl: string | null; allowPrivate?: boolean; model?: string | null }>;
  order: string[];
  shareDeploymentKey: boolean;
  allowUserKeys: boolean;
  limits: { perRun: number | null; perUserPerDay: number | null; fetchPerRun?: number | null };
  fetch?: { enabled: boolean; blockedHosts: string[] };
  installed: { id: string; label: string; credential: string; hosts: string[]; defaultEstimatedCostPerCallUsd: number | null }[];
}

export interface UsageRow {
  day: string;
  provider: string;
  calls: number;
  failures: number;
  estimatedCostUsd: number;
}

/** One key reference as `/api/service-credentials` lists it: where it is kept and which tiers hold one. Never a value. */
export interface ServiceCredential {
  service: string;
  name: string;
  binding?: 'credential_store' | 'vault' | 'builtin';
  tiers: Record<Tier, { set: boolean; setAt?: string | null; available?: boolean }>;
}

export const getStatus = (api: PlatformApiClient) => api.get<WebSearchStatus>('/web-search/status');
export const listProviders = (api: PlatformApiClient) => api.get<WebSearchProvider[]>('/web-search/providers');
export const search = (api: PlatformApiClient, query: string) => api.post<SearchResult>('/web-search/search', { query, count: 5 });
export const listCredentials = (api: PlatformApiClient) => api.get<ServiceCredential[]>('/service-credentials');
export const saveOwnKey = (api: PlatformApiClient, provider: string, value: string) => api.put(`/service-credentials/${SERVICE}/${provider}`, { value });
export const removeOwnKey = (api: PlatformApiClient, provider: string) => api.delete(`/service-credentials/${SERVICE}/${provider}`);

export const getAdmin = (api: PlatformApiClient) => api.get<AdminSettings>('/web-search/admin');
export const saveAdmin = (api: PlatformApiClient, patch: Record<string, unknown>) => api.put<AdminSettings>('/web-search/admin', patch);
export const getUsage = (api: PlatformApiClient) => api.get<UsageRow[]>('/web-search/admin/usage?days=30');
export const saveDeploymentKey = (api: PlatformApiClient, provider: string, value: string) => api.put(`/service-credentials/admin/${SERVICE}/${provider}`, { value });
export const removeDeploymentKey = (api: PlatformApiClient, provider: string) => api.delete(`/service-credentials/admin/${SERVICE}/${provider}`);
