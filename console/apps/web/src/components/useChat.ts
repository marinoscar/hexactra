import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { subscribeChat } from '../live';
import type { Chat, ChatDetail, ChatGuidance, ChatMessage, ChatRun } from '../types/chat';
import { lastSeq, mergeMessages } from './chatThread';

/** How long the page shows "thinking" after a message was sent and nothing came back (a lost event must not leave the dots forever). */
export const CHAT_AWAIT_MS = 90_000;

export interface ChatState {
  /** Null until the first answer, and for a chat that was not found. */
  chat: Chat | null;
  messages: ChatMessage[];
  loading: boolean;
  /** The chat does not exist or is not the user's. */
  notFound: boolean;
  error: string | null;
  /** The AI is working on its reply: the server says so, or a message was just sent. */
  thinking: boolean;
  /** The chat's newest run, live or finished; null when it has none. */
  run: ChatRun | null;
  /** The request that run waits on (its shape is the questions API's); null when it waits on none. */
  question: unknown;
  /** Owner messages passed to a run as guidance, and what became of each (#490). */
  guidance: ChatGuidance[];
  /** Send a message. Rejects with the API's error. */
  send: (text: string) => Promise<void>;
  /** Merge a change the page made itself (a rename, an archive, new settings). */
  patch: (chat: Chat) => void;
}

/** A run of which only the id and the status are known yet. */
const EMPTY_RUN: ChatRun = { id: '', status: 'queued', goal: '', stepCount: 0, activity: null, result: null, error: null, stopReason: null, cancelRequested: false, hostId: null, costUsd: 0, costKnown: true, createdAt: '', startedAt: null, finishedAt: null };

const isStatus = (e: unknown, status: number) => (e as { status?: number } | null)?.status === status;

/**
 * One chat, kept current (#486): it reads the chat (`GET /chats/:id`), then
 * follows its event stream (`subscribeChat`) for new messages, the AI's
 * "thinking", the run and the pending request. `id` null is no chat (the
 * new-chat screen): everything is empty and nothing is fetched.
 */
export function useChat(id: string | null): ChatState {
  const { api } = usePlatformHost();
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(id !== null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverThinking, setServerThinking] = useState(false);
  /** The `seq` of a message just sent that nothing has answered yet. */
  const [awaiting, setAwaiting] = useState<number | null>(null);
  const [run, setRun] = useState<ChatRun | null>(null);
  const [question, setQuestion] = useState<unknown>(null);
  const [guidance, setGuidance] = useState<ChatGuidance[]>([]);
  const awaitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setChat(null);
    setMessages([]);
    setNotFound(false);
    setError(null);
    setServerThinking(false);
    setAwaiting(null);
    setRun(null);
    setQuestion(null);
    setGuidance([]);
    setLoading(id !== null);
    if (id === null) return;
    let stale = false;
    let close: (() => void) | null = null;
    void (async () => {
      try {
        const detail = await api.get<ChatDetail>(`/chats/${id}`);
        if (stale) return;
        const { messages: first, hasMore: _more, liveRun: _live, thinking, ...rest } = detail;
        setChat(rest);
        setMessages(first);
        setServerThinking(thinking);
        // Until the stream's first `run` event: the live run the read named, with what is known of it.
        if (_live) setRun((prev) => prev ?? { ...EMPTY_RUN, id: _live.id, status: _live.status });
        setLoading(false);
        close = subscribeChat(id, lastSeq(first), (e) => {
          if (stale || e.type === 'open' || e.type === 'heartbeat') return;
          if (e.type === 'message') setMessages((prev) => mergeMessages(prev, [e.data as ChatMessage]));
          else if (e.type === 'chat') setChat((prev) => (prev ? { ...prev, ...(e.data as Pick<Chat, 'title' | 'status'>) } : prev));
          else if (e.type === 'turn') setServerThinking(Boolean((e.data as { thinking?: boolean }).thinking));
          else if (e.type === 'run') setRun((e.data as { run: ChatRun | null }).run);
          else if (e.type === 'question') setQuestion((e.data as { question: unknown }).question);
          else if (e.type === 'guidance') setGuidance((e.data as { guidance?: ChatGuidance[] }).guidance ?? []);
        });
      } catch (e) {
        if (stale) return;
        setLoading(false);
        // A chat that is not the viewer's answers 404; a malformed id is a 400.
        if (isStatus(e, 404) || isStatus(e, 400)) setNotFound(true);
        else setError(e instanceof Error ? e.message : 'Could not load the chat');
      }
    })();
    return () => {
      stale = true;
      close?.();
    };
  }, [api, id]);

  // Whatever arrives after the sent message (a reply, a question, a run, an error line) ends the wait.
  useEffect(() => {
    // A message passed to the run as guidance gets no reply: its own "Queued" line is the answer.
    if (awaiting !== null && (messages.some((m) => m.seq > awaiting && m.role !== 'user') || guidance.some((g) => g.seq === awaiting))) setAwaiting(null);
  }, [messages, guidance, awaiting]);
  useEffect(() => {
    if (awaitTimer.current) clearTimeout(awaitTimer.current);
    awaitTimer.current = awaiting === null ? null : setTimeout(() => setAwaiting(null), CHAT_AWAIT_MS);
    return () => {
      if (awaitTimer.current) clearTimeout(awaitTimer.current);
    };
  }, [awaiting]);

  const send = useCallback(
    async (text: string) => {
      if (id === null) throw new Error('No chat to send to');
      const sent = await api.post<ChatMessage>(`/chats/${id}/messages`, { text });
      setMessages((prev) => mergeMessages(prev, [sent]));
      setAwaiting(sent.seq);
    },
    [api, id],
  );

  const patch = useCallback((next: Chat) => setChat(next), []);

  return { chat, messages, loading, notFound, error, thinking: serverThinking || awaiting !== null, run, question, guidance, send, patch };
}
