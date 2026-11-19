// The chat's Browser card, browser pane and result card (#487): the card's
// states, where "Open browser" puts the browser at each width, Stop and Take
// over, the picture hidden while a secret is asked for, and the result.
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest, type TestPlatformHost } from '@marinoscar/platform-web/testing';

import type { ChatStreamEvent } from '../live';

// The chat's stream, the run's stream and the screenshot fetch, driven by the test.
const live = vi.hoisted(() => ({
  chat: new Map<string, (e: unknown) => void>(),
  runs: new Map<string, (e: unknown) => void>(),
  shots: [] as string[],
  shot: 'blob:frame' as string | null,
}));
vi.mock('../live', () => ({
  subscribeChat: (id: string, _afterSeq: number, onEvent: (e: unknown) => void) => {
    live.chat.set(id, onEvent);
    return () => void live.chat.delete(id);
  },
  subscribeRun: (id: string, onEvent: (e: unknown) => void) => {
    live.runs.set(id, onEvent);
    return () => void live.runs.delete(id);
  },
  fetchRunScreenshot: async (id: string) => {
    live.shots.push(id);
    return live.shot;
  },
}));

import { browserStatusLine } from '../components/ChatBrowser';
import { ChatPage } from '../pages/ChatPage';
import type { Chat, ChatDetail, ChatMessage, ChatRun } from '../types/chat';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { mockViewport } from './matchMedia';
import { POLICY_READS } from './policyFixtures';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const ALL = ['chat:read', 'chat:write', 'runs:read', 'runs:write', 'fleet:read', 'fleet:desktop', 'agent_policies:read'];
const CHAT_ID = '88888888-8888-4888-8888-888888888888';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const OLD_RUN = '33333333-3333-4333-8333-333333333334';
const HOST_ID = '44444444-4444-4444-8444-444444444444';
const GOAL = 'Book 2 tickets for the 7:30 PM showing.';

