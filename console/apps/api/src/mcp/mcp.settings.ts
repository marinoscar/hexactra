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
  /**
   * Also list, to an app signed in with OAuth, the tools its consent does not
   * cover but the user may allow (#460): marked "Needs extra permission", so
   * the model knows they exist and the app can ask the user (step-up). Off:
   * such an app sees only the tools it may call.
   */
  advertiseStepUpTools: z.boolean(),
});
export type McpSettings = z.infer<typeof mcpSettingsSchema>;
export const mcpSettingsPatchSchema = mcpSettingsSchema.partial();

export const MCP_DEFAULT_SETTINGS: McpSettings = { elicitation: true, advertiseStepUpTools: true };

/**
 * `mcp` (Admin, `system_settings:write`): read by the MCP dispatcher when a
 * tool would ask a question through the client (#463) and when it lists the
 * tools to an OAuth app (#460). Registered before
 * `SettingsModule.forRoot()` (src/platform/platform.ts).
 */
export const MCP_SYSTEM_SETTINGS = {
  key: 'mcp',
  description: "MCP server: whether a run's question is asked through the AI app's own form (elicitation), and whether OAuth apps are shown the tools they need extra permission for.",
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
