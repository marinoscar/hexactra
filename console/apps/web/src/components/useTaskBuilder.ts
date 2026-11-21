import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { subscribeChat } from '../live';
import type { ChatMessage } from '../types/chat';
import type { TaskBuilderDetail, TaskBuilderSpec } from '../types/taskBuilder';
import { lastSeq, mergeMessages } from './chatThread';
import { CHAT_AWAIT_MS } from './useChat';

export interface TaskBuilderState {
  builder: Omit<TaskBuilderDetail, 'messages' | 'hasMore' | 'thinking'> | null;
  messages: ChatMessage[];
  loading: boolean;
  notFound: boolean;
  error: string | null;
  thinking: boolean;
  send: (text: string) => Promise<void>;
  /** Change the spec directly; resolves with the merged spec. */
  patchSpec: (patch: Partial<Record<keyof TaskBuilderSpec, unknown>>) => Promise<void>;
}

const isStatus = (e: unknown, status: number) => (e as { status?: number } | null)?.status === status;

/**
 * One task builder, kept current (E42.4): it reads `GET /task-builder/:id`,
 * then follows the conversation's chat stream for new messages and the AI's
 * "thinking". Each new message from the builder re-reads the spec, which the
 * builder changes as it learns.
 */
export function useTaskBuilder(id: string): TaskBuilderState {
  const { api } = usePlatformHost();
  const [builder, setBuilder] = useState<TaskBuilderState['builder']>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverThinking, setServerThinking] = useState(false);
  const [awaiting, setAwaiting] = useState<number | null>(null);
  const awaitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshSpec = useCallback(async () => {
    try {
      const d = await api.get<TaskBuilderDetail>(`/task-builder/${id}?afterSeq=1000000000`);
      setBuilder((prev) => (prev ? { ...prev, spec: d.spec, title: d.title, status: d.status } : prev));
    } catch {
      // The spec shows what it last read; the next message reads it again.
    }
  }, [api, id]);

  useEffect(() => {
    setBuilder(null);
    setMessages([]);
    setNotFound(false);
    setError(null);
    setLoading(true);
    let stale = false;
    let close: (() => void) | null = null;
    void (async () => {
      try {
        const d = await api.get<TaskBuilderDetail>(`/task-builder/${id}`);
        if (stale) return;
        const { messages: first, hasMore: _more, thinking, ...rest } = d;
        setBuilder(rest);
        setMessages(first);
        setServerThinking(thinking);
        setLoading(false);
        close = subscribeChat(id, lastSeq(first), (e) => {
          if (stale || e.type === 'open' || e.type === 'heartbeat') return;
          if (e.type === 'message') {
            const m = e.data as ChatMessage;
            setMessages((prev) => mergeMessages(prev, [m]));
            if (m.role !== 'user') void refreshSpec();
          } else if (e.type === 'turn') {
            const on = Boolean((e.data as { thinking?: boolean }).thinking);
            setServerThinking(on);
            if (!on) void refreshSpec();
          }
        });
      } catch (e) {
        if (stale) return;
        setLoading(false);
        if (isStatus(e, 404) || isStatus(e, 400)) setNotFound(true);
        else setError(e instanceof Error ? e.message : 'Could not load the task builder');
      }
    })();
    return () => {
      stale = true;
      close?.();
    };
  }, [api, id, refreshSpec]);

  useEffect(() => {
    if (awaiting !== null && messages.some((m) => m.seq > awaiting && m.role !== 'user')) setAwaiting(null);
  }, [messages, awaiting]);
  useEffect(() => {
    if (awaitTimer.current) clearTimeout(awaitTimer.current);
    awaitTimer.current = awaiting === null ? null : setTimeout(() => setAwaiting(null), CHAT_AWAIT_MS);
    return () => {
      if (awaitTimer.current) clearTimeout(awaitTimer.current);
    };
  }, [awaiting]);

  const send = useCallback(
    async (text: string) => {
      const sent = await api.post<ChatMessage>(`/task-builder/${id}/messages`, { text });
      setMessages((prev) => mergeMessages(prev, [sent]));
      setAwaiting(sent.seq);
    },
    [api, id],
  );

  const patchSpec = useCallback(
    async (patch: Partial<Record<keyof TaskBuilderSpec, unknown>>) => {
      const spec = await api.patch<TaskBuilderSpec>(`/task-builder/${id}/spec`, patch);
      setBuilder((prev) => (prev ? { ...prev, spec } : prev));
    },
    [api, id],
  );

  return { builder, messages, loading, notFound, error, thinking: serverThinking || awaiting !== null, send, patchSpec };
}
