// What the run page shows about accounts (E39.10, #607): the steps of the agent's account tools in words, the Deliveries block with where each
// went, every status, Retry and a link out, and "Started by an email".
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunTimeline } from '../components/RunTimeline';
import { connectionStepLine, isConnectionStep } from '../components/connectionSteps';
import { RunDeliveries } from '../deliveries/RunDeliveries';
import { destinationLabel, linkTarget, type DeliveryDestination, type RunDelivery } from '../deliveries/model';
import { StartedByEmail } from '../mailTriggers/StartedByEmail';

configure({ asyncUtilTimeout: 5_000 });

const RUN = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const WORK = '33333333-3333-4333-8333-333333333333';
const TRIGGER = '44444444-4444-4444-8444-444444444444';

const step = (seq: number, action: string, args: Record<string, unknown>, summary = '', ok = true) => ({ id: `s${seq}`, seq, kind: 'action', action, args, ok, summary, reasoning: null, createdAt: '2026-11-18T18:00:00Z' });

describe('steps of the account tools', () => {
  it('says what was done with which account, in words', () => {
    const line = (action: string, args: Record<string, unknown>, summary = '') => connectionStepLine({ action, kind: 'action', args: { connection: 'Work', ...args }, summary, ok: true });
    expect(line('mail_search', {}, 'found 3 messages')).toBe('Searched mail in Work: 3 messages found');
    expect(line('mail_read', {})).toBe('Read an email in Work');
    expect(line('mail_send', { to: ['person-f@example.test'] })).toBe('Sent an email from Work to 1 person');
    expect(line('sheet_append_rows', { rows: 1 })).toBe('Added 1 row to a spreadsheet in Work');
    expect(line('calendar_create_event', { title: 'Loan review', attendees: ['a@example.test', 'b@example.test'] })).toBe('Created an event “Loan review” in Work, inviting 2 people');
  });

  it('only a step that names an account is one, and a click is not', () => {
    expect(isConnectionStep({ action: 'mail_send', kind: 'action', args: { connection: 'Work' } })).toBe(true);
    expect(isConnectionStep({ action: 'click', kind: 'action', args: { connection: 'Work' } })).toBe(false);
    expect(isConnectionStep({ action: 'mail_send', kind: 'action', args: {} })).toBe(false);
  });

  it('shows them in the timeline with the account label, a failure marked, and the masked details on request', () => {
    render(
      <MemoryRouter>
        <RunTimeline
          live={false}
          runId={RUN}
          steps={[step(1, 'mail_search', { connection: 'Work', from: 'billing@example.test' }, 'found 3 messages'), step(2, 'mail_send', { connection: 'Personal', to: ['person-f@example.test'], subject: 'Paid', body_hash: 'ab12cd34' }, 'sent'), step(3, 'sheet_append_rows', { connection: 'Work', rows: 1 }, 'failed: the connection needs reconnecting', false)]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('1. Searched mail in Work: 3 messages found')).toBeInTheDocument();
    expect(screen.getByText('2. Sent an email from Personal to 1 person')).toBeInTheDocument();
    expect(screen.getByText('3. Added 1 row to a spreadsheet in Work (failed)')).toBeInTheDocument();
    expect(screen.queryByTestId('connection-step-details-2')).toBeNull();
    fireEvent.click(within(screen.getByTestId('connection-step-2')).getByRole('button', { name: 'Details' }));
    const details = screen.getByTestId('connection-step-details-2');
    expect(details).toHaveTextContent('body_hash');
    expect(details).not.toHaveTextContent('Hello');
  });
});

const row = (over: Partial<RunDelivery> & Pick<RunDelivery, 'id' | 'kind' | 'status'>): RunDelivery => ({
  runId: RUN,
  deliveryId: null,
  attempts: 1,
  errorCode: null,
  errorText: null,
  detail: {},
  sentAt: '2026-11-18T18:00:00Z',
  nextAttemptAt: null,
  createdAt: '2026-11-18T18:00:00Z',
  ...over,
});
const DESTINATIONS: DeliveryDestination[] = [
  { id: 'dm', kind: 'email', config: { to: ['person-a@example.test', 'person-f@example.test'] }, connection: null },
  { id: 'ds', kind: 'sheet_row', config: { connectionId: WORK, fileId: 'sheet-1' }, connection: { id: WORK, label: 'Work' } },
  { id: 'df', kind: 'folder', config: { target: { connectionId: WORK, folderId: 'folder-1' } }, connection: { id: WORK, label: 'Work' } },
  { id: 'dw', kind: 'webhook', config: { url: 'https://hooks.example.test/private/path' }, connection: null },
];

describe('the words of where it went', () => {
  it('names the destination from the delivery\'s setup, never from the log, and falls back to the kind', () => {
    const [mail, sheet, folder, hook] = DESTINATIONS;
    expect(destinationLabel({ kind: 'email', detail: {} }, mail)).toBe('Email to 2 people');
    expect(destinationLabel({ kind: 'sheet_row', detail: {} }, sheet)).toBe('Spreadsheet row in Work');
    expect(destinationLabel({ kind: 'folder', detail: {} }, folder)).toBe('Files in a folder in Work');
    expect(destinationLabel({ kind: 'webhook', detail: {} }, hook)).toBe('Webhook to hooks.example.test');
    expect(destinationLabel({ kind: 'email', detail: {} }, undefined)).toBe('Email');
    expect(destinationLabel({ kind: 'sheet_row', detail: {} }, { ...sheet!, connection: { id: WORK, label: null } })).toBe('Spreadsheet row in a removed account');
  });

  it('links to a sent spreadsheet or folder in an account, and to nothing else', () => {
    expect(linkTarget({ status: 'sent' }, DESTINATIONS[1])).toEqual({ connectionId: WORK, fileId: 'sheet-1', what: 'spreadsheet' });
    expect(linkTarget({ status: 'sent' }, DESTINATIONS[2])).toEqual({ connectionId: WORK, fileId: 'folder-1', what: 'folder' });
    expect(linkTarget({ status: 'failed' }, DESTINATIONS[1])).toBeNull();
    expect(linkTarget({ status: 'sent' }, DESTINATIONS[0])).toBeNull();
    expect(linkTarget({ status: 'sent' }, { ...DESTINATIONS[2]!, config: { target: 'storage' } })).toBeNull();
  });
});

let open: ReturnType<typeof vi.spyOn> | null = null;
afterEach(() => {
  open?.mockRestore();
  open = null;
});

function show(rows: RunDelivery[], extra: Record<string, unknown> = {}, permissions = ['runs:read', 'runs:write', 'connections:read']) {
  const host = createTestPlatformHost({ permissions, responses: { [`GET /runs/${RUN}/deliveries`]: rows, [`GET /tasks/${TASK}/deliveries`]: DESTINATIONS, ...extra } });
  render(
    <PlatformHostProvider host={host}>
      <RunDeliveries runId={RUN} taskId={TASK} canRetryDelivery={permissions.includes('runs:write')} canOpenLinks={permissions.includes('connections:read')} pollMs={50} />
    </PlatformHostProvider>,
  );
  return host;
}

describe('the Deliveries block', () => {
  it('shows each delivery with where it went, a status chip for every status, and a Retry only for the failed one', async () => {
    const failed = row({ id: 'f', deliveryId: 'ds', kind: 'sheet_row', status: 'failed', errorText: 'the connection needs reconnecting', sentAt: null });
    const host = show(
      [row({ id: 'a', deliveryId: 'dm', kind: 'email', status: 'sent', detail: { messages: 2 } }), failed, row({ id: 'p', deliveryId: 'dw', kind: 'webhook', status: 'pending', sentAt: null }), row({ id: 'k', deliveryId: 'df', kind: 'folder', status: 'skipped', errorText: 'nothing to save', sentAt: null })],
      { [`POST /runs/${RUN}/deliveries/f/retry`]: { ...failed, status: 'pending', errorText: null } },
    );
    const section = await screen.findByRole('region', { name: 'Deliveries' });
    const items = within(section).getAllByTestId('run-delivery');
    expect(items).toHaveLength(4);
    await waitFor(() => expect(within(items[0]!).getByText('Email to 2 people')).toBeInTheDocument());
    expect(within(items[1]!).getByText('Spreadsheet row in Work')).toBeInTheDocument();
    expect(items.map((i) => ['Sent', 'Failed', 'Waiting', 'Skipped'].find((w) => within(i).queryByText(w)))).toEqual(['Sent', 'Failed', 'Waiting', 'Skipped']);
    expect(within(section).getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    // The time of each is shown.
    expect(within(items[0]!).getByRole('time', { hidden: true })).toBeInTheDocument();
    fireEvent.click(within(items[1]!).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === `/runs/${RUN}/deliveries/f/retry`)).toBe(true));
  });

  it('opens a sent spreadsheet at the provider, once the account says where', async () => {
    open = vi.spyOn(window, 'open').mockImplementation(() => null);
    show([row({ id: 'a', deliveryId: 'ds', kind: 'sheet_row', status: 'sent', detail: { rows: 1 } })], { [`GET /connections/${WORK}/files/sheet-1`]: { id: 'sheet-1', name: 'Car loan', kind: 'spreadsheet', mimeType: 'x', size: null, modifiedAt: null, webUrl: 'https://docs.example.test/sheet-1', parentId: null } });
    fireEvent.click(await screen.findByRole('button', { name: 'Open the spreadsheet' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://docs.example.test/sheet-1', '_blank', 'noopener,noreferrer'));
  });

  it('offers no link without permission to read connections, and none for a failed delivery', async () => {
    show([row({ id: 'a', deliveryId: 'ds', kind: 'sheet_row', status: 'sent' })], {}, ['runs:read', 'runs:write']);
    await screen.findByRole('region', { name: 'Deliveries' });
    expect(screen.queryByRole('button', { name: 'Open the spreadsheet' })).toBeNull();
  });
});

describe('"Started by an email"', () => {
  function mount(triggerId: string | null | undefined, responses: Record<string, unknown> = {}) {
    const host = createTestPlatformHost({ permissions: ['runs:read'], responses: { [`GET /tasks/${TASK}/mail-triggers`]: [{ id: TRIGGER, name: 'Invoices' }], ...responses } });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter>
          <StartedByEmail taskId={TASK} triggerId={triggerId} canRead />
        </MemoryRouter>
      </PlatformHostProvider>,
    );
  }

  it('names the trigger that started the run', async () => {
    mount(TRIGGER);
    expect(await screen.findByText('Invoices')).toBeInTheDocument();
    expect(screen.getByTestId('started-by-email')).toHaveTextContent('Started by an email (trigger Invoices)');
  });

  it('says only "Started by an email" when the trigger was deleted', async () => {
    mount('99999999-9999-4999-8999-999999999999');
    await waitFor(() => expect(screen.getByTestId('started-by-email')).toHaveTextContent(/^Started by an email$/));
  });

  it('shows nothing for a run no email started', () => {
    mount(null);
    expect(screen.queryByTestId('started-by-email')).toBeNull();
  });
});
