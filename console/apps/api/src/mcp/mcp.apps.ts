// MCP Apps (#466): the `ui://` resources the console serves, the `_meta` a
// tool links one with, and the per-host sandbox `domain`. Specification:
// https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
// (SDK `@modelcontextprotocol/ext-apps`). The endpoint is hand-rolled, so the
// few fields the SDK's server helpers write are written here directly:
//
// - `registerAppTool()` (`@modelcontextprotocol/ext-apps/server`, 2.1.0) sets
//   `_meta.ui.resourceUri` and mirrors it under the legacy flat key
//   `ui/resourceUri` (`RESOURCE_URI_META_KEY`). The ChatGPT alias
//   `openai/outputTemplate` is not written by the SDK; issue #466 asks for it
//   and it costs nothing.
// - `registerAppResource()` sets `mimeType: RESOURCE_MIME_TYPE`
//   (`text/html;profile=mcp-app`); the resource's `_meta.ui` carries `csp`,
//   `domain` and `prefersBorder` (`McpUiResourceMeta`).
// - The extension id is `EXTENSION_ID` (`io.modelcontextprotocol/ui`), read
//   from the client's `capabilities.extensions` by `getUiCapability()`.
//
// Pure functions plus one file read; unit tested in test/mcp-apps.spec.ts and
// against a real database in test/mcp-apps.db.spec.ts.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ClientBucket } from './mcp.protocol';

/** `EXTENSION_ID` of the SDK: the MCP Apps extension in `capabilities.extensions`. */
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
/** `RESOURCE_MIME_TYPE` of the SDK. */
export const MCP_APP_MIME = 'text/html;profile=mcp-app';
/** `RESOURCE_URI_META_KEY` of the SDK: the legacy flat key `registerAppTool()` still writes. */
export const LEGACY_RESOURCE_URI_KEY = 'ui/resourceUri';
/** ChatGPT's compatibility alias of `_meta.ui.resourceUri`. */
export const OPENAI_OUTPUT_TEMPLATE_KEY = 'openai/outputTemplate';

/** The live run card (apps/mcp-ui, `dist/run-card.html`). */
export const RUN_CARD_URI = 'ui://hexactra/run-card';

/** Who may call a tool (`McpUiToolMeta.visibility`): the model, the app (widget), or both (the default). */
export type McpToolVisibility = 'model' | 'app';

/** A `ui://` resource: one self-contained HTML file built by apps/mcp-ui. */
export interface McpUiResource {
  uri: string;
  /** `Resource.name` (programmatic). */
  name: string;
  title: string;
  description: string;
  /** The built file in apps/mcp-ui/dist. */
  file: string;
  /** Origins the page may reach (`McpUiResourceCsp`); empty means none at all. */
  csp: { connectDomains: string[]; resourceDomains: string[] };
  prefersBorder: boolean;
}

export const MCP_UI_RESOURCES: readonly McpUiResource[] = [
  {
    uri: RUN_CARD_URI,
    name: 'run_card',
    title: 'Hexactra run',
    description: "A live card for one Hexactra run: the browser's screenshot, what the agent is doing, its budget, Stop and a link to the console.",
    file: 'run-card.html',
    // The widget talks only to the host: no fetch, no external script, style, font or image.
    csp: { connectDomains: [], resourceDomains: [] },
    prefersBorder: true,
  },
];

let distDirOverride: string | null = null;

/** Tests point the loader at another directory (`null` restores the default). */
export function setMcpUiDistDir(dir: string | null): void {
  distDirOverride = dir;
  cache.clear();
}

/**
 * Where the built widgets are: `apps/mcp-ui/dist`, next to this app. The API
 * source (`apps/api/src/mcp`) and build (`apps/api/dist/mcp`) are at the same
 * depth, and the API image copies the widgets to `/app/apps/mcp-ui/dist`.
 */
export function mcpUiDistDir(): string {
  return distDirOverride ?? resolve(__dirname, '..', '..', '..', 'mcp-ui', 'dist');
}

interface Loaded {
  text: string;
  hash: string;
}

const cache = new Map<string, Loaded | null>();

/** In production a widget is read once; elsewhere on every request, so a rebuild shows at once. */
function cacheable(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * The HTML of a resource, with a comment naming its content hash and the
 * console version (so a cached copy in a host can be told apart), or `null`
 * when the file is missing (never built): the resource is then neither
 * listed nor linked, and every tool works as before.
 */
export function loadUiResource(r: McpUiResource, version: string): Loaded | null {
  const key = `${r.uri}@${version}`;
  if (cacheable() && cache.has(key)) return cache.get(key) ?? null;
  const path = join(mcpUiDistDir(), r.file);
  let out: Loaded | null = null;
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
      out = { text: stampHtml(raw, `hexactra-mcp-ui ${r.name} sha256:${hash} console:${version}`), hash };
    }
  } catch {
    out = null;
  }
  if (cacheable()) cache.set(key, out);
  return out;
}

