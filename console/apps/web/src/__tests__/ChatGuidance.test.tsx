// Steering a working job from the chat (#490): the owner's message shows
// "Queued for the agent", then "Seen by the agent"; the wait indicator ends
// without a reply; a message the run never read says so.
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';

import type { ChatStreamEvent } from '../live';

const live = vi.hoisted(() => ({ chat: new Map<string, (e: unknown) => void>() }));
vi.mock('../live', () => ({
  subscribeChat: (id: string, _afterSeq: number, onEvent: (e: unknown) => void) => {
    live.chat.set(id, onEvent);
    return () => void live.chat.delete(id);
  },
  subscribeRun: () => () => undefined,
  fetchRunScreenshot: async () => null,
}));

import { ChatPage } from '../pages/ChatPage';
import type { Chat, ChatDetail, ChatMessage, ChatRun } from '../types/chat';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { mockViewport } from './matchMedia';
import { POLICY_READS } from './policyFixtures';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const CHAT_ID = '88888888-8888-4888-8888-888888888888';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const GOAL = 'Book 2 tickets for tonight.';
const base: Chat = { id: CHAT_ID, title: 'Cinema tickets', status: 'active', profile: 'default', hostId: null, hostFallback: true, policyId: null, allowedDomains: [], confirmRiskyActions: true, lastMessageAt: '2026-11-17T10:05:00Z', createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T10:05:00Z' };
const message = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${seq}`, seq, role: 'assistant', kind: 'text', text: `message ${seq}`, runId: null, meta: null, createdAt: '2026-11-17T10:00:00Z', ...over });
const run = (over: Partial<ChatRun> = {}): ChatRun => ({ id: RUN_ID, status: 'running', goal: GOAL, stepCount: 3, activity: null as never, result: null, error: null, stopReason: null, cancelRequested: false, hostId: null, costUsd: 0, costKnown: true, createdAt: '2026-11-17T10:03:00Z', startedAt: '2026-11-17T10:03:05Z', finishedAt: null, ...over });
const LIVE: ChatDetail = { ...base, messages: [message(1, { role: 'user', text: 'Book two cinema tickets' }), message(2, { kind: 'run', text: GOAL, runId: RUN_ID })], hasMore: false, liveRun: { id: RUN_ID, status: 'running' }, thinking: false };

let restoreViewport: (() => void) | null = null;
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => {
  restoreViewport?.();
  restoreViewport = null;
  live.chat.clear();
  dismissToast();
});

function mount(width = 390) {
  restoreViewport = mockViewport(width);
  const host = createTestPlatformHost({
    permissions: ['chat:read', 'chat:write', 'runs:read', 'runs:write'],
    responses: {
      ...POLICY_READS,
      'GET /fleet/hosts': [],
      'GET /chats': { items: [], nextCursor: null },
      [`GET /chats/${CHAT_ID}`]: LIVE,
      [`POST /chats/${CHAT_ID}/messages`]: (req: TestApiRequest) => message(3, { role: 'user', text: (req.body as { text: string }).text }),
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter initialEntries={[`/chat/${CHAT_ID}`]}>
        <ConfirmProvider>
          <Routes>
            <Route path="/chat/:id" element={<ChatPage />} />
          </Routes>
        </ConfirmProvider>
        <ToastHost />
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}
const emit = (e: ChatStreamEvent) => act(() => live.chat.get(CHAT_ID)!(e));
const ready = async () => {
  await waitFor(() => expect(live.chat.has(CHAT_ID)).toBe(true));
  emit({ type: 'run', data: { run: run() } });
};

describe('guidance for a working job', () => {
  it('invites a message for the agent while a run is live', async () => {
    mount();
    await ready();
    expect(await screen.findByPlaceholderText('Add something for the agent')).toBeInTheDocument();
    emit({ type: 'run', data: { run: run({ status: 'succeeded' }) } });
    expect(await screen.findByPlaceholderText('Message')).toBeInTheDocument();
  });

  it('shows the message as queued, then as seen, and stops waiting for a reply', async () => {
    mount();
    await ready();
    fireEvent.change(await screen.findByPlaceholderText('Add something for the agent'), { target: { value: 'Use the 7:30 showing instead' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Use the 7:30 showing instead')).toBeInTheDocument();
    // Sent, not answered yet: the assistant is "working".
    expect(await screen.findByRole('status', { name: 'The assistant is working' })).toBeInTheDocument();
    expect(screen.queryByText('Queued for the agent')).not.toBeInTheDocument();

    emit({ type: 'guidance', data: { guidance: [{ seq: 3, state: 'queued' }] } });
    expect(await screen.findByText('Queued for the agent')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('status', { name: 'The assistant is working' })).not.toBeInTheDocument());

    emit({ type: 'guidance', data: { guidance: [{ seq: 3, state: 'delivered' }] } });
    expect(await screen.findByText('Seen by the agent')).toBeInTheDocument();
    expect(screen.queryByText('Queued for the agent')).not.toBeInTheDocument();
  });

  it('says when the job ended before reading it, and labels only the owner message it belongs to', async () => {
    mount(1440);
    await ready();
    emit({ type: 'message', data: message(3, { role: 'user', text: 'Pick aisle seats' }) });
    emit({ type: 'guidance', data: { guidance: [{ seq: 3, state: 'missed' }] } });
    const line = await screen.findByText('Not seen: the job had ended');
    expect(line.closest('[data-seq]')).toHaveAttribute('data-seq', '3');
    expect(document.querySelectorAll('[data-guidance]')).toHaveLength(1);
  });
});
