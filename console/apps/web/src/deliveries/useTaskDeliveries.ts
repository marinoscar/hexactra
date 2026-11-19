// The deliveries of the task being edited (E39.10, #607): what the server holds, and the list the form changes. Loaded once for a task
// that exists; a load that fails turns editing off (the form must not save over what it could not read).
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { draftFromDelivery, listChanged, type DeliveryDraft, type TaskDelivery } from './drafts';
import { listTaskDeliveries } from './sync';

export interface TaskDeliveriesState {
  /** Nothing to load for a new task, or without `runs:read`. */
  loaded: boolean;
  failed: boolean;
  saved: TaskDelivery[];
  drafts: DeliveryDraft[];
  setDrafts: (next: DeliveryDraft[] | ((old: DeliveryDraft[]) => DeliveryDraft[])) => void;
  /** The list differs from what the server holds. */
  dirty: boolean;
  /** After a save: the server's list and the drafts with their ids. */
  settle: (saved: TaskDelivery[], drafts: DeliveryDraft[]) => void;
}

export function useTaskDeliveries(taskId: string | undefined): TaskDeliveriesState {
  const { api, viewer } = usePlatformHost();
  const canRead = viewer.hasPermission('runs:read');
  const [saved, setSaved] = useState<TaskDelivery[]>([]);
  const [drafts, setDrafts] = useState<DeliveryDraft[]>([]);
  const [loaded, setLoaded] = useState(!taskId || !canRead);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!taskId || !canRead) return;
    let stale = false;
    listTaskDeliveries(api, taskId)
      .then((rows) => {
        if (stale) return;
        const list = Array.isArray(rows) ? rows : [];
        setSaved(list);
        setDrafts(list.map(draftFromDelivery));
        setLoaded(true);
      })
      .catch(() => {
        if (stale) return;
        setFailed(true);
        setLoaded(true);
      });
    return () => {
      stale = true;
    };
  }, [api, taskId, canRead]);

  const settle = useCallback((nextSaved: TaskDelivery[], nextDrafts: DeliveryDraft[]) => {
    setSaved(nextSaved);
    setDrafts(nextDrafts);
  }, []);
  const dirty = useMemo(() => !failed && listChanged(drafts, saved), [drafts, saved, failed]);
  return { loaded, failed, saved, drafts, setDrafts, dirty, settle };
}
