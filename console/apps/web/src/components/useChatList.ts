import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import type { ChatListItem, ChatPage, ChatStatus } from '../types/chat';

/** How often the list re-reads itself (a title, a preview and the live dot change without the page asking). */
export const CHAT_LIST_REFRESH_MS = 10_000;
const PAGE = 50;

export interface ChatListState {
  /** Null until the first answer. */
  items: ChatListItem[] | null;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
}

/**
 * The user's chats of one status, most recently active first (`GET /chats`).
 * The first page refreshes every 10 s and whenever `reload` is called; older
 * pages are added with `loadMore` and kept across refreshes.
 */
export function useChatList(status: ChatStatus, enabled = true): ChatListState {
  const { api } = usePlatformHost();
  const [items, setItems] = useState<ChatListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Rows of the pages after the first, which a refresh of the first page must not drop. */
  const older = useRef<ChatListItem[]>([]);

  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      const page = await api.get<ChatPage>(`/chats?status=${status}&limit=${PAGE}`);
      const first = new Set(page.items.map((c) => c.id));
      setItems([...page.items, ...older.current.filter((c) => !first.has(c.id))]);
      // The cursor of the first page only matters until an older page was loaded.
      if (older.current.length === 0) setCursor(page.nextCursor);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your chats');
    }
  }, [api, status, enabled]);

  useEffect(() => {
    older.current = [];
    setItems(null);
    setCursor(null);
    void reload();
    const timer = setInterval(() => void reload(), CHAT_LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.get<ChatPage>(`/chats?status=${status}&limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`);
      older.current = [...older.current, ...page.items];
      setItems((prev) => {
        const seen = new Set((prev ?? []).map((c) => c.id));
        return [...(prev ?? []), ...page.items.filter((c) => !seen.has(c.id))];
      });
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more chats');
    } finally {
      setLoadingMore(false);
    }
  }, [api, status, cursor, loadingMore]);

  return { items, error, hasMore: cursor !== null, loadingMore, reload, loadMore };
}
