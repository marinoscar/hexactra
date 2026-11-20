// The trace in the console (#544): each question with its answer, the owner's
// guidance, the confirmed marker, the key-moment pictures with a lightbox and a
// "Pictures" filter, and Export (JSON trace, PDF report) from the run page, the
// chat's result card and the run list.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestBlobResponse, createTestPlatformHost, type TestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../live', () => ({
  subscribeRun: () => () => undefined,
  fetchRunScreenshot: async () => null,
}));

import { defaultPaper, filenameFromDisposition, runExportPath } from '../api';
import { ResultCard } from '../components/ChatBrowser';
import { EXPORT_NOTE, EXPORT_SCREENSHOTS_KEY } from '../components/RunExport';
import { RunList } from '../components/RunList';
import { RunTimeline, type RunTimelineStep } from '../components/RunTimeline';
import { answerLine, formAnswerLines, guidanceText, imageCaptionLong, questionKindLabel } from '../components/runTrace';
import { RunDetailPage } from '../pages/RunDetailPage';
import type { ChatMessage } from '../types/chat';
import type { Run, StepQuestion } from '../types/runs';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';

const RUN_ID = '44444444-4444-4444-8444-444444444444';
const Q1 = '55555555-5555-4555-8555-555555555551';
const Q2 = '55555555-5555-4555-8555-555555555552';
const Q3 = '55555555-5555-4555-8555-555555555553';

const LONG_PROMPT = `Pay $42.00 to Example Utilities from the checking account ending 0659? ${'The bill covers the last two months of service and late fees. '.repeat(6)}End of the prompt.`;

const question = (over: Partial<StepQuestion> = {}): StepQuestion => ({
  id: Q1,
  kind: 'confirmation',
  input: 'confirm',
  prompt: LONG_PROMPT,
  options: null,
  risk: 'high',
  status: 'answered',
  answer: { outcome: 'completed', value: 'approve', valueWithheld: false, channel: 'web', answeredAt: '2026-11-15T12:41:38Z' },
  ...over,
});

let n = 0;
const step = (seq: number, over: Partial<RunTimelineStep> = {}): RunTimelineStep => ({
  id: `t${++n}`,
  seq,
  kind: 'action',
  action: 'click',
  ok: true,
  summary: `Step ${seq}`,
  args: null,
  reasoning: null,
  durationMs: 500,
  createdAt: '2026-11-15T12:40:00Z',
  ...over,
});

/** A run with two questions, guidance, a confirmed step and five pictures. */
const traceSteps = (): RunTimelineStep[] => [
  step(1, { action: 'navigate', summary: 'Opened https://bills.example.test' }),
  step(2, { kind: 'handoff', action: 'confirm', summary: LONG_PROMPT.slice(0, 300), questionId: Q1, question: question(), hasScreenshot: true, screenshotMoment: 'before_confirmed', screenshotMasked: 2 }),
  step(3, { kind: 'handoff', action: 'answered', summary: 'The owner allowed it', questionId: Q1, question: question(), createdAt: '2026-11-15T12:41:38Z' }),
  step(4, { action: 'click', summary: 'Clicked "Pay now"', hasScreenshot: true, screenshotMoment: 'after_confirmed', screenshotMasked: 1 }),
  step(5, { kind: 'guidance', action: null, summary: 'The owner added: use the saved card instead' }),
  step(6, { kind: 'handoff', action: 'ask', summary: 'Sign in', questionId: Q2, question: question({ id: Q2, kind: 'login', input: 'credentials', prompt: 'Sign in to bills.example.test', answer: { outcome: 'completed', valueWithheld: true, channel: 'cli', answeredAt: '2026-11-15T12:42:10Z' } }), hasScreenshot: true, screenshotMoment: 'question', screenshotMasked: 0 }),
  step(7, { ok: false, action: 'click', summary: 'The button did not respond', hasScreenshot: true, screenshotMoment: 'failure', screenshotMasked: null }),
  step(8, { kind: 'end', action: null, summary: 'The run ended', hasScreenshot: true, screenshotMoment: 'final', screenshotMasked: 3 }),
];

