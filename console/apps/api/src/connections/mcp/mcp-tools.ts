// The tool catalogue of an MCP server, as a pure model (E39.9, #606): what a `tools/list` entry is, its hash, what the server's hints
// SUGGEST (never what the owner decided), and what a refresh does to the owner's decisions. No I/O: the catalogue service stores.
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { MCP_STORED_DESCRIPTION_CHARS, MCP_TOOL_NAME_MAX, type McpToolMode, type McpToolReview } from './mcp.constants';

export const annotationsSchema = z
  .object({
    title: z.string().max(500).optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .passthrough();

/** A `tools/list` entry as the server sent it, checked loosely: an entry that does not fit is skipped, never guessed at. */
export const rawToolSchema = z.object({
  name: z.string().min(1).max(MCP_TOOL_NAME_MAX),
  title: z.string().max(1_000).optional(),
  description: z.string().max(100_000).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: annotationsSchema.optional(),
});

export interface McpToolDescriptor {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Only the four hints: nothing else a server puts in `annotations` is kept. */
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  hash: string;
}

// Postgres refuses a NUL in text and in JSONB: a server that sends one must not be able to stop its tools being stored.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (v: string): string => v.replace(CONTROL, '');
/** `value` with every string (and key) free of control characters: what is kept of a server's schema. */
function cleanDeep(value: unknown, depth = 0): unknown {
  if (depth > 40) return null;
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.slice(0, 1_000).map((x) => cleanDeep(x, depth + 1));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 1_000).map(([k, x]) => [clean(k), cleanDeep(x, depth + 1)]));
  return value;
}

const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canon(x)])) : v);

/** The hash of everything about a tool that decides what it means: name, title, description, input schema and the four hints. */
export function toolHash(t: Omit<McpToolDescriptor, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(canon({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }))).digest('hex');
}

/** A descriptor from a raw entry, or null when it is not a usable tool (no object schema, a name that is too long, ...). */
export function toDescriptor(raw: unknown): McpToolDescriptor | null {
  const parsed = rawToolSchema.safeParse(raw);
  if (!parsed.success) return null;
  const t = parsed.data;
  if (clean(t.name) !== t.name) return null;
  if (t.inputSchema.type !== undefined && t.inputSchema.type !== 'object') return null;
  const a = t.annotations ?? {};
  const annotations: McpToolDescriptor['annotations'] = {
    ...(typeof a.readOnlyHint === 'boolean' ? { readOnlyHint: a.readOnlyHint } : {}),
    ...(typeof a.destructiveHint === 'boolean' ? { destructiveHint: a.destructiveHint } : {}),
    ...(typeof a.idempotentHint === 'boolean' ? { idempotentHint: a.idempotentHint } : {}),
    ...(typeof a.openWorldHint === 'boolean' ? { openWorldHint: a.openWorldHint } : {}),
  };
  const base = {
    name: t.name,
    title: clean((t.title ?? a.title ?? '').slice(0, 200)) || null,
    description: clean((t.description ?? '').slice(0, MCP_STORED_DESCRIPTION_CHARS)),
    inputSchema: { ...(cleanDeep(t.inputSchema) as Record<string, unknown>), type: 'object' },
    annotations,
  };
  return { ...base, hash: toolHash(base) };
}

/**
 * What the server's hints SUGGEST. A tool it marks read-only is suggested `read`; everything else, including a tool with no hints, is
 * suggested `write`. A hint is the server's claim, not a guarantee: the owner decides, and `suggested` never enables anything.
 */
export const suggestedMode = (annotations: McpToolDescriptor['annotations']): Exclude<McpToolMode, 'off'> => (annotations.readOnlyHint === true ? 'read' : 'write');

export interface StoredTool {
  name: string;
  hash: string;
  mode: McpToolMode;
  review: McpToolReview | null;
  approvedHash: string | null;
}

export interface TrustPlan {
  create: { tool: McpToolDescriptor; review: McpToolReview | null }[];
  /** A tool whose hash changed: refreshed in place. `disable`: it was enabled and is switched off pending the owner's review. */
  update: { tool: McpToolDescriptor; disable: boolean; review: McpToolReview | null }[];
  remove: string[];
  /** Tools the owner must look at again: switched off because they changed, or new after the first listing. */
  needReview: number;
}

/**
 * What a refresh does to the owner's decisions (the rug-pull rule). A new tool arrives `off` (flagged `new` when the connection was listed
 * before). A tool whose description, schema or hints changed is refreshed; if it was enabled it is switched off and flagged `changed`, and
 * only the owner's own decision switches it on again. A tool the server stopped offering is removed. Nothing here ever enables a tool.
 */
export function planRefresh(current: readonly StoredTool[], fetched: readonly McpToolDescriptor[], firstListing: boolean): TrustPlan {
  const byName = new Map(current.map((t) => [t.name, t]));
  const seen = new Set<string>();
  const plan: TrustPlan = { create: [], update: [], remove: [], needReview: 0 };
  for (const tool of fetched) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    const row = byName.get(tool.name);
    if (!row) {
      const review: McpToolReview | null = firstListing ? null : 'new';
      plan.create.push({ tool, review });
      if (review) plan.needReview += 1;
      continue;
    }
    if (row.hash === tool.hash) continue;
    const enabled = row.mode !== 'off';
    const review: McpToolReview | null = enabled || row.review === 'changed' ? 'changed' : row.review;
    plan.update.push({ tool, disable: enabled, review });
    if (enabled) plan.needReview += 1;
  }
  for (const row of current) if (!seen.has(row.name)) plan.remove.push(row.name);
  return plan;
}
