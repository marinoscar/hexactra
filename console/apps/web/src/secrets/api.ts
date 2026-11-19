// The wire shapes and calls of the Secrets pages (E37.4, #593). Nothing here carries a login, a password or a code:
// the API never returns one.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

export type ConnectionStatus = 'not_configured' | 'disconnected' | 'connected' | 'needs_reconnect';

export interface VaultStatus {
  provider: 'vault';
  status: ConnectionStatus;
  configured: boolean;
  source: 'user' | 'deployment' | 'none';
  baseUrl: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  redirectUri: string;
  scopes: string[];
  vaultUserId: string | null;
  agentAccess: 'on' | 'off' | 'unknown';
  connectedAt: string | null;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  connecting: boolean;
}

export interface SecretsStatus {
  agentUse: { deployment: boolean; user: boolean; effective: boolean };
  providers: { vault: VaultStatus };
}

export type ActivityField =
  | 'username'
  | 'password'
  | 'one_time_code'
  | 'full_name'
  | 'date_of_birth'
  | 'id_type'
  | 'id_number'
  | 'id_issuing_country'
  | 'address_line1'
  | 'address_line2'
  | 'city'
  | 'region'
  | 'postal_code'
  | 'country'
  | 'phone'
  | 'email'
  // Card fields (E37.7): the field kind, never a value.
  | 'number'
  | 'expiry'
  | 'exp_month'
  | 'exp_year'
  | 'holder_name'
  | 'security_code';

export interface ActivityItem {
  id: string;
  at: string;
  event: 'lookup' | 'release';
  runId: string | null;
  site: string | null;
  /** The saved login's name, as the run recorded it; null when unknown. */
  loginName?: string | null;
  field: ActivityField | null;
  outcome: string;
  refused: boolean;
  matches: number | null;
  /** A card field (E37.7): the amount the agent declared, its currency and the payment frame's host. */
  amount?: string | null;
  currency?: string | null;
  frameSite?: string | null;
}

export interface ActivityList {
  items: ActivityItem[];
  providerActivityUrl: string | null;
}

export interface ReachItem {
  site: string | null;
  fields: ActivityField[];
  uses: number;
  lastUsedAt: string;
  lastRunId: string | null;
}

export interface Reach {
  listing: 'per_origin';
  items: ReachItem[];
}

/** `GET /api/secrets/store/status`: present only when the deployment switched the built-in store on (E37.5). */
export interface StoreStatus {
  enabled: true;
  provider: 'vault' | 'builtin';
  logins: number;
  openToAgent: number;
}

/** The built-in store's status, or null when this deployment does not offer it (the route is absent: 404). */
export const getStoreStatus = (api: PlatformApiClient): Promise<StoreStatus | null> => api.get<StoreStatus>('/secrets/store/status').catch(() => null);

/** Which provider the agent uses: the user setting `secrets.provider`. One is active at a time; switching moves no data. */
export const setProvider = (api: PlatformApiClient, provider: 'vault' | 'builtin') => api.patch('/user-settings', { secrets: { provider } });

export interface AdminSummary {
  deploymentEnabled: boolean;
  usersConnected: number;
  usersNeedingReconnect: number;
  usesThisWeek: number;
  refusalsThisWeek: number;
}

export interface DefaultClient {
  baseUrl: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  allowedHosts: string[];
  redirectUri: string;
}

export const getStatus = (api: PlatformApiClient) => api.get<SecretsStatus>('/secrets/status');
export const getActivity = (api: PlatformApiClient) => api.get<ActivityList>('/secrets/activity');
export const getReach = (api: PlatformApiClient) => api.get<Reach>('/secrets/reach');
/** `GET /api/secrets/identity` (E37.6): the identity items the owner saved, by name, with field labels. Never a value. */
export interface IdentityListing {
  available: boolean;
  reason: 'ok' | 'not_connected' | 'needs_reconnect' | 'needs_scope' | 'switched_off' | 'provider_off' | 'unavailable';
  items: { name: string; fields: { label: string; sensitive: boolean }[] }[];
  manageUrl: string | null;
}

