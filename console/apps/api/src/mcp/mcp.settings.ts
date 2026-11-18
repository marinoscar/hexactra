import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

/** The deployment's ceilings of the MCP rate limits: an administrator may set a limit up to these (#465). */
export const MCP_RATE_CEILINGS = { rateLimitPerCredential: 6000, rateLimitWritesPerApp: 600, rateLimitUnauthenticated: 600, rateLimitPerUser: 20_000 } as const;

/** The `mcp` namespace of the system settings document: how the console's MCP server behaves for every user. */
export const mcpSettingsSchema = z.object({
  /**
   * Ask a run's question through the AI app itself (MCP elicitation, protocol
   * 2026-07-28 multi round-trip) when the app supports forms. Off: the app
   * only reads the question in the progress block and relays the answer.
   */
  elicitation: z.boolean(),
  /**
   * Also list, to an app signed in with OAuth, the tools its consent does not
   * cover but the user may allow (#460): marked "Needs extra permission", so
   * the model knows they exist and the app can ask the user (step-up). Off:
   * such an app sees only the tools it may call.
   */
  advertiseStepUpTools: z.boolean(),
  /**
   * The most live runs and browser sessions one connected AI app may have at
   * once (#464): a user's per-app setting is clamped to it. 1 to 20.
   */
  maxConcurrentRunsPerApp: z.number().int().min(1).max(20).optional(),
  /** The most runs and sessions one connected AI app may start per day (#464): a user's per-app setting is clamped to it. 1 to 1000. */
  maxDailyRunsPerApp: z.number().int().min(1).max(1000).optional(),
  /**
   * The kill switch of every app signed in with OAuth (#465): false refuses
   * each `oat_` request to `/api/mcp` with HTTP 503. Personal access tokens
   * and console sessions are not affected (see `patMcpEnabled`).
   */
  externalAppsEnabled: z.boolean().optional(),
  /** The same switch for personal access tokens over MCP only (#465): REST with a token keeps working. */
  patMcpEnabled: z.boolean().optional(),
  /** Requests per minute per OAuth grant, personal access token or console session, all methods (#465). */
  rateLimitPerCredential: z.number().int().min(10).max(MCP_RATE_CEILINGS.rateLimitPerCredential).optional(),
  /** `tools/call` of a tool that changes something (`effect` not `read`) per minute per OAuth grant (#465). */
  rateLimitWritesPerApp: z.number().int().min(1).max(MCP_RATE_CEILINGS.rateLimitWritesPerApp).optional(),
  /** Unauthenticated answers (`401`, discovery probes) per minute per source address (#465). */
  rateLimitUnauthenticated: z.number().int().min(5).max(MCP_RATE_CEILINGS.rateLimitUnauthenticated).optional(),
  /** Requests per minute per user across all their credentials (#465). */
  rateLimitPerUser: z.number().int().min(10).max(MCP_RATE_CEILINGS.rateLimitPerUser).optional(),
  /**
   * Hosts whose pages count as sensitive for an AI app driving a browser
   * (#465): a navigation to, or a click on, one of them needs the user's
   * approval first (suffix match: `bank.example` covers `www.bank.example`).
   * Ships empty: the owner adds their bank and payment providers.
   */
  sensitiveHosts: z.array(z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.-]+$/, 'A host name, such as bank.example')).max(200).optional(),
});
export type McpSettings = z.infer<typeof mcpSettingsSchema>;
export const mcpSettingsPatchSchema = mcpSettingsSchema.partial();

export const MCP_DEFAULT_SETTINGS = {
  elicitation: true,
  advertiseStepUpTools: true,
  maxConcurrentRunsPerApp: 5,
  maxDailyRunsPerApp: 200,
  externalAppsEnabled: true,
  patMcpEnabled: true,
  rateLimitPerCredential: 120,
  rateLimitWritesPerApp: 30,
  rateLimitUnauthenticated: 30,
  rateLimitPerUser: 600,
  sensitiveHosts: [] as string[],
} satisfies Required<McpSettings>;

/** The `mcp` namespace with every field filled (a field stored before it existed reads its default). */
export type ResolvedMcpSettings = typeof MCP_DEFAULT_SETTINGS;

/** A stored (or partial) namespace with every missing field at its default. */
export function resolveMcpSettings(v: Partial<McpSettings> | null | undefined): ResolvedMcpSettings {
  const out = { ...MCP_DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const [k, val] of Object.entries(v ?? {})) if (val !== undefined && val !== null) out[k] = val;
  return out as ResolvedMcpSettings;
}

/**
 * `mcp` (Admin, `system_settings:write`): read by the MCP dispatcher when a
 * tool would ask a question through the client (#463) and when it lists the
 * tools to an OAuth app (#460). Registered before
 * `SettingsModule.forRoot()` (src/platform/platform.ts).
 */
export const MCP_SYSTEM_SETTINGS = {
  key: 'mcp',
  description:
    "MCP server: whether a run's question is asked through the AI app's own form (elicitation), whether OAuth apps are shown the tools they need extra permission for, the ceilings of every connected AI app's limits, the kill switches of external AI apps and of personal access tokens over MCP, the rate limits of /api/mcp and the hosts whose pages need the user's approval before an AI app acts on them.",
  storedSchema: mcpSettingsSchema,
  patchSchema: mcpSettingsPatchSchema,
  putSchema: mcpSettingsSchema,
  wirePatchSchema: mcpSettingsPatchSchema,
  responseSchema: mcpSettingsSchema,
  defaults: MCP_DEFAULT_SETTINGS,
  requiredOnPut: false,
  // A document stored before a field existed reads that field's default.
  merge: (current, patch) => ({ ...MCP_DEFAULT_SETTINGS, ...current, ...patch }),
} satisfies SystemSettingsNamespace<'mcp', McpSettings, Partial<McpSettings>>;

registerSystemSettingsNamespaces([MCP_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

// Types `SystemSettingsService.getNamespace('mcp')`.
declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    mcp: McpSettings;
  }
}
