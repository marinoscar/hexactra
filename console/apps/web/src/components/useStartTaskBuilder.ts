import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { isSliceEnabled } from '../slices/manifest';
import { toast } from '../ui';

/** Whether this console offers the task builder: it needs the AI slice. */
export const TASK_BUILDER_ENABLED = isSliceEnabled('ai');

/** Start a task builder (E42.4), optionally with the owner's first message, and open it. */
export function useStartTaskBuilder(): { start: (seed?: string) => Promise<void>; starting: boolean } {
  const { api } = usePlatformHost();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const start = useCallback(
    async (seed?: string) => {
      setStarting(true);
      try {
        const body = seed?.trim() ? { seed: seed.trim().slice(0, 8000) } : {};
        const b = await api.post<{ id: string }>('/task-builder', body);
        navigate(`/tasks/builder/${b.id}`);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Could not start the task builder', 'error');
      } finally {
        setStarting(false);
      }
    },
    [api, navigate],
  );
  return { start, starting };
}