export const getIdentity = (api: PlatformApiClient) => api.get<IdentityListing>('/secrets/identity');

/** `GET /api/secrets/cards?merchant=` (E37.7): the cards the owner granted for ONE merchant. Never a number or a code. */
export interface CardListing {
  available: boolean;
  reason: 'ok' | 'not_connected' | 'needs_reconnect' | 'needs_scope' | 'switched_off' | 'provider_off' | 'unavailable' | 'bad_merchant';
  merchant: string | null;
  cards: { name: string; brand: string | null; last4: string | null; expires: string | null; limit: { maxAmount: string; currency: string; includesSecurityCode: boolean; expiresAt: string | null } }[];
  manageUrl: string | null;
}

export const getCards = (api: PlatformApiClient, merchant: string) => api.get<CardListing>(`/secrets/cards?merchant=${encodeURIComponent(merchant)}`);
export const getAdminSummary = (api: PlatformApiClient) => api.get<AdminSummary>('/secrets/admin/summary');
export const getDefaultClient = (api: PlatformApiClient) => api.get<DefaultClient>('/secrets/vault/default-client');

export const saveClient = (api: PlatformApiClient, body: { baseUrl: string; clientId: string; clientSecret?: string }) => api.put<SecretsStatus>('/secrets/vault/client', body);
export const connect = (api: PlatformApiClient, body: { allowWrite?: boolean; allowIdentity?: boolean; allowCards?: boolean; returnTo?: string }) => api.post<{ authorizeUrl: string; expiresAt: string }>('/secrets/vault/connect', body);
export const disconnect = (api: PlatformApiClient, forgetClient = false) => api.post<{ revoked: boolean; status: SecretsStatus }>('/secrets/vault/disconnect', forgetClient ? { forgetClient } : {});

/** The owner's own switch: the user setting `secrets.agentUse.enabled`. */
export async function setAgentUse(api: PlatformApiClient, enabled: boolean): Promise<boolean> {
  const doc = await api.patch<{ secrets?: { agentUse?: { enabled?: boolean } } | null }>('/user-settings', { secrets: { agentUse: { enabled } } });
  return doc.secrets?.agentUse?.enabled === true;
}

/** The deployment's kill switch: the system setting `secrets.agentUse.enabled` (`system_settings:write`). */
export async function setDeploymentSwitch(api: PlatformApiClient, enabled: boolean, version: number): Promise<{ enabled: boolean; version: number }> {
  const doc = await api.patch<{ version: number; secrets?: { agentUse?: { enabled?: boolean } } }>('/system-settings', { secrets: { agentUse: { enabled } } }, { ifMatch: String(version) });
  return { enabled: doc.secrets?.agentUse?.enabled === true, version: doc.version };
}

/** The owner's default for the switch of a new task or chat: the user setting `secrets.defaultUseSavedLogins`. */
export async function getDefaultUseSavedLogins(api: PlatformApiClient): Promise<boolean> {
  const doc = await api.get<{ secrets?: { defaultUseSavedLogins?: boolean } | null }>('/user-settings');
  return doc.secrets?.defaultUseSavedLogins === true;
}

export async function setDefaultUseSavedLogins(api: PlatformApiClient, on: boolean): Promise<boolean> {
  const doc = await api.patch<{ secrets?: { defaultUseSavedLogins?: boolean } | null }>('/user-settings', { secrets: { defaultUseSavedLogins: on } });
  return doc.secrets?.defaultUseSavedLogins === true;
}

export async function getDeploymentSwitch(api: PlatformApiClient): Promise<{ enabled: boolean; version: number }> {
  const doc = await api.get<{ version: number; secrets?: { agentUse?: { enabled?: boolean } } }>('/system-settings');
  return { enabled: doc.secrets?.agentUse?.enabled === true, version: doc.version };
}