/** The build comment, right after the doctype (a comment before it is legal, but this keeps the doctype first). */
export function stampHtml(html: string, note: string): string {
  const comment = `<!-- ${note.replace(/--/g, '')} -->`;
  const m = /^\s*<!doctype html>/i.exec(html);
  return m ? `${m[0]}\n${comment}${html.slice(m[0].length)}` : `${comment}\n${html}`;
}

/** Whether a resource can be served right now (its file exists). */
export function uiResourceAvailable(uri: string, version: string): boolean {
  const r = MCP_UI_RESOURCES.find((x) => x.uri === uri);
  return r !== undefined && loadUiResource(r, version) !== null;
}

/** The console's MCP endpoint URL: `APP_URL` + `/api/mcp` (what a person adds to a hosted client). */
export function mcpServerUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/api/mcp`;
}

/**
 * Claude's sandbox origin for this server (claude.com/docs, "Set ui.domain
 * for Claude"): the first 32 hex characters of SHA-256 of the server URL,
 * then `.claudemcpcontent.com`.
 */
export function claudeUiDomain(serverUrl: string): string {
  return `${createHash('sha256').update(serverUrl).digest('hex').slice(0, 32)}.claudemcpcontent.com`;
}

/**
 * `_meta.ui.domain` for a host family, or `undefined` (the host's default
 * per-conversation origin). No domain is sent to any host for now: the field
 * is optional, and Claude shows an error instead of the card when the value
 * does not hash-match the connector URL exactly as the user typed it (a
 * trailing slash, another host name behind a proxy). Every host renders the
 * card without it. #468 verifies the formulas against the real clients
 * ({@link claudeUiDomain} is Claude's) and turns them on where they help.
 */
export function uiDomainFor(_client: ClientBucket | string | undefined, _appUrl: string | undefined): string | undefined {
  return undefined;
}

/** The resource's `_meta` (`McpUiResourceMeta`). */
export function uiResourceMeta(r: McpUiResource, domain: string | undefined): { ui: Record<string, unknown> } {
  return { ui: { csp: { connectDomains: [...r.csp.connectDomains], resourceDomains: [...r.csp.resourceDomains] }, ...(domain ? { domain } : {}), prefersBorder: r.prefersBorder } };
}

/** One entry of `resources/list`. */
export function uiResourceListEntry(r: McpUiResource, domain: string | undefined): Record<string, unknown> {
  return { uri: r.uri, name: r.name, title: r.title, description: r.description, mimeType: MCP_APP_MIME, _meta: uiResourceMeta(r, domain) };
}

/** A tool's `_meta`: the linked resource (with the legacy key and the ChatGPT alias) and its visibility. */
export function toolUiMeta(resourceUri: string | undefined, visibility: readonly McpToolVisibility[] | undefined): Record<string, unknown> | undefined {
  if (!resourceUri && !visibility) return undefined;
  return {
    ui: { ...(resourceUri ? { resourceUri } : {}), ...(visibility ? { visibility: [...visibility] } : {}) },
    ...(resourceUri ? { [LEGACY_RESOURCE_URI_KEY]: resourceUri, [OPENAI_OUTPUT_TEMPLATE_KEY]: resourceUri } : {}),
  };
}

/** Whether the client declared MCP Apps in its capabilities (`capabilities.extensions["io.modelcontextprotocol/ui"]`). */
export function clientSupportsApps(caps: Record<string, unknown> | undefined): boolean {
  const ext = caps?.extensions;
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return false;
  const ui = (ext as Record<string, unknown>)[MCP_APPS_EXTENSION_ID];
  if (!ui || typeof ui !== 'object') return false;
  const mimes = (ui as { mimeTypes?: unknown }).mimeTypes;
  return !Array.isArray(mimes) || mimes.includes(MCP_APP_MIME);
}

let seq = 0;

/**
 * The supersession key of a card (claude.com/docs, "Supersede older widget
 * instances"): server time and a counter, stamped on a result that opens a
 * card. The newest card of a run is the one that keeps polling.
 */
export function cardKey(now = Date.now()): { created_at: number; seq: number } {
  seq += 1;
  return { created_at: now, seq };
}
