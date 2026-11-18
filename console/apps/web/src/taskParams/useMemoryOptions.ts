import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';

/** A memory as the "From a memory" picker needs it: its label and the names of its values. */
export interface MemoryOption {
  id: string;
  label: string;
  attributes: string[];
}

/** The fields of `GET /api/memories` the picker reads (#551). */
interface MemoryRow {
  id?: unknown;
  label?: unknown;
  attributes?: unknown;
}

export function toMemoryOptions(rows: unknown): MemoryOption[] {
  if (!Array.isArray(rows)) return [];
  return (rows as MemoryRow[])
    .filter((r) => typeof r.id === 'string' && typeof r.label === 'string')
    .map((r) => ({ id: r.id as string, label: r.label as string, attributes: r.attributes && typeof r.attributes === 'object' ? Object.keys(r.attributes as Record<string, unknown>) : [] }));
}

/**
 * The owner's active memories for the task form's "From a memory" default
 * (#556). Null while the viewer lacks `memories:read`, while loading, and
 * when the list cannot be read (a console without the memories routes answers
 * 404): the picker is then hidden, never shown broken.
 */
export function useMemoryOptions(): MemoryOption[] | null {
  const { api, viewer } = usePlatformHost();
  const can = viewer.hasPermission('memories:read');
  const [memories, setMemories] = useState<MemoryOption[] | null>(null);
  useEffect(() => {
    if (!can) return setMemories(null);
    let live = true;
    api
      .get<unknown>('/memories')
      .then((rows) => live && setMemories(toMemoryOptions(rows)))
      .catch(() => live && setMemories(null));
    return () => {
      live = false;
    };
  }, [api, can]);
  return memories;
}
