// The paged, filtered runs query behind `RunList` (#423): one page at a time
// from `GET /runs?envelope=1`, the counts per status, and a live refresh that
// asks only for the live runs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';

import type { RunCounts, RunListItem, RunPage } from '../types/runs';
import { isLive, useProfileTimeZone } from '../ui';
import { apiFilter, matchesFilters, toQuery, type RunFilters, type RunListScope } from './runFilters';

/** Rows per page. */
export const RUN_PAGE_SIZE = 50;
/** How often the live runs are refreshed, while the tab is visible. */
export const RUN_LIVE_TICK_MS = 5_000;

export interface UseRunListOptions {
  /** A fixed task: the list of one task's runs. */
  scope?: RunListScope;
  filters: RunFilters;
  /** Rows per page (1 to 100); default 50. */
  pageSize?: number;
  /** The live refresh; default on. */
  live?: boolean;
}

export interface RunListState {
  /** The loaded rows, newest first. */
  items: RunListItem[];
  /** Null on the last page. */
  nextCursor: string | null;
  /** The first page is loading (also after a filter change). */
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** The runs that match the filters, per status; null until loaded. */
  counts: RunCounts | null;
  /** Appends the next page; a no-op on the last page or while one loads. */
  loadMore: () => void;
  /** Drops the rows and loads the first page and the counts again. */
  reload: () => void;
  refreshCounts: () => Promise<RunCounts | null>;
  /** Removes rows (deleted runs) without a request. */
  removeRuns: (ids: readonly string[]) => void;
  /** Replaces a row with a newer copy of its run (after a cancel). */
  updateRun: (run: RunListItem) => void;
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * The runs that match `filters` (and `scope`), a page at a time.
 *
 * - A filter change aborts what is in flight and starts again from the first
 *   page; a response of an earlier filter never overwrites a newer one.
 * - Every 5 s, while the tab is visible, it asks for the live runs only
 *   (`state=live`), merges them into the rows, reads the final state of a run
 *   that left the live set, and prepends a new run the filter includes. The
 *   counts are read again on that tick only when something changed.
 */
export function useRunList({ scope, filters, pageSize = RUN_PAGE_SIZE, live = true }: UseRunListOptions): RunListState {
  const { api } = usePlatformHost();
  const timeZone = useProfileTimeZone();
  const scopeTaskId = scope?.taskId;
  /** One AI app's runs (its page, #464). */
  const scopeClientId = scope?.clientId;
  // The query strings are the identity of a filter: the effects below depend on them, not on object identity.
  const listQuery = useMemo(() => toQuery(apiFilter(filters, { taskId: scopeTaskId, clientId: scopeClientId }, timeZone)), [filters, scopeTaskId, scopeClientId, timeZone]);
  const countsQuery = useMemo(() => toQuery(apiFilter(filters, { taskId: scopeTaskId, clientId: scopeClientId }, timeZone, false)), [filters, scopeTaskId, scopeClientId, timeZone]);

  const [items, setItems] = useState<RunListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<RunCounts | null>(null);
  const [reloads, setReloads] = useState(0);

  /** The current query's generation and abort signal: a response checks it before it writes. */
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const itemsRef = useRef<RunListItem[]>([]);
  itemsRef.current = items;
  const cursorRef = useRef<string | null>(null);
  cursorRef.current = nextCursor;
  const busyMore = useRef(false);
  const latest = useRef({ filters, timeZone, scopeTaskId, scopeClientId });
  latest.current = { filters, timeZone, scopeTaskId, scopeClientId };

  const refreshCounts = useCallback(async (): Promise<RunCounts | null> => {
    const mine = generation.current;
    try {
      const next = await api.get<RunCounts>(`/runs/counts${countsQuery ? `?${countsQuery}` : ''}`, { signal: abort.current?.signal });
      if (mine === generation.current) setCounts(next);
      return next;
    } catch {
      // The counts are secondary: the list says what failed.
      return null;
    }
  }, [api, countsQuery]);

  // The first page and the counts: on mount, on a filter change and on reload().
  useEffect(() => {
    const mine = ++generation.current;
    const controller = new AbortController();
    abort.current?.abort();
    abort.current = controller;
    busyMore.current = false;
    setItems([]);
    setNextCursor(null);
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    api
      .get<RunPage>(`/runs?${toQuery({}, { envelope: '1', limit: String(pageSize) })}${listQuery ? `&${listQuery}` : ''}`, { signal: controller.signal })
      .then((page) => {
        if (mine !== generation.current) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (mine !== generation.current) return;
        setError(message(e, 'Could not load runs'));
        setLoading(false);
      });
    void refreshCounts();
    return () => controller.abort();
  }, [api, listQuery, pageSize, reloads, refreshCounts]);

  // Unmount: nothing in flight may write.
  useEffect(
    () => () => {
      generation.current++;
      abort.current?.abort();
    },
    [],
  );

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current;
    if (!cursor || busyMore.current) return;
    const mine = generation.current;
    busyMore.current = true;
    setLoadingMore(true);
    api
      .get<RunPage>(`/runs?${toQuery({}, { envelope: '1', limit: String(pageSize), cursor })}${listQuery ? `&${listQuery}` : ''}`, { signal: abort.current?.signal })
      .then((page) => {
        if (mine !== generation.current) return;
        // A run that a live tick already prepended is not listed twice.
        setItems((prev) => {
          const have = new Set(prev.map((r) => r.id));
          return [...prev, ...page.items.filter((r) => !have.has(r.id))];
        });
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        if (mine === generation.current) setError(message(e, 'Could not load more runs'));
      })
      .finally(() => {
        if (mine !== generation.current) return;
        busyMore.current = false;
        setLoadingMore(false);
      });
  }, [api, listQuery, pageSize]);

  // The live tick.
  useEffect(() => {
    if (!live) return;
    let ticking = false;
    const tick = async () => {
      if (ticking || document.visibilityState === 'hidden') return;
      const mine = generation.current;
      const signal = abort.current?.signal;
      ticking = true;
      try {
        const { filters: f, timeZone: zone, scopeTaskId: task, scopeClientId: app } = latest.current;
        const page = await api.get<RunPage>(`/runs?${toQuery({ ...(task ? { taskId: task } : {}), ...(app ? { clientId: app } : {}) }, { envelope: '1', state: 'live', limit: '100' })}`, { signal });
        if (mine !== generation.current) return;
        const liveById = new Map(page.items.map((r) => [r.id, r]));
        const before = itemsRef.current;
        // (b) A run that was live here and left the live set: read its final state.
        const left = before.filter((r) => isLive(r.status) && !liveById.has(r.id));
        const settled = new Map<string, RunListItem | null>();
        await Promise.all(
          left.map(async (r) => {
            try {
              settled.set(r.id, { ...(await api.get<RunListItem>(`/runs/${r.id}`, { signal })), taskName: r.taskName });
            } catch (e) {
              // Deleted on another device: the row goes, without an error.
              if (isPlatformApiError(e) && e.status === 404) settled.set(r.id, null);
            }
          }),
        );
        if (mine !== generation.current) return;
        const isNew = (r: RunListItem, rows: readonly RunListItem[], have: ReadonlySet<string>) =>
          !have.has(r.id) && Date.parse(r.createdAt) > (rows[0] ? Date.parse(rows[0].createdAt) : Number.NEGATIVE_INFINITY) && matchesFilters(r, f, { taskId: task, clientId: app }, zone);
        const merge = (prev: RunListItem[]): RunListItem[] => {
          const have = new Set(prev.map((r) => r.id));
          const merged = prev.flatMap((r) => {
            if (settled.has(r.id)) {
              const final = settled.get(r.id);
              return final ? [final] : [];
            }
            // (a) A live row takes the fresh copy.
            return [liveById.get(r.id) ?? r];
          });
          // (c) A run newer than the newest loaded row, when the filter includes it.
          const added = page.items.filter((r) => isNew(r, prev, have));
          return added.length > 0 ? [...added, ...merged] : merged;
        };
        const rows = itemsRef.current;
        const have = new Set(rows.map((r) => r.id));
        const changed = settled.size > 0 || page.items.some((r) => isNew(r, rows, have)) || rows.some((r) => liveById.has(r.id) && liveById.get(r.id)!.status !== r.status);
        setItems(merge);
        if (changed) void refreshCounts();
      } catch {
        // A failed tick is retried by the next one.
      } finally {
        ticking = false;
      }
    };
    const timer = setInterval(() => void tick(), RUN_LIVE_TICK_MS);
    return () => clearInterval(timer);
  }, [api, live, refreshCounts]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const removeRuns = useCallback((ids: readonly string[]) => {
    const gone = new Set(ids);
    setItems((prev) => prev.filter((r) => !gone.has(r.id)));
  }, []);
  const updateRun = useCallback((run: RunListItem) => {
    setItems((prev) => prev.map((r) => (r.id === run.id ? { ...run, taskName: run.taskName ?? r.taskName } : r)));
  }, []);

  return { items, nextCursor, loading, loadingMore, error, counts, loadMore, reload, refreshCounts, removeRuns, updateRun };
}
