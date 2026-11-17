import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost } from '@marinoscar/platform-web/testing';

import { CONFIRMATION_MS } from '../components/QuestionCard';
import { InboxPage, mergeInbox, type InboxItem } from '../pages/InboxPage';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';

// The run's browser thumbnail: no network in a test. Each test says what the fetch returns.
const screenshot = vi.hoisted(() => ({ fetch: vi.fn<(id: string) => Promise<string | null>>() }));
vi.mock('../live', () => ({ fetchRunScreenshot: (id: string) => screenshot.fetch(id) }));

const base = {
  goal: 'Find a fare',
  askedBy: 'run:r',
  pageTitle: 'Flights',
  viewerUrl: null,
  choices: [],
  options: null,
  constraints: null,
  confirmLabel: null,
  denyLabel: null,
  risk: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
};
const code: InboxItem = { ...base, questionId: 'q1', runId: 'r1', handoffId: 'h1', kind: 'code', prompt: 'Enter the code sent to your phone', input: 'secret' };
const confirm: InboxItem = { ...base, questionId: 'q2', runId: 'r2', handoffId: 'h2', kind: 'confirmation', prompt: 'Book the 9:00 flight for $120?', input: 'none' };
const freeStanding: InboxItem = {
  ...base,
  questionId: 'q3',
  runId: null,
  handoffId: null,
  goal: 'Which sides?',
  askedBy: 'agent:packer',
  pageTitle: null,
  kind: 'other',
  prompt: 'Which sides?',
  input: 'multi_choice',
  choices: ['a', 'b'],
  options: [
    { id: 'a', label: 'Apples' },
    { id: 'b', label: 'Beans' },
  ],
};
const text: InboxItem = { ...base, questionId: 'q4', runId: null, handoffId: null, askedBy: 'agent:packer', pageTitle: null, kind: 'other', prompt: 'What should the note say?', input: 'text' };
// What the goal runner asks when a run is stuck and its policy says `ask_human`
// (goal-runner.service.ts: `{ kind: 'other', input: 'takeover', prompt: stallHandoffPrompt(reason, lastActions) }`).
const stall: InboxItem = {
  ...base,
  questionId: 'q5',
  runId: 'r5',
  handoffId: 'h5',
  kind: 'other',
  input: 'takeover',
  viewerUrl: 'https://viewer.example.test/s',
  prompt:
    'The agent is stuck: the same page 6 times in a row with no change. Its last actions: click(#submit) → click(#submit) → scroll(down) → click(#submit). Take over the browser to get it moving, then press Done.',
};

function renderInbox(host: ReturnType<typeof createTestPlatformHost>, at = '/inbox') {
  return render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[at]}>
          <InboxPage />
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
}

