import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { TASK_PAGE_SIZE, taskListPath, type TaskListQuery } from './taskList';
import type { TaskPage, TaskWithSummary } from '../types/tasks';

/** The whole list refreshes this often while the page is visible. */
export const TASK_LIST_REFRESH_MS = 15_000;
/** A row with a live run refreshes this often. */
export const TASK_LIVE_REFRESH_MS = 5_000;
/** At most this many live rows are refreshed per tick. */
const LIVE_ROWS_PER_TICK = 10;
/** The API's largest page. */
const MAX_LIMIT = 100;

export interface TaskList {
  /** The loaded rows; null until the first answer. */
  items: TaskWithSummary[] | null;
  /** Tasks that match the query, loaded or not. */
  total: number;
  hasMore: boolean;
  /** A new query's first page is on its way (the rows shown are the previous query's). */
  loading: boolean;
  loadingMore: boolean;
  /** Why the last load failed; null when it worked. */
  error: string | null;
  /** Load the query again from its first page. */
  reload: () => void;
  loadMore: () => void;
  /** Re-read the loaded rows in place (focus, the timer); failures are silent. */
  refresh: () => void;
  /** Put an API answer (a pause, a resume, a fresh read) in its row. */
  replace: (task: TaskWithSummary) => void;
  /** Change a row locally (an optimistic update). */
  patch: (id: string, change: (task: TaskWithSummary) => TaskWithSummary) => void;
  /** Drop a row (deleted here, or gone elsewhere). */
  remove: (id: string) => void;
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Could not load tasks';
}

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/**
 * The paged task list with each task's summary: one request per page
 * (`GET /tasks?envelope=1&include=summary`), "load more" by cursor, a refresh
 * on window focus and every 15 s while the page is visible, and every 5 s for
 * a row whose task has a live run. A request a newer one replaced is aborted
 * and its answer ignored.
 */
export function useTaskList(query: TaskListQuery): TaskList {
  const { api } = usePlatformHost();
  const [state, setState] = useState<{ items: TaskWithSummary[] | null; total: number; nextCursor: string | null }>({ items: null, total: 0, nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([query.q.trim(), query.filter, query.sort, query.policyId]);
  // `key` is the query's identity: a new object with the same values is the same query.
  const stable = useMemo(() => query, [key]);

  const stateRef = useRef(state);
  stateRef.current = state;
  /** Bumped by every local change and every new query, so an older refresh cannot overwrite it. */
  const epoch = useRef(0);
  const refreshing = useRef<AbortController | null>(null);
  const more = useRef<AbortController | null>(null);

  /** The first `want` rows of the query, following cursors. */
  const fetchRows = useCallback(
    async (want: number, signal: AbortSignal): Promise<TaskPage> => {
      const items: TaskWithSummary[] = [];
      let cursor: string | null = null;
      let total = 0;
      do {
        const limit = Math.min(MAX_LIMIT, Math.max(TASK_PAGE_SIZE, want - items.length));
        const page: TaskPage = await api.get<TaskPage>(taskListPath(stable, limit, cursor), { signal });
        items.push(...page.items);
        cursor = page.nextCursor;
        total = page.total;
      } while (cursor && items.length < want && !signal.aborted);
      return { items, nextCursor: cursor, total };
    },
    [api, stable],
  );

  // A new query (or Retry): its first page replaces the list.
  useEffect(() => {
    const controller = new AbortController();
    refreshing.current?.abort();
    more.current?.abort();
    epoch.current++;
    setLoading(true);
    setLoadingMore(false);
    fetchRows(TASK_PAGE_SIZE, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        epoch.current++;
        setState(page);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorText(e));
        setLoading(false);
      });
    return () => controller.abort();
  }, [fetchRows, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const refresh = useCallback(() => {
    const current = stateRef.current.items;
    if (current === null || more.current) return;
    refreshing.current?.abort();
    const controller = new AbortController();
    refreshing.current = controller;
    const started = epoch.current;
    fetchRows(Math.max(current.length, TASK_PAGE_SIZE), controller.signal)
      .then((page) => {
        // A change made while the refresh was in flight is newer than its answer.
        if (controller.signal.aborted || epoch.current !== started) return;
        setState(page);
        setError(null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (refreshing.current === controller) refreshing.current = null;
      });
  }, [fetchRows]);

  const loadMore = useCallback(() => {
    const { nextCursor } = stateRef.current;
    if (!nextCursor || more.current) return;
    refreshing.current?.abort();
    const controller = new AbortController();
    more.current = controller;
    setLoadingMore(true);
    api
      .get<TaskPage>(taskListPath(stable, TASK_PAGE_SIZE, nextCursor), { signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted) return;
        epoch.current++;
        setState((s) => {
          const seen = new Set((s.items ?? []).map((t) => t.id));
          return { items: [...(s.items ?? []), ...page.items.filter((t) => !seen.has(t.id))], nextCursor: page.nextCursor, total: page.total };
        });
        setError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (more.current === controller) {
          more.current = null;
          setLoadingMore(false);
        }
      });
  }, [api, stable]);

  const patch = useCallback((id: string, change: (task: TaskWithSummary) => TaskWithSummary) => {
    epoch.current++;
    setState((s) => (s.items ? { ...s, items: s.items.map((t) => (t.id === id ? change(t) : t)) } : s));
  }, []);
  const replace = useCallback((task: TaskWithSummary) => patch(task.id, () => task), [patch]);
  const remove = useCallback((id: string) => {
    epoch.current++;
    setState((s) => (s.items?.some((t) => t.id === id) ? { ...s, items: s.items.filter((t) => t.id !== id), total: Math.max(0, s.total - 1) } : s));
  }, []);

  // The whole list: on focus, when the tab shows again, and every 15 s while it is visible.
  useEffect(() => {
    const onShow = () => {
      if (visible()) refresh();
    };
    const timer = setInterval(onShow, TASK_LIST_REFRESH_MS);
    window.addEventListener('focus', onShow);
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onShow);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [refresh]);

  // Rows with a live run: each is re-read every 5 s until its run is over.
  const liveIds = (state.items ?? []).filter((t) => t.summary.liveRunId).map((t) => t.id).slice(0, LIVE_ROWS_PER_TICK).join(',');
  useEffect(() => {
    if (!liveIds) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (!visible()) return;
      for (const id of liveIds.split(',')) {
        const started = epoch.current;
        api
          .get<TaskWithSummary>(`/tasks/${id}?include=summary`, { signal: controller.signal })
          .then((task) => {
            if (!controller.signal.aborted && epoch.current === started) replace(task);
          })
          .catch((e: unknown) => {
            // Deleted elsewhere: the row goes.
            if (!controller.signal.aborted && isPlatformApiError(e) && e.status === 404) remove(id);
          });
      }
    }, TASK_LIVE_REFRESH_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [api, liveIds, replace, remove]);

  return { items: state.items, total: state.total, hasMore: state.nextCursor !== null, loading, loadingMore, error, reload, loadMore, refresh, replace, patch, remove };
}
