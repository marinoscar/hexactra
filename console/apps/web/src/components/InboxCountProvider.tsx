import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

/** How often the pending-question count is re-read while the tab is visible. */
export const INBOX_POLL_MS = 15_000;

export interface InboxCount {
  /** How many questions wait for the viewer; 0 while unknown, on an error, or without `runs:read`. */
  count: number;
  /** Re-read the count now (after answering a question). */
  refresh: () => void;
}

const InboxCountContext = createContext<InboxCount>({ count: 0, refresh: () => undefined });

/** The document title with the pending count in front, so a background tab shows it: "(2) Hexactra". */
export function titleWithCount(title: string, count: number): string {
  const base = title.replace(/^\(\d+\) /, '');
  return count > 0 ? `(${count}) ${base}` : base;
}

/**
 * The number of questions waiting in the Inbox, shared by the navigation badge
 * (rail, bottom bar, user menu) and the document title. One source: the length
 * of `GET /inbox`, read on mount, every 15 s while the tab is visible, when the
 * tab becomes visible again and on every route change (so answering a question
 * updates the badge at once). A failed read shows no badge and never throws.
 */
export function InboxCountProvider({ children }: { children: ReactNode }) {
  const { api, viewer } = usePlatformHost();
  const allowed = viewer.hasPermission('runs:read');
  const { pathname } = useLocation();
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    if (!allowed) return;
    api
      .get<unknown[]>('/inbox')
      .then((list) => setCount(Array.isArray(list) ? list.length : 0))
      .catch(() => setCount(0));
  }, [api, allowed]);

  useEffect(() => {
    if (!allowed) {
      setCount(0);
      return;
    }
    const visible = () => document.visibilityState !== 'hidden';
    const tick = () => {
      if (visible()) refresh();
    };
    const timer = window.setInterval(tick, INBOX_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [allowed, refresh]);

  // On mount and on every navigation.
  useEffect(() => {
    refresh();
  }, [refresh, pathname]);

  useEffect(() => {
    document.title = titleWithCount(document.title, count);
    return () => {
      document.title = titleWithCount(document.title, 0);
    };
  }, [count]);

  const value = useMemo(() => ({ count, refresh }), [count, refresh]);
  return <InboxCountContext.Provider value={value}>{children}</InboxCountContext.Provider>;
}

/** The pending-question count and a way to re-read it. Outside the provider the count is 0. */
export function useInboxCount(): InboxCount {
  return useContext(InboxCountContext);
}

/** The Inbox destination's badge (`ShellDestination.badge`): the count, or nothing at zero. */
export function useInboxBadge(): number {
  return useInboxCount().count;
}