/** Lets pending promises and effects settle under fake timers. */
const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe('InboxPage', () => {
  let restoreViewport: (() => void) | null = null;
  beforeEach(() => {
    screenshot.fetch.mockReset();
    screenshot.fetch.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    restoreViewport?.();
    restoreViewport = null;
  });

  it('answers through the question broker: a secret and a confirmation', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: { 'GET /inbox': [code, confirm], 'POST /questions/q1/answer': {}, 'POST /questions/q2/answer': {} },
    });
    renderInbox(host);
    const secret = await screen.findByLabelText('Code');
    expect(secret).toHaveAttribute('autocomplete', 'one-time-code');
    fireEvent.change(secret, { target: { value: '987654' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // Dropped from the field at once.
    expect(secret).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(host.requests.filter((r) => r.method === 'POST')).toHaveLength(2));
    const posts = host.requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => [r.path, r.body])).toEqual(
      expect.arrayContaining([
        ['/questions/q1/answer', { outcome: 'completed', value: '987654', channel: 'web' }],
        ['/questions/q2/answer', { outcome: 'completed', channel: 'web' }],
      ]),
    );
  });

  it('answers a free-standing question (no run); declining a browser-bound one asks first and goes through cancel', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: { 'GET /inbox': [freeStanding, confirm], 'POST /questions/q3/answer': {}, 'POST /questions/q2/cancel': {} },
    });
    renderInbox(host);
    const card = await screen.findByLabelText('Request: Which sides?');
    expect(card).toHaveTextContent('Asked by packer');
    expect(screen.getByRole('link', { name: 'Find a fare' })).toHaveAttribute('href', '/runs/r2');
    expect(screen.getAllByRole('link', { name: 'Details' }).map((a) => a.getAttribute('href'))).toEqual(['/inbox/q/q3', '/inbox/q/q2']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Beans' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Apples' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(host.requests.some((r) => r.path === '/questions/q3/answer')).toBe(true));
    expect(host.requests.find((r) => r.path === '/questions/q3/answer')?.body).toEqual({ outcome: 'completed', values: ['a', 'b'], channel: 'web' });
    // The run's question: declining would leave the run stuck, so it asks.
    fireEvent.click(within(screen.getByLabelText('Request: Book the 9:00 flight for $120?')).getByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('The agent will be told you said no.');
    expect(host.requests.some((r) => r.path === '/questions/q2/cancel')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(host.requests.some((r) => r.path === '/questions/q2/cancel')).toBe(true));
  });

  it('a plain question declines at once; keeping a browser-bound one sends nothing', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /inbox': [freeStanding, confirm], 'POST /questions/q3/cancel': {} } });
    renderInbox(host);
    fireEvent.click(within(await screen.findByLabelText('Request: Which sides?')).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(host.requests.some((r) => r.path === '/questions/q3/cancel')).toBe(true));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText('Declined.')).toBeInTheDocument();
    fireEvent.click(within(screen.getByLabelText('Request: Book the 9:00 flight for $120?')).getByRole('button', { name: 'Decline' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(host.requests.some((r) => r.path === '/questions/q2/cancel')).toBe(false);
  });

  it('says when nothing is waiting', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { 'GET /inbox': [] } });
    renderInbox(host);
    expect(await screen.findByText('Nothing is waiting for you')).toBeInTheDocument();
    expect(screen.getByText('When an agent needs a code, a choice or your approval, it shows up here.')).toBeInTheDocument();
  });

  it('the header counts what is waiting; a viewer without runs:write sees no form', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { 'GET /inbox': [code, confirm] } });
    renderInbox(host);
    expect(await screen.findByText('2 waiting for you')).toBeInTheDocument();
    expect(screen.getAllByText('You can see this question but not answer it.')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('opens a notification deep link with its request first, marked and scrolled into view once', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { 'GET /inbox': [code, confirm] } });
      renderInbox(host, '/inbox?run=r2');
      const cards = await screen.findAllByLabelText(/^Request: /);
      expect(cards[0]).toHaveAttribute('aria-label', 'Request: Book the 9:00 flight for $120?');
      expect(cards[0]).toHaveAttribute('aria-current', 'true');
      expect(cards[1]).not.toHaveAttribute('aria-current');
      // The card scrolls in an effect, which React may run after the cards are already in the document:
      // wait for it instead of asserting in the same tick.
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
      expect(scroll.mock.contexts[0]).toBe(cards[0]);
      // Once: a later render does not pull the page back.
      await act(async () => undefined);
      expect(scroll).toHaveBeenCalledTimes(1);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('says when the linked request is gone', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { 'GET /inbox': [code] } });
    renderInbox(host, '/inbox?run=gone');
    expect(await screen.findByText('That request was already answered or expired.')).toBeInTheDocument();
  });

  it('a refresh while a field has a value keeps the value, the focus and the same input', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      // A new array of new objects on every poll, as the API returns.
      responses: { 'GET /inbox': () => ((calls += 1), [{ ...text }, { ...code }]) },
    });
    renderInbox(host);
    await flush();
    const field = screen.getByLabelText('Your answer');
    field.focus();
    fireEvent.change(field, { target: { value: 'Leave it with the neighbour' } });
    const secret = screen.getByLabelText('Code');
    fireEvent.change(secret, { target: { value: '424242' } });
    await advance(5_000);
    await advance(5_000);
    expect(calls).toBeGreaterThanOrEqual(3);
    // The same DOM nodes: the cards were not unmounted.
    expect(screen.getByLabelText('Your answer')).toBe(field);
    expect(field).toHaveValue('Leave it with the neighbour');
    expect(document.activeElement).toBe(field);
    expect(screen.getByLabelText('Code')).toBe(secret);
    expect(secret).toHaveValue('424242');
  });

  it('a request that arrives later goes on top, highlighted, and does not disturb the card being typed in', async () => {
    vi.useFakeTimers();
    let list: InboxItem[] = [text];
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /inbox': () => list } });
    renderInbox(host);
    await flush();
    const field = screen.getByLabelText('Your answer');
    field.focus();
    fireEvent.change(field, { target: { value: 'half typed' } });
    // The API lists the new request after the old one; the page still puts it first.
    list = [text, confirm];
    await advance(5_000);
    const cards = screen.getAllByLabelText(/^Request: /);
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Request: Book the 9:00 flight for $120?', 'Request: What should the note say?']);
    expect(cards[0]).toHaveAttribute('data-new', 'true');
    expect(cards[1]).not.toHaveAttribute('data-new');
    expect(screen.getByLabelText('Your answer')).toBe(field);
    expect(field).toHaveValue('half typed');
    expect(document.activeElement).toBe(field);
  });

  it('a failed answer shows its error inside that card and keeps what was typed', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: {
        'GET /inbox': [confirm, text],
        'POST /questions/q4/answer': () => {
          throw createTestApiError(500, 'The broker is not reachable');
        },
      },
    });
    renderInbox(host);
    const card = await screen.findByLabelText('Request: What should the note say?');
    fireEvent.change(within(card).getByLabelText('Your answer'), { target: { value: 'Ring twice' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    const alert = await within(card).findByRole('alert');
    expect(alert).toHaveTextContent('The broker is not reachable');
    // In the card, not at the top of the page; the other card has none.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(within(card).getByLabelText('Your answer')).toHaveValue('Ring twice');
    expect(within(card).getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('a failed secret answer shows the error but never keeps the secret', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: {
        'GET /inbox': [code],
        'POST /questions/q1/answer': () => {
          throw createTestApiError(502, 'The browser did not answer');
        },
      },
    });
    renderInbox(host);
    const field = await screen.findByLabelText('Code');
    fireEvent.change(field, { target: { value: '135790' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The browser did not answer');
    expect(screen.getByLabelText('Code')).toHaveValue('');
    expect(document.body.innerHTML).not.toContain('135790');
  });

  it('the countdown ticks, warns under a minute, and an expired request swaps to the expired state without a poll', async () => {
    vi.useFakeTimers();
    const soon: InboxItem = { ...text, expiresAt: new Date(Date.now() + 62_000).toISOString() };
    let calls = 0;
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /inbox': () => ((calls += 1), [soon]) } });
    renderInbox(host);
    await flush();
    const left = screen.getByLabelText('Time left');
    expect(left).toHaveTextContent(/^1 min 0\d s left$/);
    await advance(3_000);
    expect(left).toHaveTextContent(/^5\d s left$/);
    await advance(1_000);
    const before = calls;
    // Up to the expiry and no further: fewer than 5 s, so no poll in between.
    await advance(4_000);
    expect(screen.getByLabelText('Your answer')).toBeInTheDocument();
    await advance(55_000);
    expect(calls).toBeGreaterThan(before);
    expect(screen.getByText('This request expired.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Your answer')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Time left')).toHaveTextContent('expired');
  });

  it('an answered card says "Sent." for two seconds, then leaves; the other card stays', async () => {
    vi.useFakeTimers();
    let list: InboxItem[] = [text, confirm];
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: {
        'GET /inbox': () => list,
        'POST /questions/q4/answer': () => {
          list = [confirm];
          return {};
        },
      },
    });
    renderInbox(host);
    await flush();
    const card = screen.getByLabelText('Request: What should the note say?');
    fireEvent.change(within(card).getByLabelText('Your answer'), { target: { value: 'Ring twice' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    await flush();
    // The reload no longer lists it, but the card is still there, saying so.
    expect(within(card).getByRole('status')).toHaveTextContent('Sent.');
    expect(within(card).queryByLabelText('Your answer')).not.toBeInTheDocument();
    expect(screen.getByText('1 waiting for you')).toBeInTheDocument();
    await advance(CONFIRMATION_MS - 100);
    expect(screen.getByLabelText('Request: What should the note say?')).toBeInTheDocument();
    await advance(100);
    // It collapses (so the card below slides up, not jumps), then it is gone.
    await advance(1_000);
    expect(screen.queryByLabelText('Request: What should the note say?')).not.toBeInTheDocument();
    expect(screen.queryByText('Sent.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Request: Book the 9:00 flight for $120?')).toBeInTheDocument();
  });

  it('an answer refused because the question was answered elsewhere or expired shows that state, not an error', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: {
        'GET /inbox': [text],
        'POST /questions/q4/answer': () => {
          throw createTestApiError(409, 'This question was already answered', 'ALREADY_ANSWERED');
        },
      },
    });
    renderInbox(host);
    const card = await screen.findByLabelText('Request: What should the note say?');
    fireEvent.change(within(card).getByLabelText('Your answer'), { target: { value: 'Ring twice' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    expect(await within(card).findByText('This request was already answered or expired.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('a browser-bound request shows a thumbnail of its run; a tap opens it full screen', async () => {
    screenshot.fetch.mockImplementation(async (id) => `blob:shot-${id}`);
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /inbox': [code, freeStanding] } });
    renderInbox(host);
    const img = await screen.findByAltText("The run's browser right now");
    expect(img).toHaveAttribute('src', 'blob:shot-r1');
    // Only the request with a run asks for one.
    expect(screenshot.fetch.mock.calls.map((c) => c[0])).toEqual(['r1']);
    expect(screen.getAllByAltText("The run's browser right now")).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show the browser full screen' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByAltText("The run's browser right now, full size")).toHaveAttribute('src', 'blob:shot-r1');
  });

  it('renders nothing for the thumbnail when the screenshot fetch fails or rejects', async () => {
    screenshot.fetch.mockImplementation(async (id) => {
      if (id === 'r1') return null;
      throw new Error('network');
    });
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /inbox': [code, confirm] } });
    renderInbox(host);
    await screen.findByLabelText('Code');
    await waitFor(() => expect(screenshot.fetch).toHaveBeenCalledTimes(2));
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show the browser full screen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('the thumbnail refreshes every 5 s and revokes the frames it replaces and the last one on unmount', async () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    let n = 0;
    screenshot.fetch.mockImplementation(async () => `blob:frame-${(n += 1)}`);
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /inbox': [code] } });
    const { unmount } = renderInbox(host);
    await flush();
    await flush();
    expect(screen.getByAltText("The run's browser right now")).toHaveAttribute('src', 'blob:frame-1');
    await advance(5_000);
    expect(screen.getByAltText("The run's browser right now")).toHaveAttribute('src', 'blob:frame-2');
    expect(revoke).toHaveBeenCalledWith('blob:frame-1');
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:frame-2');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a stall question reads well on a phone: a readable kind chip, the whole prompt, then the takeover actions', async () => {
    restoreViewport = mockViewport(360);
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /inbox': [stall] } });
    renderInbox(host);
    const card = await screen.findByLabelText(/^Request: The agent is stuck/);
    // The runner asks with kind `other`: the chip says "Question", never a raw kind string.
    expect(within(card).getByText('Question')).toBeInTheDocument();
    const prompt = within(card).getByText(stall.prompt);
    const actions = within(card).getByTestId('question-actions');
    expect(prompt.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(actions).getAllByRole('button').map((b) => b.textContent)).toEqual(['Open the browser', 'Done', 'Decline']);
    expect(within(card).getByRole('link', { name: 'Find a fare' })).toHaveAttribute('href', '/runs/r5');
  });

  it('the page title is clamped with the full text in its title', async () => {
    const long = 'Checkout '.repeat(40).trim();
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { 'GET /inbox': [{ ...code, pageTitle: long }] } });
    renderInbox(host);
    expect(await screen.findByTitle(long)).toHaveTextContent(`on “${long}”`);
  });
});

describe('mergeInbox', () => {
  const item = (id: string): InboxItem => ({ ...text, questionId: id });
  const ids = (list: InboxItem[]) => list.map((i) => i.questionId);

  it('takes the first load as it is', () => {
    expect(ids(mergeInbox(null, [item('a'), item('b')], new Set()))).toEqual(['a', 'b']);
  });

  it('keeps the order on screen, puts new requests first and drops the ones that are gone', () => {
    expect(ids(mergeInbox([item('a'), item('b'), item('c')], [item('c'), item('d'), item('a')], new Set()))).toEqual(['d', 'a', 'c']);
  });

  it('keeps a request answered here until its card has left', () => {
    expect(ids(mergeInbox([item('a'), item('b')], [item('b')], new Set(['a'])))).toEqual(['a', 'b']);
  });

  it('takes the fresh copy of a request it already shows', () => {
    const fresh = { ...item('a'), prompt: 'changed' };
    expect(mergeInbox([item('a')], [fresh], new Set())[0]).toBe(fresh);
  });
});