function hostWith(over: { permissions?: string[]; responses?: Record<string, unknown> } = {}): TestPlatformHost {
  const responses: Record<string, unknown> = { ...over.responses };
  for (const seq of [2, 4, 6, 7, 8]) responses[`GET /runs/${RUN_ID}/steps/${seq}/screenshot`] ??= createTestBlobResponse(`image-${seq}`, { 'Content-Type': 'image/jpeg' });
  return createTestPlatformHost({ permissions: over.permissions ?? ['runs:read', 'runs:write', 'runs:delete'], responses });
}

function renderTimeline(steps: RunTimelineStep[], opts: { host?: TestPlatformHost; live?: boolean; confirmedSeqs?: number[]; runId?: string | null; fromChat?: boolean } = {}) {
  const host = opts.host ?? hostWith();
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter>
        <RunTimeline steps={steps} live={opts.live ?? false} runId={opts.runId === null ? undefined : (opts.runId ?? RUN_ID)} confirmedSeqs={opts.confirmedSeqs} fromChat={opts.fromChat} />
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}

let urls = 0;
const created: string[] = [];
const revoked: string[] = [];
let restore: (() => void) | null = null;
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // storage may be unavailable
  }
  URL.createObjectURL = vi.fn(() => {
    const u = `blob:test-${++urls}`;
    created.push(u);
    return u;
  });
  URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u));
});
afterEach(() => {
  restore?.();
  restore = null;
  created.length = 0;
  revoked.length = 0;
});

describe('the answer line (#544)', () => {
  it('reads each answer state', () => {
    const asked = '2026-11-15T12:41:00Z';
    const allowed = answerLine(question(), { askedAt: asked, fromChat: true, timeZone: 'UTC' });
    expect(allowed.text).toMatch(/^Allowed · from the chat · 12:41\sPM · waited 38 s$/);
    expect(allowed.state).toBe('answered');
    expect(answerLine(question({ answer: { outcome: 'completed', value: 'deny', valueWithheld: false, channel: 'web', answeredAt: null } })).text).toBe('Declined · from the console');
    expect(answerLine(question({ answer: { outcome: 'cancelled', valueWithheld: false, channel: null, answeredAt: null } })).text).toBe('Declined');
    expect(answerLine(question({ input: 'secret', kind: 'code', answer: { outcome: 'completed', valueWithheld: true, channel: null, answeredAt: null } })).text).toBe('Provided (not recorded)');
    expect(answerLine(question({ status: 'expired', answer: null })).text).toBe('Expired');
    expect(answerLine(question({ status: 'pending', answer: null }))).toEqual({ text: 'Waiting for your answer', state: 'pending' });
    expect(answerLine(question({ input: 'choice', options: [{ id: 'a', label: 'Window seat' }], answer: { outcome: 'completed', value: 'a', valueWithheld: false, channel: 'mcp-app.chatgpt', answeredAt: null } })).text).toBe('Chose: Window seat · from an AI app');
  });

  it('names the kind and the guidance', () => {
    expect(questionKindLabel({ kind: 'confirmation', input: 'confirm' })).toBe('Confirmation');
    expect(questionKindLabel({ kind: 'login', input: 'credentials' })).toBe('Sign-in');
    expect(questionKindLabel({ kind: 'code', input: 'secret' })).toBe('Code');
    expect(questionKindLabel({ kind: 'other', input: 'choice' })).toBe('Choice');
    expect(guidanceText('The owner added: use the saved card')).toBe('You added: use the saved card');
    expect(imageCaptionLong({ screenshotMoment: 'final', screenshotMasked: 1 })).toBe('Final screen · 1 area masked');
  });
});

