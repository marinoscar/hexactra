// The memories export file (#551): `hexactra.memories`, `formatVersion` 1. The
// pattern of the policy file (#402): a portable document with no ids (of the
// memory, the user, a run or a chat), only what the owner saved.
import { z } from 'zod';

import { MEMORY_KINDS, MEMORY_SOURCES } from './memories.schemas';

export const MEMORY_FILE_KIND = 'hexactra.memories';
export const MEMORY_FILE_VERSION = 1;

export const memoryFileEntrySchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  label: z.string().max(120),
  aliases: z.array(z.string()).max(10),
  attributes: z.record(z.string(), z.string()),
  note: z.string().max(1000).nullable(),
  status: z.enum(['active', 'archived']),
  source: z.enum(MEMORY_SOURCES),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MemoryFileEntry = z.infer<typeof memoryFileEntrySchema>;

export const memoryFileSchema = z
  .object({
    kind: z.literal(MEMORY_FILE_KIND),
    formatVersion: z.number().int().min(1).describe('Version of this file format.'),
    exportedAt: z.string().describe('ISO 8601 timestamp of the export.'),
    memories: z.array(memoryFileEntrySchema).max(1000),
  })
  .strict()
  .describe('Your memories (active and archived; not the superseded versions) as a portable JSON file: no ids, no user, nothing secret.');
export type MemoryFile = z.infer<typeof memoryFileSchema>;

/** The row fields the file is built from. */
export interface MemoryFileSource {
  kind: string;
  label: string;
  aliases: string[];
  attributes: unknown;
  note: string | null;
  status: string;
  source: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** The file of a user's memories. Superseded versions are left out; the order is the rows'. */
export function buildMemoryFile(rows: readonly MemoryFileSource[], now: Date = new Date()): MemoryFile {
  return {
    kind: MEMORY_FILE_KIND,
    formatVersion: MEMORY_FILE_VERSION,
    exportedAt: now.toISOString(),
    memories: rows
      .filter((r) => r.status === 'active' || r.status === 'archived')
      .map((r) => ({
        kind: r.kind as MemoryFileEntry['kind'],
        label: r.label,
        aliases: [...r.aliases],
        attributes: { ...(r.attributes as Record<string, string>) },
        note: r.note,
        status: r.status as MemoryFileEntry['status'],
        source: r.source as MemoryFileEntry['source'],
        lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
  };
}

/** `hexactra-memories-<yyyymmdd>.json`. */
export function memoryFileName(now: Date = new Date()): string {
  return `hexactra-memories-${now.toISOString().slice(0, 10).replace(/-/g, '')}.json`;
}