const base: Chat = { id: CHAT_ID, title: 'Cinema tickets', status: 'active', profile: 'default', hostId: null, hostFallback: true, policyId: null, allowedDomains: [], confirmRiskyActions: true, lastMessageAt: '2026-11-17T10:05:00Z', createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T10:05:00Z' };
const message = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${seq}`, seq, role: 'assistant', kind: 'text', text: `message ${seq}`, runId: null, meta: null, createdAt: '2026-11-17T10:00:00Z', ...over });
const runMessage = (seq = 2, runId: string | null = RUN_ID) => message(seq, { kind: 'run', text: GOAL, runId });
const run = (over: Partial<ChatRun> = {}): ChatRun => ({ id: RUN_ID, status: 'running', goal: GOAL, stepCount: 3, activity: { phase: 'acting', action: 'click', startedAt: '2026-11-17T10:04:00Z' } as ChatRun['activity'], result: null, error: null, stopReason: null, cancelRequested: false, hostId: HOST_ID, costUsd: 0.12, costKnown: true, createdAt: '2026-11-17T10:03:00Z', startedAt: '2026-11-17T10:03:05Z', finishedAt: null, ...over });
const detail = (messages: ChatMessage[], over: Partial<ChatDetail> = {}): ChatDetail => ({ ...base, messages, hasMore: false, liveRun: null, thinking: false, ...over });
const LIVE = detail([message(1, { role: 'user', text: 'Book two cinema tickets' }), runMessage()], { liveRun: { id: RUN_ID, status: 'running' } });

let restoreViewport: (() => void) | null = null;
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
  URL.revokeObjectURL = () => undefined;
});
afterEach(() => {
  restoreViewport?.();
  restoreViewport = null;
  live.chat.clear();
  live.runs.clear();
  live.shots.length = 0;
  live.shot = 'blob:frame';
  dismissToast();
});

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

interface MountOptions {
  chat?: ChatDetail;
  responses?: Record<string, unknown>;
  permissions?: string[];
  width?: number;
}
function mount({ chat = LIVE, responses = {}, permissions = ALL, width = 1440 }: MountOptions = {}): TestPlatformHost {
  restoreViewport = mockViewport(width);
  let seq = 100;
  const host = createTestPlatformHost({
    permissions,
    responses: {
      ...POLICY_READS,
      'GET /fleet/hosts': [],
      'GET /chats': { items: [], nextCursor: null },
      [`GET /chats/${CHAT_ID}`]: chat,
      [`POST /chats/${CHAT_ID}/messages`]: (req: TestApiRequest) => message(++seq, { role: 'user', text: (req.body as { text: string }).text }),
      [`POST /runs/${RUN_ID}/cancel`]: {},
      [`POST /runs/${RUN_ID}/pause`]: {},
      [`POST /runs/${RUN_ID}/resume`]: {},
      [`GET /runs/${RUN_ID}/viewer`]: { hostId: HOST_ID, hostName: 'mini-pc', desktop: true },
      ...responses,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter initialEntries={[`/chat/${CHAT_ID}`]}>
        <ConfirmProvider>
          <Routes>
            <Route path="/chat/new" element={<ChatPage />} />
            <Route path="/chat/:id" element={<ChatPage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
          <Where />
        </ConfirmProvider>
        <ToastHost />
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}

const emit = (event: ChatStreamEvent) => act(() => live.chat.get(CHAT_ID)?.(event));
const runEvent = (over: Partial<ChatRun> = {}) => emit({ type: 'run', data: { run: run(over) } });
const card = () => screen.findByRole('article', { name: 'Browser run' });
const sent = (host: TestPlatformHost, method: string, path: string) => host.requests.filter((r) => r.method === method && r.path === path);
const openBrowser = async () => fireEvent.click(within(await card()).getByRole('button', { name: 'Open browser' }));
const pane = () => screen.findByRole('region', { name: 'Browser' });

describe('the Browser card', () => {
  it('is live from the first read, then follows the run: what it is doing, its picture, one card', async () => {
    mount();
    const c = await card();
    // Known from the read alone, before the stream says more.
    expect(within(c).getByRole('status')).toHaveTextContent('Working…');
    expect(within(c).getByRole('button', { name: 'Open browser' })).toBeEnabled();
    expect(await within(c).findByRole('img', { name: 'The browser right now' })).toHaveAttribute('src', 'blob:frame');
    expect(live.shots[0]).toBe(RUN_ID);

    runEvent();
    expect(within(c).getByRole('status')).toHaveTextContent('Doing: click…');
    runEvent({ status: 'waiting_human', activity: null });
    expect(within(c).getByRole('status')).toHaveTextContent('Waiting for you');
    runEvent({ stepCount: 9 });
    expect(within(c).getByText('Steps (9)')).toBeInTheDocument();
    expect(screen.getAllByRole('article', { name: 'Browser run' })).toHaveLength(1);
  });

  it('says in words what each live state is', () => {
    expect(browserStatusLine({ status: 'queued', activity: null, cancelRequested: false })).toBe('Starting the browser…');
    expect(browserStatusLine({ status: 'running', activity: null, cancelRequested: false })).toBe('Working…');
    expect(browserStatusLine({ status: 'waiting_human', activity: null, cancelRequested: false })).toBe('Waiting for you');
    expect(browserStatusLine({ status: 'running', activity: null, cancelRequested: true })).toBe('Stopping…');
    expect(browserStatusLine({ status: 'succeeded', activity: null, cancelRequested: false })).toBe('');
  });

  it.each([
    ['succeeded', /succeeded/i],
    ['failed', /failed/i],
    ['cancelled', /cancelled/i],
  ] as const)('settles when the run ends (%s): the status, no picture, no Open browser, a link to the run', async (status, words) => {
    mount();
    await openBrowser();
    await pane();
    runEvent({ status, finishedAt: '2026-11-17T10:09:00Z', stopReason: status === 'succeeded' ? 'finished' : status === 'cancelled' ? 'cancelled' : 'error' });

    const c = await card();
    expect(within(c).getByText(words)).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: /Open browser|Browser is open/ })).not.toBeInTheDocument();
    expect(within(c).queryByRole('img', { name: 'The browser right now' })).not.toBeInTheDocument();
    expect(within(c).getByRole('link', { name: /Open run/ })).toHaveAttribute('href', `/runs/${RUN_ID}`);
    // The pane belonged to the live run.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Browser' })).not.toBeInTheDocument());
  });

  it('shows an earlier run of the chat as settled, and a deleted run as deleted', async () => {
    mount({ chat: detail([runMessage(1, OLD_RUN), runMessage(2, null), runMessage(3, RUN_ID)], { liveRun: { id: RUN_ID, status: 'queued' } }) });
    const cards = await screen.findAllByRole('article', { name: 'Browser run' });
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).queryByRole('button', { name: 'Open browser' })).not.toBeInTheDocument();
    expect(within(cards[0]!).getByRole('link', { name: /Open run/ })).toHaveAttribute('href', `/runs/${OLD_RUN}`);
    expect(within(cards[1]!).getByText('This run was deleted.')).toBeInTheDocument();
    expect(within(cards[2]!).getByRole('status')).toHaveTextContent('Starting the browser…');
  });

  it('lists the steps once asked, from the run\'s own stream', async () => {
    mount();
    const c = await card();
    expect(live.runs.has(RUN_ID)).toBe(false);
    fireEvent.click(within(c).getByRole('button', { name: /Steps/ }));
    await waitFor(() => expect(live.runs.has(RUN_ID)).toBe(true));
    expect(within(c).getByText('No steps yet.')).toBeInTheDocument();
    act(() => live.runs.get(RUN_ID)!({ type: 'step', data: { id: 's1', seq: 1, kind: 'action', action: 'navigate', args: null, ok: true, summary: 'Opened the cinema site', reasoning: null, createdAt: '2026-11-17T10:04:00Z' } }));
    expect(await within(c).findByText(/Opened the cinema site/)).toBeInTheDocument();
  });

  it('hides the picture while the run waits for a secret, in the card and in the pane, and asks for no frame', async () => {
    mount();
    const c = await card();
    await within(c).findByRole('img', { name: 'The browser right now' });
    emit({ type: 'question', data: { question: { id: 'q1', input: 'secret', kind: 'code', prompt: 'Enter the code' } } });
    expect(within(c).queryByRole('img', { name: 'The browser right now' })).not.toBeInTheDocument();
    expect(within(c).getByText('The browser is hidden while it waits for a secret.')).toBeInTheDocument();
    const before = live.shots.length;
    await openBrowser();
    expect(within(await pane()).getByText('The browser is hidden while it waits for a secret.')).toBeInTheDocument();
    expect(live.shots.length).toBe(before);

    emit({ type: 'question', data: { question: null } });
    expect(await within(await pane()).findByRole('img', { name: 'The browser right now' })).toBeInTheDocument();
  });

  it('shows no broken picture when the browser cannot be read: it says it is waiting', async () => {
    live.shot = null;
    mount();
    const c = await card();
    expect(await within(c).findByText(/No frame yet: the browser is not answering|Waiting for the first frame/)).toBeInTheDocument();
    expect(within(c).queryByRole('img', { name: 'The browser right now' })).not.toBeInTheDocument();
  });
});

describe('Open browser', () => {
  it('on a wide window opens a pane beside the thread; the card hands its picture over; Close gives it back', async () => {
    mount({ width: 1440 });
    await openBrowser();
    const p = await pane();
    expect(await within(p).findByRole('img', { name: 'The browser right now' })).toBeInTheDocument();
    const c = await card();
    expect(within(c).getByRole('button', { name: 'Browser is open' })).toBeDisabled();
    expect(within(c).queryByRole('img', { name: 'The browser right now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Browser' })).not.toBeInTheDocument();
    // The thread is still there beside it.
    expect(screen.getByRole('log', { name: 'Messages' })).toBeInTheDocument();

    fireEvent.click(within(p).getByRole('button', { name: 'Close the browser' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Browser' })).not.toBeInTheDocument());
    expect(within(c).getByRole('button', { name: 'Open browser' })).toBeEnabled();
  });

  it('on a tablet opens a panel in the page, above the thread', async () => {
    mount({ width: 768 });
    await openBrowser();
    expect(await pane()).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Browser' })).not.toBeInTheDocument();
    expect(screen.getByRole('log', { name: 'Messages' })).toBeInTheDocument();
  });

  it('on a phone opens a full-screen sheet', async () => {
    mount({ width: 390 });
    await openBrowser();
    const sheet = await screen.findByRole('dialog', { name: 'Browser' });
    expect(within(sheet).getByRole('heading', { name: 'Browser' })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close the browser' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Browser' })).not.toBeInTheDocument());
  });
});

describe('Pause and Resume (E38.2)', () => {
  it('words the status line: Pausing… until the status changes, then Paused', () => {
    expect(browserStatusLine({ status: 'running', activity: null, cancelRequested: false, pauseRequested: true })).toBe('Pausing…');
    expect(browserStatusLine({ status: 'paused', activity: null, cancelRequested: false, pauseRequested: true })).toBe('Paused');
    expect(browserStatusLine({ status: 'running', activity: null, cancelRequested: true, pauseRequested: true })).toBe('Stopping…');
  });

  it('Pause sits beside Stop, says Pausing… at once and cannot be pressed twice; the banner then offers Resume and Stop, the browser and Take over stay', async () => {
    const host = mount();
    await openBrowser();
    const p = await pane();
    expect(within(p).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    fireEvent.click(within(p).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(sent(host, 'POST', `/runs/${RUN_ID}/pause`)).toHaveLength(1));
    const pausing = await within(p).findByRole('button', { name: 'Pausing…' });
    expect(pausing).toBeDisabled();
    runEvent({ pauseRequested: true });
    expect(within(p).getByText('Pausing…', { selector: 'p' })).toBeInTheDocument();

    // The run says it is paused: the banner, Resume and Stop; no Pause; the picture and Take over are still there.
    runEvent({ status: 'paused', activity: null, pauseRequested: true });
    const banner = await within(p).findByTestId('paused-banner');
    expect(banner).toHaveTextContent('Paused. Nothing happens until you resume.');
    expect(within(banner).getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(within(banner).getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(within(p).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: 'Pausing…' })).not.toBeInTheDocument();
    expect(await within(p).findByRole('img', { name: 'The browser right now' })).toBeInTheDocument();
    expect(await within(p).findByRole('link', { name: 'Take over on mini-pc' })).toBeInTheDocument();
    expect(within(p).getAllByRole('status').some((e) => e.textContent === 'Paused')).toBe(true);
    // The card in the thread says so too.
    expect(within(await card()).getByTestId('paused-banner')).toBeInTheDocument();

    fireEvent.click(within(banner).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sent(host, 'POST', `/runs/${RUN_ID}/resume`)).toHaveLength(1));
    runEvent({ status: 'queued', activity: null, pauseRequested: false });
    await waitFor(() => expect(within(p).queryByTestId('paused-banner')).not.toBeInTheDocument());
    // Running again: Pause is offered again, and not as "Pausing…".
    runEvent({ pauseRequested: false });
    expect(await within(p).findByRole('button', { name: 'Pause' })).toBeEnabled();
  });

  it('Stop on the paused banner asks first, then cancels', async () => {
    const host = mount({ chat: detail([message(1, { role: 'user', text: 'Book' }), runMessage()], { liveRun: { id: RUN_ID, status: 'paused' } }), responses: { [`GET /runs/${RUN_ID}/viewer`]: { hostId: null, hostName: null, desktop: false } } });
    await openBrowser();
    runEvent({ status: 'paused', activity: null, pauseRequested: true });
    const banner = await within(await pane()).findByTestId('paused-banner');
    fireEvent.click(within(banner).getByRole('button', { name: 'Stop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop this run?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(sent(host, 'POST', `/runs/${RUN_ID}/cancel`)).toHaveLength(1));
  });

  it('has no Pause, Resume or Stop without runs:write', async () => {
    mount({ permissions: ALL.filter((x) => x !== 'runs:write') });
    await openBrowser();
    const p = await pane();
    expect(within(p).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    runEvent({ status: 'paused', activity: null, pauseRequested: true });
    const banner = await within(p).findByTestId('paused-banner');
    expect(within(banner).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('Stop and Take over', () => {
  it('Stop asks first, then cancels the run; Cancel in the dialog stops nothing', async () => {
    const host = mount();
    await openBrowser();
    const p = await pane();
    fireEvent.click(within(p).getByRole('button', { name: 'Stop' }));
    let dialog = await screen.findByRole('dialog', { name: 'Stop this run?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Stop this run?' })).not.toBeInTheDocument());
    expect(sent(host, 'POST', `/runs/${RUN_ID}/cancel`)).toHaveLength(0);

    fireEvent.click(within(p).getByRole('button', { name: 'Stop' }));
    dialog = await screen.findByRole('dialog', { name: 'Stop this run?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(sent(host, 'POST', `/runs/${RUN_ID}/cancel`)).toHaveLength(1));

    // At once (E38.1), before the run says anything: the button says it is stopping and cannot be pressed twice.
    const stopping = await within(p).findByRole('button', { name: 'Stopping…' });
    expect(stopping).toBeDisabled();
    fireEvent.click(stopping);
    expect(sent(host, 'POST', `/runs/${RUN_ID}/cancel`)).toHaveLength(1);
    expect(within(p).getByRole('status')).toHaveTextContent('Stopping…');

    // The run then says so itself: the same.
    runEvent({ cancelRequested: true });
    expect(await within(p).findByRole('button', { name: 'Stopping…' })).toBeDisabled();
  });

  it('has no Stop without runs:write', async () => {
    mount({ permissions: ALL.filter((x) => x !== 'runs:write') });
    await openBrowser();
    expect(within(await pane()).queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('offers Take over on the machine that runs the browser, when it has a desktop to open', async () => {
    mount();
    await openBrowser();
    expect(await within(await pane()).findByRole('link', { name: 'Take over on mini-pc' })).toHaveAttribute('href', `/fleet/hosts/${HOST_ID}/desktop`);
  });

  it('has no Take over without fleet:desktop (and does not ask where the browser is), nor for a machine without a desktop', async () => {
    const host = mount({ permissions: ALL.filter((x) => x !== 'fleet:desktop') });
    await openBrowser();
    const p = await pane();
    await within(p).findByRole('img', { name: 'The browser right now' });
    expect(within(p).queryByRole('link', { name: /Take over/ })).not.toBeInTheDocument();
    expect(sent(host, 'GET', `/runs/${RUN_ID}/viewer`)).toHaveLength(0);
  });

  it('has no Take over for a machine without a desktop', async () => {
    const host = mount({ responses: { [`GET /runs/${RUN_ID}/viewer`]: { hostId: HOST_ID, hostName: 'mini-pc', desktop: false } } });
    await openBrowser();
    const p = await pane();
    await waitFor(() => expect(sent(host, 'GET', `/runs/${RUN_ID}/viewer`)).toHaveLength(1));
    expect(within(p).queryByRole('link', { name: /Take over/ })).not.toBeInTheDocument();
    expect(within(p).getByRole('link', { name: /Open run/ })).toHaveAttribute('href', `/runs/${RUN_ID}`);
  });
});

describe('the result card', () => {
  const result = (over: Partial<ChatMessage> = {}) => message(3, { kind: 'result', text: 'Booked seats F7 and F8.', runId: RUN_ID, meta: { status: 'succeeded', stopReason: 'finished', costUsd: 0.21, costKnown: true, stepCount: 14 }, ...over });
  const finished = (r: ChatMessage) => detail([message(1, { role: 'user', text: 'Book two cinema tickets' }), runMessage(), r]);

  it('shows the result, how many steps it took, what it cost, and a link to the run', async () => {
    mount({ chat: finished(result()) });
    const c = await screen.findByRole('article', { name: 'Result' });
    expect(c).toHaveTextContent('Done');
    expect(c).toHaveTextContent('Booked seats F7 and F8.');
    expect(c).toHaveTextContent('14 steps · $0.21');
    expect(within(c).getByRole('link', { name: /Open run/ })).toHaveAttribute('href', `/runs/${RUN_ID}`);
  });

  it('says why a run stopped short, and marks a cost that is a lower bound', async () => {
    mount({ chat: finished(result({ text: 'Ran out of budget.', meta: { status: 'failed', stopReason: 'budget_cost', costUsd: 2, costKnown: false, stepCount: 1 } })) });
    const c = await screen.findByRole('article', { name: 'Result' });
    expect(c).toHaveTextContent('Could not finish');
    expect(c).toHaveTextContent(/Stopped: .*cost/i);
    expect(c).toHaveTextContent('1 step · ≥ $2.00');
  });

  it('Run again asks for the same job in the chat', async () => {
    const host = mount({ chat: finished(result()) });
    fireEvent.click(within(await screen.findByRole('article', { name: 'Result' })).getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(sent(host, 'POST', `/chats/${CHAT_ID}/messages`)[0]?.body).toEqual({ text: `Run this again: ${GOAL}` }));
  });

  it('a run that ended after a confirmed step says so, in the warning tone, and Run again asks first (#540)', async () => {
    const lead = "The step you confirmed was carried out (step 58: 'Send $10 to Person A?'), but the run ended before it could check the outcome. Check before you run it again.";
    const host = mount({ chat: finished(result({ text: `${lead}\n\nStep budget exhausted`, meta: { status: 'failed', stopReason: 'budget_actions', costUsd: 0.5, costKnown: true, stepCount: 60, confirmedActions: 1 } })) });
    const c = await screen.findByRole('article', { name: 'Result' });
    expect(c).toHaveTextContent('Ended after a confirmed step');
    expect(c).not.toHaveTextContent('Could not finish');
    expect(c).toHaveAttribute('data-tone', 'warning');
    fireEvent.click(within(c).getByRole('button', { name: 'Run again' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent("This run already carried out a step you confirmed: 'Send $10 to Person A?'. Running it again may do it twice.");
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sent(host, 'POST', `/chats/${CHAT_ID}/messages`)).toHaveLength(0);
    fireEvent.click(within(c).getByRole('button', { name: 'Run again' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(sent(host, 'POST', `/chats/${CHAT_ID}/messages`)[0]?.body).toEqual({ text: `Run this again, knowing the step I confirmed was already carried out: ${GOAL}` }));
  });

  it('a succeeded run with a confirmed step keeps "Done" but still asks before Run again', async () => {
    const host = mount({ chat: finished(result({ meta: { status: 'succeeded', stopReason: 'finished', costUsd: 0.2, costKnown: true, stepCount: 14, confirmedActions: 1 } })) });
    const c = await screen.findByRole('article', { name: 'Result' });
    expect(c).toHaveTextContent('Done');
    fireEvent.click(within(c).getByRole('button', { name: 'Run again' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Run this again?');
    expect(sent(host, 'POST', `/chats/${CHAT_ID}/messages`)).toHaveLength(0);
  });

  it('has no Run again while a run is live, in an archived chat, or without chat:write', async () => {
    mount({ chat: detail([runMessage(1, OLD_RUN), result({ seq: 2, id: 'm2', runId: OLD_RUN }), runMessage(3)], { liveRun: { id: RUN_ID, status: 'running' } }) });
    expect(within(await screen.findByRole('article', { name: 'Result' })).queryByRole('button', { name: 'Run again' })).not.toBeInTheDocument();
  });

  it.each([
    ['an archived chat', { chat: { ...detail([]), status: 'archived' as const }, permissions: ALL }],
    ['a viewer without chat:write', { chat: detail([]), permissions: ALL.filter((x) => x !== 'chat:write') }],
  ])('has no Run again in %s', async (_name, opts) => {
    mount({ chat: { ...opts.chat, messages: [runMessage(), result()] }, permissions: opts.permissions });
    expect(within(await screen.findByRole('article', { name: 'Result' })).queryByRole('button', { name: 'Run again' })).not.toBeInTheDocument();
  });
});