describe('the timeline as a trace (#544)', () => {
  it('a question step shows the full prompt, its kind and the answer; a withheld value is never shown', async () => {
    const steps = traceSteps();
    renderTimeline(steps, { fromChat: true });
    const q = screen.getByTestId('step-2');
    expect(within(q).getByTestId('question-prompt-2').textContent).toBe(LONG_PROMPT);
    expect(LONG_PROMPT.length).toBeGreaterThan(300);
    expect(within(q).getByText('Confirmation')).toBeInTheDocument();
    expect(within(q).getByTestId('answer-2').textContent).toMatch(/^Allowed · from the chat · .+ · waited 1 min$/);
    const signIn = screen.getByTestId('step-6');
    expect(within(signIn).getByText('Sign-in')).toBeInTheDocument();
    expect(within(signIn).getByTestId('answer-6').textContent).toMatch(/^Provided \(not recorded\) · from the CLI/);
    // The answer step reads as an answer, not an action.
    expect(screen.getByTestId('step-3')).toHaveAttribute('data-kind', 'answer');
    expect(screen.getByTestId('step-3')).toHaveTextContent('3. The owner allowed it');
  });

  it('a pending question links to its card; an expired one says so', () => {
    renderTimeline([step(1, { kind: 'handoff', action: 'confirm', questionId: Q3, question: question({ id: Q3, status: 'pending', answer: null }) }), step(2, { kind: 'handoff', action: 'ask', question: question({ id: Q2, status: 'expired', answer: null }) })], { live: true });
    expect(screen.getByRole('link', { name: 'Waiting for your answer' })).toHaveAttribute('href', `/inbox/q/${Q3}`);
    expect(screen.getByTestId('answer-2')).toHaveTextContent('Expired');
  });

  it('a guidance step reads "You added: …" and a confirmed step is marked', () => {
    renderTimeline(traceSteps(), { confirmedSeqs: [4] });
    expect(screen.getByTestId('step-5')).toHaveTextContent('You added: use the saved card instead');
    expect(screen.getByTestId('step-5')).toHaveAttribute('data-kind', 'guidance');
    expect(within(screen.getByTestId('step-4')).getByText('Confirmed by you')).toBeInTheDocument();
  });

  it('shows a thumbnail with its caption, fetched with the session, alt text from the caption', async () => {
    const host = renderTimeline(traceSteps());
    const thumb = screen.getByTestId('thumb-2');
    expect(thumb).toHaveTextContent('The screen when the agent asked · 2 areas masked');
    const img = await within(thumb).findByRole('img', { name: 'The screen when the agent asked' });
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(screen.getByTestId('thumb-4')).toHaveTextContent('After the confirmed step · 1 area masked');
    expect(screen.getByTestId('thumb-7')).toHaveTextContent('When it stopped');
    expect(screen.getByTestId('thumb-8')).toHaveTextContent('Final screen · 3 areas masked');
    await waitFor(() => expect(host.requests.filter((r) => /\/steps\/\d+\/screenshot$/.test(r.path)).map((r) => r.path)).toContain(`/runs/${RUN_ID}/steps/8/screenshot`));
    // Only steps with a picture are asked for.
    expect(host.requests.some((r) => r.path === `/runs/${RUN_ID}/steps/1/screenshot`)).toBe(false);
  });

  it('an image that fails shows a neutral placeholder, not a broken image', async () => {
    const host = hostWith({ responses: { [`GET /runs/${RUN_ID}/steps/2/screenshot`]: () => Promise.reject(createTestApiError(404, 'Not found')) } });
    renderTimeline(traceSteps(), { host });
    const thumb = screen.getByTestId('thumb-2');
    expect(await within(thumb).findByTestId('picture-placeholder')).toHaveTextContent('Picture unavailable');
    expect(within(thumb).queryByRole('img', { name: 'The screen when the agent asked' })).toBeNull();
    // A picture that loads but cannot be decoded falls back too.
    const four = await within(screen.getByTestId('thumb-4')).findByRole('img', { name: 'After the confirmed step' });
    fireEvent.error(four);
    expect(await within(screen.getByTestId('thumb-4')).findByTestId('picture-placeholder')).toBeInTheDocument();
  });

  it('the lightbox: a labelled dialog, next and previous across the run, arrow keys, Escape and focus return', async () => {
    renderTimeline(traceSteps());
    const open = screen.getByRole('button', { name: 'Open the picture: After the confirmed step, step 4' });
    open.focus();
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: /After the confirmed step/ });
    expect(dialog).toHaveTextContent('Step 4 · 2 of 5 · 1 area masked');
    expect(await within(dialog).findByRole('img', { name: 'After the confirmed step' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next picture' }));
    expect(await screen.findByRole('dialog', { name: /The screen when the agent asked/ })).toHaveTextContent('Step 6 · 3 of 5');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Previous picture' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Step 4 · 2 of 5');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(screen.getByRole('dialog')).toHaveTextContent('Step 2 · 1 of 5');
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Previous picture' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(screen.getByRole('dialog')).toHaveTextContent('Step 8 · 5 of 5');
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Next picture' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it('"Pictures" shows only the steps with an image; the order toggle stays', () => {
    renderTimeline(traceSteps());
    const filter = screen.getByRole('button', { name: 'Pictures' });
    expect(filter).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(filter);
    expect(filter).toHaveAttribute('aria-pressed', 'true');
    const rows = within(screen.getByRole('list', { name: 'Steps' })).getAllByTestId(/^step-\d+$/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(['step-2', 'step-4', 'step-6', 'step-7', 'step-8']);
    expect(screen.getByRole('group', { name: 'Step order' })).toBeInTheDocument();
    fireEvent.click(filter);
    expect(within(screen.getByRole('list', { name: 'Steps' })).getAllByTestId(/^step-\d+$/)).toHaveLength(8);
  });

  it('a run with no stored pictures says so once, and has no filter', () => {
    renderTimeline([step(1), step(2)]);
    expect(screen.getByTestId('no-pictures')).toHaveTextContent('This run has no stored pictures.');
    expect(screen.queryByRole('button', { name: 'Pictures' })).toBeNull();
  });

  it('a live run without pictures yet, or a timeline without a run, has no such line', () => {
    renderTimeline([step(1)], { live: true });
    expect(screen.queryByTestId('no-pictures')).toBeNull();
  });
});

// ---- Export ----

const exportFile = (format: 'json' | 'pdf') => createTestBlobResponse(format === 'json' ? '{}' : '%PDF', { 'Content-Type': format === 'json' ? 'application/json' : 'application/pdf', 'Content-Disposition': `attachment; filename="hexactra-run-44444444-20261115.${format}"` });

function exportResponses(): Record<string, unknown> {
  return {
    [`GET /runs/${RUN_ID}/export`]: (req: { path: string }) => exportFile(req.path.includes('format=pdf') ? 'pdf' : 'json'),
  };
}

const finishedRun = (): Run => ({
  id: RUN_ID,
  taskId: null,
  status: 'succeeded',
  trigger: 'chat',
  goal: 'Pay the electricity bill',
  profile: 'default',
  result: 'Paid.',
  error: null,
  cancelRequested: false,
  stepCount: 8,
  createdAt: '2026-11-15T12:39:00Z',
  finishedAt: '2026-11-15T12:45:00Z',
  steps: traceSteps() as Run['steps'],
  confirmedActions: [{ seq: 4, prompt: 'Pay $42.00?', action: 'click', at: '2026-11-15T12:41:40Z' }],
});

function renderRunPage(run: Run, opts: { permissions?: string[]; responses?: Record<string, unknown> } = {}) {
  const host = hostWith({ permissions: opts.permissions, responses: { [`GET /runs/${run.id}`]: run, ...exportResponses(), ...opts.responses } });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[`/runs/${run.id}`]}>
          <Routes>
            <Route path="/runs/:id" element={<RunDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

const exports = (host: TestPlatformHost) => host.requests.filter((r) => r.path.startsWith(`/runs/${RUN_ID}/export`)).map((r) => r.path);

describe('the export client (#544)', () => {
  it('builds the URL and reads the file name', () => {
    expect(runExportPath(RUN_ID, { format: 'json', screenshots: true })).toBe(`/runs/${RUN_ID}/export?format=json&screenshots=embed`);
    expect(runExportPath(RUN_ID, { format: 'pdf', screenshots: false, paper: 'letter' })).toBe(`/runs/${RUN_ID}/export?format=pdf&screenshots=none&paper=letter`);
    expect(defaultPaper('en-US')).toBe('letter');
    expect(defaultPaper('de-DE')).toBe('a4');
    expect(defaultPaper('en')).toBe('a4');
    expect(filenameFromDisposition('attachment; filename="hexactra-run-1.json"')).toBe('hexactra-run-1.json');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).toBe('résumé.pdf');
    expect(filenameFromDisposition(null)).toBeNull();
  });
});

describe('Export on the run page (#544)', () => {
  it('both formats call the right URL with the screenshots flag and save under the server name', async () => {
    restore = mockViewport(1440);
    const clicks: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    const host = renderRunPage(finishedRun());
    const button = await screen.findByRole('button', { name: 'Export' });
    fireEvent.click(button);
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveTextContent(EXPORT_NOTE);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'PDF report' }));
    await waitFor(() => expect(clicks).toEqual(['hexactra-run-44444444-20261115.pdf']));
    expect(exports(host)[0]).toMatch(new RegExp(`^/runs/${RUN_ID}/export\\?format=pdf&screenshots=embed&paper=(a4|letter)$`));
    // The object URL is revoked after the click.
    await waitFor(() => expect(revoked).toContain(created.at(-1)));

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const box = await screen.findByRole('menuitemcheckbox', { name: 'Include screenshots' });
    expect(box).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(box);
    expect(box).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('menuitem', { name: 'JSON trace' }));
    await waitFor(() => expect(exports(host)).toContain(`/runs/${RUN_ID}/export?format=json&screenshots=none`));
    await waitFor(() => expect(clicks.at(-1)).toBe('hexactra-run-44444444-20261115.json'));
    click.mockRestore();
  });

  it('remembers "Include screenshots" in this browser', async () => {
    restore = mockViewport(1440);
    localStorage.setItem(EXPORT_SCREENSHOTS_KEY, 'false');
    renderRunPage(finishedRun());
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    const box = await screen.findByRole('menuitemcheckbox', { name: 'Include screenshots' });
    expect(box).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(box);
    expect(localStorage.getItem(EXPORT_SCREENSHOTS_KEY)).toBe('true');
  });

  it('works without storage', async () => {
    restore = mockViewport(1440);
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    renderRunPage(finishedRun());
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    const box = await screen.findByRole('menuitemcheckbox', { name: 'Include screenshots' });
    expect(box).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(box);
    expect(box).toHaveAttribute('aria-checked', 'false');
    get.mockRestore();
    set.mockRestore();
  });

  it('is disabled while the file is prepared, and cannot be pressed twice', async () => {
    restore = mockViewport(1440);
    let finish: (v: unknown) => void = () => undefined;
    const host = renderRunPage(finishedRun(), { responses: { [`GET /runs/${RUN_ID}/export`]: () => new Promise((r) => (finish = r)) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'JSON trace' }));
    const busy = await screen.findByRole('button', { name: 'Preparing…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(exports(host)).toHaveLength(1);
    await act(async () => finish(exportFile('json')));
    expect(await screen.findByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('EXPORT_TOO_LARGE shows the server message with the hint to leave the pictures out', async () => {
    restore = mockViewport(1440);
    renderRunPage(finishedRun(), { responses: { [`GET /runs/${RUN_ID}/export`]: () => Promise.reject(createTestApiError(413, 'The file would be over 50 MB.', 'EXPORT_TOO_LARGE')) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'PDF report' }));
    const line = await screen.findByText('The file would be over 50 MB. Turn off "Include screenshots" and export again.');
    expect(line.closest('[role="alert"]')).not.toBeNull();
  });

  it('is hidden without runs:read', async () => {
    restore = mockViewport(1440);
    renderRunPage(finishedRun(), { permissions: ['runs:write'] });
    await screen.findByRole('list', { name: 'Steps' });
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  it('a live run can be exported: the menu says the file is partial', async () => {
    restore = mockViewport(1440);
    renderRunPage({ ...finishedRun(), status: 'running', finishedAt: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('menu')).toHaveTextContent('The run is still going: the file is partial.');
  });

  it('below md it is in the sticky bar, opened and operated by keyboard', async () => {
    restore = mockViewport(390);
    const host = renderRunPage(finishedRun());
    const bar = await screen.findByRole('toolbar', { name: 'Run actions' });
    const button = within(bar).getByRole('button', { name: 'Export' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveStyle({ minHeight: '52px' });
    // Not in the header as well.
    expect(screen.getAllByRole('button', { name: 'Export' })).toHaveLength(1);
    button.focus();
    fireEvent.click(button);
    const menu = await screen.findByRole('menu');
    const items = [...within(menu).getAllByRole('menuitem'), within(menu).getByRole('menuitemcheckbox')];
    for (const item of items) expect(item).toHaveStyle({ minHeight: '44px' });
    // MUI moves focus to the first item; ArrowDown reaches the next one, Enter chooses it.
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.click(document.activeElement as HTMLElement);
    await waitFor(() => expect(exports(host)).toContain(`/runs/${RUN_ID}/export?format=json&screenshots=embed`));
  });

  it('the run page shows the trace: pictures and the confirmed marker', async () => {
    restore = mockViewport(1440);
    renderRunPage(finishedRun());
    expect(await screen.findByTestId('thumb-8')).toBeInTheDocument();
    expect(within(screen.getByTestId('step-4')).getByText('Confirmed by you')).toBeInTheDocument();
    expect(within(screen.getByTestId('step-2')).getByTestId('answer-2').textContent).toMatch(/from the chat/);
  });
});

describe('Export on the chat result card and the run list (#544)', () => {
  const result: ChatMessage = { id: 'm3', seq: 3, role: 'assistant', kind: 'result', text: 'Paid the bill.', runId: RUN_ID, meta: { status: 'succeeded', stepCount: 8 }, createdAt: '2026-11-15T12:45:00Z' } as ChatMessage;

  it('the result card has Export beside Open run', async () => {
    const host = hostWith({ responses: exportResponses() });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter>
          <ResultCard message={result} />
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    const card = screen.getByRole('article', { name: 'Result' });
    expect(within(card).getByRole('link', { name: /Open run/ })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'JSON trace' }));
    await waitFor(() => expect(exports(host)).toEqual([`/runs/${RUN_ID}/export?format=json&screenshots=embed`]));
  });

  it('the result card has no Export without runs:read', () => {
    render(
      <PlatformHostProvider host={hostWith({ permissions: ['chat:read'] })}>
        <MemoryRouter>
          <ResultCard message={result} />
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  it('the run list menu has Export PDF and Export JSON', async () => {
    restore = mockViewport(1440);
    const { steps: _steps, ...row } = finishedRun();
    const host = createTestPlatformHost({
      permissions: ['runs:read'],
      responses: {
        'GET /runs': { items: [row], nextCursor: null },
        'GET /runs/counts': { total: 1, live: 0, byStatus: { queued: 0, running: 0, waiting_human: 0, succeeded: 1, failed: 0, cancelled: 0 }, costUsd: null, costKnown: true },
        ...exportResponses(),
      },
    });
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <MemoryRouter>
            <RunList />
          </MemoryRouter>
        </ConfirmProvider>
      </PlatformHostProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Actions for Pay the electricity bill/ }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Open', 'Export PDF', 'Export JSON']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export PDF' }));
    await waitFor(() => expect(exports(host)[0]).toMatch(/format=pdf&screenshots=embed&paper=/));
  });
});

describe('a form in the trace (E40.2, #686)', () => {
  const form = { id: 'q1', kind: 'other', input: 'form', prompt: 'A few details to start "Pay": Amount, Card PIN', options: null, risk: null, status: 'answered', answer: { outcome: 'completed', valueWithheld: false, channel: 'web', answeredAt: null, fields: [{ key: 'amount', label: 'Amount', value: '40', provided: true as const }, { key: 'pin', label: 'Card PIN', provided: true as const }] } };
  it('says Provided and lists each field, with no value for a sensitive one', () => {
    expect(answerLine(form).text).toBe('Provided · from the console');
    expect(formAnswerLines(form)).toEqual(['Amount: 40', 'Card PIN: provided']);
    expect(questionKindLabel(form)).toBe('Details');
  });
});
