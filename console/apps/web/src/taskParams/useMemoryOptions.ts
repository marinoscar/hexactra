import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';

import { listMemories, type Memory } from '../memories/api';

/** A memory as the "From a memory" picker needs it: its label and the names of its values. */
export interface MemoryOption {
  id: string;
  label: string;
  attributes: string[];
}

/** The picker's options: active memories only, by label, with their value names (never the values). */
export function toMemoryOptions(rows: readonly Pick<Memory, 'id' | 'label' | 'attributes' | 'status'>[]): MemoryOption[] {
  return rows
    .filter((r) => r.status === 'active')
    .map((r) => ({ id: r.id, label: r.label, attributes: Object.keys(r.attributes ?? {}) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The owner's active memories for the task form's "From a memory" default
 * (#556), read with the Memories page's own client (`GET /api/memories`,
 * #551). Null while the viewer lacks `memories:read`, while loading, and when
 * the list cannot be read: the picker is then hidden, never shown broken.
 */
export function useMemoryOptions(): MemoryOption[] | null {
  const { api, viewer } = usePlatformHost();
  const can = viewer.hasPermission('memories:read');
  const [memories, setMemories] = useState<MemoryOption[] | null>(null);
  useEffect(() => {
    if (!can) return setMemories(null);
    let live = true;
    listMemories(api, false)
      .then((rows) => live && setMemories(toMemoryOptions(rows)))
      .catch(() => live && setMemories(null));
    return () => {
      live = false;
    };
  }, [api, can]);
  return memories;
}
