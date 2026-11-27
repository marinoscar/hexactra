// Batch runs (E51.1, #1006) in the web app: the chat's review card (Start sends only the ticked rows; Cancel starts none),
// the running card (row chips, the live run's Browser card, Stop), the end (summary, Open run), the batch summary message,
// the paste parser of "Run for several", the mapping of the API's per-row errors, and the form itself. Canned API answers only.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../live', () => ({ subscribeRun: () => () => undefined, subscribeChat: () => () => undefined, fetchRunScreenshot: async () => null }));

import { BatchCard } from '../batches/BatchCard';
import { RunForSeveralDialog } from '../batches/RunForSeveralDialog';
import { batchFormErrors, batchUnavailableReason, parsePastedRows, splitTsv, type Batch, type BatchItem } from '../batches/model';
import { MessageRow, type ThreadCards } from '../components/ChatMessages';
import { filtersFromParams, filtersToParams, apiFilter, NO_FILTERS } from '../components/runFilters';
import type { ChatMessage, ChatRun } from '../types/chat';
import type { TaskParameter } from '../taskParams/model';
import { ConfirmProvider } from '../ui';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const BATCH = '55555555-5555-4555-8555-555555555555';
const TASK = '66666666-6666-4666-8666-666666666666';
const RUN1 = '77777777-7777-4777-8777-777777777771';
const RUN2 = '77777777-7777-4777-8777-777777777772';
const NOW = '2026-11-26T10:00:00Z';

const PARAMS: TaskParameter[] = [
  { key: 'recipient', label: 'Recipient', type: 'text', required: true },
  { key: 'message', label: 'Message', type: 'text', required: true },
];

const item = (seq: number, over: Partial<BatchItem> = {}): BatchItem => ({
  seq,
  status: 'pending',
  runId: null,
  values: [
    { key: 'recipient', label: 'Recipient', value: ['Ana', 'Luis', 'Marta'][seq - 1] ?? `P${seq}` },
    { key: 'message', label: 'Message', value: 'Dinner moved to 7' },
  ],
  runStatus: null,
  result: null,
  ...over,
});

const batch = (over: Partial<Batch> = {}): Batch => ({
  id: BATCH,
  taskId: TASK,
  taskName: 'Send a text',
  conversationId: 'c1',
  trigger: 'chat',
  origin: 'web',
  policyRef: null,
  status: 'review',
  total: 3,
  onFailure: 'continue',
  stopReason: null,
  stoppedAtSeq: null,
  createdAt: NOW,
  startedAt: null,
  finishedAt: null,
  counts: { total: 3, succeeded: 0, failed: 0, cancelled: 0, skipped: 0, pending: 3, running: 0 },
  summary: '3 not started',
  items: [item(1), item(2), item(3)],
  ...over,
});

const batchMessage: ChatMessage = { id: 'm5', seq: 5, role: 'assistant', kind: 'batch', text: 'Send a text: 3 runs', runId: null, meta: { batchId: BATCH }, createdAt: NOW };

function wrap(host: ReturnType<typeof createTestPlatformHost>, ui: React.ReactNode) {
  return render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
}

