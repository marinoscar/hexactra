import { registerSystemSettingsNamespaces, type SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

/** The `mcp` namespace of the system settings document: how the console's MCP server behaves for every user. */
export const mcpSettingsSchema = z.object({
  /**
   * Ask a run's question through the AI app itself (MCP elicitation, protocol
   * 2026-07-28 multi round-trip) when the app supports forms. Off: the app
   * only reads the question in the progress block and relays the answer.
   */
  elicitation: z.boolean(),
});
export type McpSettings = z.infer<typeof mcpSettingsSchema>;
export const mcpSettingsPatchSchema = mcpSettingsSchema.partial();

export const MCP_DEFAULT_SETTINGS: McpSettings = { elicitation: true };

/**
 * `mcp` (Admin, `system_settings:write`): read by the MCP dispatcher when a
 * tool would ask a question through the client (#463). Registered before
 * `SettingsModule.forRoot()` (src/platform/platform.ts).
 */
export const MCP_SYSTEM_SETTINGS = {
  key: 'mcp',
  description: "MCP server: whether a run's question is asked through the AI app's own form (elicitation).",
  storedSchema: mcpSettingsSchema,
  patchSchema: mcpSettingsPatchSchema,
  putSchema: mcpSettingsSchema,
  wirePatchSchema: mcpSettingsPatchSchema,
  responseSchema: mcpSettingsSchema,
  defaults: MCP_DEFAULT_SETTINGS,
  requiredOnPut: false,
  merge: (current, patch) => ({ ...current, ...patch }),
} satisfies SystemSettingsNamespace<'mcp', McpSettings, Partial<McpSettings>>;

registerSystemSettingsNamespaces([MCP_SYSTEM_SETTINGS as unknown as SystemSettingsNamespace]);

// Types `SystemSettingsService.getNamespace('mcp')`.
declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    mcp: McpSettings;
  }
}
