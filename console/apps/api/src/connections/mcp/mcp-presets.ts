// MCP server presets (E50.12, #982): a short list of well-known public servers the Add dialog offers, so the owner picks a name instead of
// typing an address. DATA ONLY, in `packages/shared/mcp-presets.json` (reviewed like code, each address dated). A preset only fills the
// form: the server is tested before anything is kept and every tool starts `off`. It never carries a secret, never enables a tool and never
// marks one `read`. The administrator's host lists still apply: a preset on a host they block (or do not allow) is not offered.
import { MCP_PRESETS } from '@app/shared';
import { z } from 'zod';

import type { ResolvedMcpSettings } from '../connections.settings';
import { headerName } from './mcp-config';
import { MCP_AUTH_KINDS } from './mcp.constants';
import { checkHostLists, normalizeMcpUrl } from './mcp-url';

export const mcpPresetSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    name: z.string().min(1).max(60),
    url: z.string().max(2000).refine((u) => u.startsWith('https://') && normalizeMcpUrl(u) === u, 'An https address in the form it is kept'),
    auth: z.enum(MCP_AUTH_KINDS),
    headerName: headerName.optional(),
    docsUrl: z.string().max(2000).startsWith('https://'),
    notes: z.string().max(300),
    verified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict()
  .refine((p) => (p.auth === 'header') === (p.headerName !== undefined), 'A header preset names its header, and only it');
export type McpPresetView = Omit<z.infer<typeof mcpPresetSchema>, 'verified'> & { verified: string };

/** The presets the repository ships, checked once (a malformed entry fails the start, and the unit test). */
export function loadPresets(raw: readonly unknown[] = MCP_PRESETS): McpPresetView[] {
  return raw.map((p) => mcpPresetSchema.parse(p));
}

let cached: McpPresetView[] | null = null;

/** The presets the administrator's lists allow. */
export function presetsFor(lists: Pick<ResolvedMcpSettings, 'allowedHosts' | 'blockedHosts'>, all: readonly McpPresetView[] = (cached ??= loadPresets())): McpPresetView[] {
  return all.filter((p) => {
    try {
      checkHostLists(new URL(p.url).hostname, lists);
      return true;
    } catch {
      return false;
    }
  });
}
