// The wire shapes and calls of the Connections pages (E39.2, #599). Nothing here carries a token or a scope string: the API
// returns capability names, a status and stable reason codes only.
import type { PlatformApiClient } from '@marinoscar/platform-web/core';

export type Provider = 'google' | 'microsoft';
export type Capability = 'mail_read' | 'mail_send' | 'mail_modify' | 'calendar_read' | 'calendar_write' | 'docs_read' | 'docs_write';
export type CapabilityGroup = 'mail' | 'calendar' | 'docs';
export type ConnectionStatus = 'active' | 'paused' | 'needs_reconnect' | 'revoked';

export interface Connection {
  id: string;
  provider: Provider | 'mcp';
  label: string;
  accountEmail: string;
  accountName: string | null;
  /** The switches that are on. */
  capabilities: Capability[];
  /** What the provider granted: switching one of these on needs no new consent. */
  granted: Capability[];
  defaultFor: CapabilityGroup[];
  status: ConnectionStatus;
  statusReason: string | null;
  connectedAt: string;
  lastUsedAt: string | null;
  lastRefreshAt: string | null;
  /** An MCP server (`provider: mcp`): where it points, how it signs in and what its tools stand at. Never a secret. */
  mcp?: McpInfo;
}

export type McpAuthKind = 'none' | 'bearer' | 'header' | 'oauth';
export type McpToolMode = 'off' | 'read' | 'write';

export interface McpInfo {
  url: string;
  auth: McpAuthKind;
  serverName: string | null;
  tools: { total: number; enabled: number; needsReview: number };
  toolsFetchedAt: string | null;
  /** What the server is for (E41.5): its own instructions, else its first enabled tool titles. Absent from an older console. */
  purpose?: string | null;
}

/** A tool of an MCP server. The description is the server's own text, already plain; render it as text only. */
export interface McpTool {
  id: string;
  name: string;
  title: string | null;
  description: string;
  parameters: { name: string; type: string | null; required: boolean }[];
  /** What the server claims: a hint is not a guarantee. */
  hints: { readOnly: boolean | null; destructive: boolean | null; idempotent: boolean | null; openWorld: boolean | null };
  suggested: 'read' | 'write';
  mode: McpToolMode;
  review: 'new' | 'changed' | null;
}

export interface McpCatalog {
  tools: McpTool[];
  needsReview: number;
  fetchedAt: string | null;
}

export type McpAuthInput = { kind: 'none' } | { kind: 'bearer'; token: string } | { kind: 'header'; header: string; value: string } | { kind: 'oauth'; clientId?: string | null; clientSecret?: string | null };

export interface McpAdmin {
  enabled: boolean;
  allowedHosts: string[];
  blockedHosts: string[];
}

export interface ConnectionUsage {
  kind: string;
  id: string;
  name: string;
}

export interface ConnectionDetail extends Connection {
  usedBy: ConnectionUsage[];
}

export interface AccountType {
  id: string;
  label: string;
  supported: boolean;
  note: string;
}

export interface ProviderAvailability {
  provider: Provider;
  displayName: string;
  ready: boolean;
  reason: 'not_installed' | 'disabled' | 'not_configured' | null;
  accountTypes: AccountType[];
  /** What each kind of account can do, per method (E39.4): `unsupported` is never offered. Optional for older servers. */
  matrixColumns?: string[];
  capabilityMatrix?: { method: string; service: 'mail' | 'calendar' | 'documents'; effect: 'read' | 'write'; capability: Capability; support: Record<string, { support: 'supported' | 'limited' | 'unsupported'; note?: string }> }[];
  /** Microsoft: the address an administrator opens to approve the app for the organization. */
  adminConsentUrl?: string | null;
}

export interface Consent {
  authorizeUrl: string;
  expiresAt: string;
}

export interface TestResult {
  /** `api` (with `API_DISABLED`): the provider's service to enable (`gmail.googleapis.com`), from a closed list. */
  results: { capability: Capability; ok: boolean; code: string | null; api?: string }[];
}

export interface AdminProvider {
  provider: Provider;
  displayName: string;
  enabled: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  tenant: string | null;
  installed: boolean;
  redirectUri: string;
  setupSteps: string[];
  accountTypes: AccountType[];
}

export const CAPABILITY_ORDER: Capability[] = ['mail_read', 'mail_send', 'mail_modify', 'calendar_read', 'calendar_write', 'docs_read', 'docs_write'];

export const listConnections = (api: PlatformApiClient) => api.get<Connection[]>('/connections');
export const getConnection = (api: PlatformApiClient, id: string) => api.get<ConnectionDetail>(`/connections/${id}`);
export const listProviders = (api: PlatformApiClient) => api.get<ProviderAvailability[]>('/connections/providers');

export const authorize = (api: PlatformApiClient, body: { provider: Provider; capabilities: Capability[]; label?: string; loginHint?: string; returnTo?: string }) => api.post<Consent>('/connections/authorize', body);

export const updateConnection = (api: PlatformApiClient, id: string, body: { label?: string; capabilities?: Capability[]; defaultFor?: CapabilityGroup[]; returnTo?: string }) =>
  api.patch<{ connection: Connection; consent: Consent | null }>(`/connections/${id}`, body);

export const pauseConnection = (api: PlatformApiClient, id: string) => api.post<Connection>(`/connections/${id}/pause`, {});
export const resumeConnection = (api: PlatformApiClient, id: string) => api.post<Connection>(`/connections/${id}/resume`, {});
export const removeConnection = (api: PlatformApiClient, id: string) => api.delete<{ revoked: boolean; clearedReferences: number }>(`/connections/${id}`);

export const getAdminApps = (api: PlatformApiClient) => api.get<AdminProvider[]>('/connections/admin/apps');
export const saveAdminApp = (api: PlatformApiClient, provider: Provider, body: { enabled?: boolean; clientId?: string | null; clientSecret?: string; tenant?: string }) => api.put<AdminProvider[]>(`/connections/admin/apps/${provider}`, body);
export const removeAdminApp = (api: PlatformApiClient, provider: Provider) => api.delete<AdminProvider[]>(`/connections/admin/apps/${provider}`);


// ---- MCP servers (E39.9, #606) ----

export const getMcpStatus = (api: PlatformApiClient) => api.get<{ enabled: boolean; restricted: boolean }>('/connections/mcp/status');
export const addMcpServer = (api: PlatformApiClient, body: { url: string; label?: string; auth: McpAuthInput; returnTo?: string }) =>
  api.post<{ connection: Connection | null; catalog: McpCatalog | null; consent: Consent | null }>('/connections/mcp', body);
export const getMcpTools = (api: PlatformApiClient, id: string) => api.get<McpCatalog>(`/connections/${id}/tools`);
export const refreshMcpTools = (api: PlatformApiClient, id: string) => api.post<McpCatalog>(`/connections/${id}/tools/refresh`, {});
export const setMcpToolMode = (api: PlatformApiClient, id: string, toolId: string, mode: McpToolMode) => api.patch<McpTool>(`/connections/${id}/tools/${toolId}`, { mode });
export const reauthMcp = (api: PlatformApiClient, id: string, auth: McpAuthInput, returnTo?: string) => api.post<{ connection: Connection; consent: Consent | null }>(`/connections/${id}/mcp-auth`, { auth, ...(returnTo ? { returnTo } : {}) });

export const getAdminMcp = (api: PlatformApiClient) => api.get<McpAdmin>('/connections/admin/mcp');
export const saveAdminMcp = (api: PlatformApiClient, body: Partial<McpAdmin>) => api.put<McpAdmin>('/connections/admin/mcp', body);