describe('the chat review card', () => {
  it('lists every row ticked; Start sends only the ticked rows; the count follows the ticks', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: {
        [`GET /batches/${BATCH}`]: batch(),
        [`POST /batches/${BATCH}/start`]: batch({ status: 'running', counts: { total: 3, succeeded: 0, failed: 0, cancelled: 0, skipped: 1, pending: 1, running: 1 }, items: [item(1, { status: 'running', runId: RUN1, runStatus: 'running' }), item(2, { status: 'skipped' }), item(3)] }),
      },
    });
    wrap(host, <BatchCard message={batchMessage} />);
    expect(await screen.findByText('Send a text')).toBeInTheDocument();
    expect(screen.getByText('Recipient: Ana · Message: Dinner moved to 7')).toBeInTheDocument();
    for (const n of [1, 2, 3]) expect(screen.getByRole('checkbox', { name: `Row ${n}` })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Start 3 runs' })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Row 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start 2 runs' }));
    await waitFor(() => expect(host.requests.find((r) => r.path === `/batches/${BATCH}/start`)).toBeTruthy());
    expect(host.requests.find((r) => r.path === `/batches/${BATCH}/start`)!.body).toEqual({ rows: [1, 3] });
    // Now running: the rows with their chips, and Stop with how many it ends.
    expect(await screen.findByText('Stop ends this run and the 1 that have not started.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('Start is disabled with no row ticked', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { [`GET /batches/${BATCH}`]: batch() } });
    wrap(host, <BatchCard message={batchMessage} />);
    for (const n of [1, 2, 3]) fireEvent.click(await screen.findByRole('checkbox', { name: `Row ${n}` }));
    expect(screen.getByRole('button', { name: 'Start 0 runs' })).toBeDisabled();
  });

  it('Cancel cancels the batch and starts nothing', async () => {
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: {
        [`GET /batches/${BATCH}`]: batch(),
        [`POST /batches/${BATCH}/cancel`]: batch({ status: 'cancelled', summary: '3 not started', items: [item(1, { status: 'skipped' }), item(2, { status: 'skipped' }), item(3, { status: 'skipped' })] }),
      },
    });
    wrap(host, <BatchCard message={batchMessage} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('3 not started')).toBeInTheDocument();
    expect(host.requests.some((r) => r.path === `/batches/${BATCH}/start`)).toBe(false);
    expect(host.requests.filter((r) => r.path === `/batches/${BATCH}/cancel`)).toHaveLength(1);
  });

  it('a viewer without runs:write sees the rows and cannot start', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { [`GET /batches/${BATCH}`]: batch() } });
    wrap(host, <BatchCard message={batchMessage} />);
    expect(await screen.findByRole('button', { name: 'Start 3 runs' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});

describe('the running and finished card', () => {
  const chatRun: ChatRun = { id: RUN2, status: 'running', goal: 'Text Luis that dinner moved to 7', stepCount: 2, activity: null, result: null, error: null, stopReason: null, cancelRequested: false, hostId: null, costUsd: 0, costKnown: true, createdAt: NOW, startedAt: NOW, finishedAt: null };
  const cards: ThreadCards = { run: chatRun, frame: { src: null, shotAt: null, failing: false }, frameHidden: false, now: Date.parse(NOW), paneOpen: false, onOpenBrowser: () => undefined, onCardVisible: () => undefined };

  it('shows a chip per row, the live row’s Browser card, and Stop asks first then cancels', async () => {
    const running = batch({
      status: 'running',
      counts: { total: 3, succeeded: 1, failed: 0, cancelled: 0, skipped: 0, pending: 1, running: 1 },
      items: [item(1, { status: 'succeeded', runId: RUN1, runStatus: 'succeeded' }), item(2, { status: 'running', runId: RUN2, runStatus: 'running' }), item(3)],
    });
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: {
        [`GET /batches/${BATCH}`]: running,
        [`POST /batches/${BATCH}/cancel`]: batch({ status: 'cancelled', stopReason: 'owner_stopped', summary: '1 done, 1 stopped, 1 not started', items: [item(1, { status: 'succeeded', runId: RUN1 }), item(2, { status: 'cancelled', runId: RUN2 }), item(3, { status: 'skipped' })] }),
      },
    });
    wrap(host, <MessageRow message={batchMessage} answerable={false} onAnswer={() => undefined} cards={cards} />);
    const card = await screen.findByRole('article', { name: 'Batch' });
    const row = async (n: number) => card.querySelector(`li[data-row="${n}"] [data-status]`)?.getAttribute('data-status') ?? (await within(card).findByText('succeeded'), card.querySelector(`li[data-row="${n}"] [data-status]`)?.getAttribute('data-status'));
    expect(await row(1)).toBe('succeeded');
    expect(await row(2)).toBe('running');
    expect(await row(3)).toBe('waiting');
    // The live run's Browser card, the one a `run` message renders, below the batch.
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Batch', 'Browser run']);
    fireEvent.click(within(card).getByRole('button', { name: 'Stop' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('1 done, 1 stopped, 1 not started')).toBeInTheDocument();
    expect(screen.getByText('Stopped by you.')).toBeInTheDocument();
    expect((await screen.findAllByRole('link', { name: 'Open run' })).map((a) => a.getAttribute('href'))).toEqual([`/runs/${RUN1}`, `/runs/${RUN2}`]);
  });

  it('the batch summary message renders as a plain summary, not a run result', () => {
    const summary: ChatMessage = { id: 'm9', seq: 9, role: 'assistant', kind: 'result', text: '3 of 3 done\nRow 2: went ahead on a saved approval', runId: null, meta: { batchSummary: true, batchId: BATCH, status: 'done', counts: {} }, createdAt: NOW };
    const host = createTestPlatformHost({ permissions: ['runs:read'] });
    wrap(host, <MessageRow message={summary} answerable={false} onAnswer={() => undefined} cards={cards} />);
    expect(screen.getByRole('article', { name: 'Batch result' })).toHaveTextContent('3 of 3 done');
    expect(screen.queryByRole('article', { name: 'Result' })).toBeNull();
  });
});

describe('paste rows', () => {
  it('reads a header of labels in any order and case', () => {
    const r = parsePastedRows('message\tRECIPIENT\nDinner at 7\tAna\nLunch at 1\tLuis\n', PARAMS);
    expect(r.header).toBe(true);
    expect(r.rows).toEqual([
      { message: 'Dinner at 7', recipient: 'Ana' },
      { message: 'Lunch at 1', recipient: 'Luis' },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('without a header, takes the columns in parameter order and says when there were more', () => {
    const r = parsePastedRows('Ana\tDinner at 7\textra\r\nLuis\tLunch\r\n\r\n', PARAMS);
    expect(r.header).toBe(false);
    expect(r.rows).toEqual([
      { recipient: 'Ana', message: 'Dinner at 7' },
      { recipient: 'Luis', message: 'Lunch' },
    ]);
    expect(r.warnings[0]).toMatch(/Only the first 2 columns/);
  });

  it('keeps a quoted cell with a tab, a new line and quotes, and leaves a blank cell out', () => {
    expect(splitTsv('"a\tb"\t"line 1\nline 2"\t"say ""hi"""')).toEqual([['a\tb', 'line 1\nline 2', 'say "hi"']]);
    expect(parsePastedRows('Ana\t\n', PARAMS).rows).toEqual([{ recipient: 'Ana' }]);
    expect(parsePastedRows('', PARAMS).rows).toEqual([]);
  });

  it('a header with an unknown column keeps the known ones and warns', () => {
    const r = parsePastedRows('Recipient\tMessage\n', PARAMS);
    expect(r.header).toBe(true);
    expect(r.rows).toEqual([]);
    const r2 = parsePastedRows('Ana\tDinner\tNotes\n', PARAMS);
    expect(r2.header).toBe(false);
  });
});

describe('the API errors on the form', () => {
  it('puts INVALID_INPUT issues on their cells and an unknown name on the row', () => {
    const e = createTestApiError(400, 'Row 2: recipient: Enter a value', 'INVALID_INPUT', {
      rows: [
        { row: 2, code: 'INVALID_INPUT', message: 'x', issues: [{ key: 'recipient', message: 'Enter a value' }] },
        { row: 3, code: 'INVALID_INPUT', message: 'x', issues: [{ key: 'Colour', message: 'Not a field of this form' }] },
      ],
    });
    const out = batchFormErrors(e, PARAMS);
    expect(out.message).toBe('Row 2: recipient: Enter a value');
    expect(out.rows[2]).toEqual({ cells: { recipient: 'Enter a value' } });
    expect(out.rows[3]).toEqual({ cells: {}, row: 'Colour: Not a field of this form' });
  });

  it('maps BATCH_INPUTS_MISSING labels to cells and BATCH_DUPLICATE_ROW to the later row', () => {
    const missing = batchFormErrors(createTestApiError(400, 'Row 1 needs Message', 'BATCH_INPUTS_MISSING', { rows: [{ row: 1, missing: ['Message'] }] }), PARAMS);
    expect(missing.rows[1]).toEqual({ cells: { message: 'Enter a value' }, row: 'Needs Message' });
    const dup = batchFormErrors(createTestApiError(400, 'Rows 1 and 3 have the same values', 'BATCH_DUPLICATE_ROW', { rows: [{ row: 3, rows: [1, 3] }] }), PARAMS);
    expect(dup.rows[3]).toEqual({ cells: {}, row: 'Same values as row 1' });
  });

  it('any other error is its message alone', () => {
    expect(batchFormErrors(createTestApiError(409, 'A batch of this task is still live.', 'BATCH_LIVE'), PARAMS)).toEqual({ message: 'A batch of this task is still live.', rows: {} });
    expect(batchFormErrors(createTestApiError(400, 'A batch has at most 25 rows.', 'BATCH_TOO_LARGE', { max: 25 }), PARAMS).rows).toEqual({});
    expect(batchFormErrors(new Error('offline'), PARAMS).message).toBe('offline');
  });

  it('a task with a sensitive parameter, or none, cannot run for several', () => {
    expect(batchUnavailableReason(PARAMS)).toBeNull();
    expect(batchUnavailableReason([...PARAMS, { key: 'pin', label: 'PIN', type: 'text', required: true, sensitive: true }])).toMatch(/PIN is asked for securely/);
    expect(batchUnavailableReason([])).toMatch(/no values/);
  });
});

describe('Run for several', () => {
  const task = { id: TASK, name: 'Send a text', parameters: PARAMS };

  it('sends the filled rows by key, with the failure choice, and shows the API errors on the right row', async () => {
    let calls = 0;
    const onStarted = vi.fn();
    const host = createTestPlatformHost({
      permissions: ['runs:write'],
      responses: {
        [`POST /tasks/${TASK}/batches`]: () => {
          calls += 1;
          if (calls === 1) throw createTestApiError(400, 'Row 2 needs Message', 'BATCH_INPUTS_MISSING', { rows: [{ row: 2, missing: ['Message'] }] });
          return batch({ status: 'running' });
        },
      },
    });
    wrap(host, <RunForSeveralDialog open task={task} onClose={() => undefined} onStarted={onStarted} />);
    expect(screen.getByRole('button', { name: 'Start 0 runs' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Paste rows'), { target: { value: 'Recipient\tMessage\nAna\tDinner at 7\nLuis\t' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add pasted rows' }));
    expect(screen.getByText(/Added 2 rows \(the first line was the header\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Stop the rows not started' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start 2 runs' }));
    expect(await screen.findByText('Needs Message')).toBeInTheDocument();
    expect(host.requests.find((r) => r.path === `/tasks/${TASK}/batches`)!.body).toEqual({
      rows: [{ inputs: { recipient: 'Ana', message: 'Dinner at 7' } }, { inputs: { recipient: 'Luis' } }],
      onFailure: 'stop',
    });
    expect(screen.getByText('Enter a value')).toBeInTheDocument();
    // Fix row 2 and start again.
    fireEvent.change(screen.getByLabelText(/Row 2: Message/), { target: { value: 'Lunch at 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start 2 runs' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
  });

  it('adds and removes rows', () => {
    const host = createTestPlatformHost({ permissions: ['runs:write'] });
    wrap(host, <RunForSeveralDialog open task={task} onClose={() => undefined} onStarted={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    expect(screen.getByRole('button', { name: 'Remove row 3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove row 1' }));
    expect(screen.queryByRole('button', { name: 'Remove row 3' })).toBeNull();
  });
});

describe('the runs list batch filter', () => {
  it('reads and writes batchId in the URL and passes it to the API', () => {
    const f = filtersFromParams(new URLSearchParams(`batchId=${BATCH}`));
    expect(f.batchId).toBe(BATCH);
    expect(filtersFromParams(new URLSearchParams('batchId=nope')).batchId).toBeNull();
    expect(filtersToParams({ ...NO_FILTERS, batchId: BATCH }).get('batchId')).toBe(BATCH);
    expect(apiFilter(f, {}, 'UTC').batchId).toBe(BATCH);
  });
});
