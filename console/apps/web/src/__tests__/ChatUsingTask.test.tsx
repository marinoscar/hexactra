// The chat and your saved tasks (E51.2, #1007) in the web app: the Browser card of a task run says Using your task "<name>" with a link
// to the task, live and after it ends; any other run says nothing; and the Chat settings switch "Use my saved tasks when one fits"
// reads and saves `chat.useSavedTasks`. Canned API answers only.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserCard } from '../components/ChatBrowser';
import { USE_SAVED_TASKS_LABEL, UseSavedTasksSwitch } from '../components/UseSavedTasksSwitch';
import { runTaskOf } from '../components/UsingTask';
import type { ChatMessage, ChatRun } from '../types/chat';

vi.mock('../live', () => ({ subscribeRun: () => () => undefined, fetchRunScreenshot: async () => null }));
configure({ asyncUtilTimeout: 5_000 });

const TASK = '77777777-7777-4777-8777-777777777777';
const message = (meta: unknown): ChatMessage => ({ id: 'm1', seq: 2, role: 'assistant', kind: 'run', text: 'Send a text message to ⟦•••⟧', runId: 'r1', meta, createdAt: '2026-11-19T10:00:00.000Z' });
const run = (over: Partial<ChatRun> = {}): ChatRun => ({
  id: 'r1', status: 'succeeded', goal: 'Send a text', stepCount: 3, activity: null, result: 'Sent', error: null, stopReason: null, cancelRequested: false, hostId: null, costUsd: 0, costKnown: true,
  createdAt: '2026-11-19T10:00:00.000Z', startedAt: '2026-11-19T10:00:01.000Z', finishedAt: '2026-11-19T10:01:00.000Z', ...over,
});

function card(m: ChatMessage, r: ChatRun | null) {
  render(
    <MemoryRouter>
      <BrowserCard message={m} run={r} frame={{ src: null, shotAt: null, failing: false }} frameHidden={false} now={Date.now()} paneOpen={false} onOpen={() => undefined} onVisible={() => undefined} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('the Browser card of a task run', () => {
  it('says which task, with a link to it, after the run ends', () => {
    card(message({ taskId: TASK, taskName: 'Send a text' }), run());
    expect(screen.getByTestId('using-task')).toHaveTextContent('Using your task "Send a text"');
    expect(screen.getByRole('link', { name: '"Send a text"' })).toHaveAttribute('href', `/tasks/${TASK}`);
  });

  it('says it while the run is live, as the first line under the status', () => {
    card(message({ taskId: TASK, taskName: 'Send a text' }), run({ status: 'running', finishedAt: null }));
    expect(screen.getByTestId('using-task')).toHaveTextContent('Using your task "Send a text"');
  });

  it('says nothing for a run the chat started without a task', () => {
    card(message(null), run());
    expect(screen.queryByTestId('using-task')).not.toBeInTheDocument();
    expect(runTaskOf({ kind: 'run', meta: { taskId: 7 } })).toBeNull();
    expect(runTaskOf({ kind: 'text', meta: { taskId: TASK, taskName: 'x' } })).toBeNull();
  });
});

describe('"Use my saved tasks when one fits" (#1007)', () => {
  it('is on by default and saves a change at once', async () => {
    const host = createTestPlatformHost({
      permissions: [],
      responses: { 'GET /user-settings': { version: 1 }, 'PATCH /user-settings': (r: TestApiRequest) => ({ version: 2, chat: (r.body as { chat: unknown }).chat }) },
    });
    render(
      <PlatformHostProvider host={host}>
        <UseSavedTasksSwitch />
      </PlatformHostProvider>,
    );
    const toggle = await screen.findByRole('switch', { name: USE_SAVED_TASKS_LABEL });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(host.requests.some((r) => r.method === 'PATCH')).toBe(true));
    expect(host.requests.find((r) => r.method === 'PATCH')!.body).toEqual({ chat: { useSavedTasks: false } });
    await waitFor(() => expect(toggle).not.toBeChecked());
  });
});
