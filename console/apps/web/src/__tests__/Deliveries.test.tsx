// The delivery editor on the task form (E39.10, #607): the model (summaries, checks, the plan of requests), each kind's editor (the email's
// validation and the confirm-the-address flow, the spreadsheet's column mapping with "Fill from outputs" and its preview row, the folder's
// chooser, the webhook), test send, reordering by keyboard, read-only without `runs:write`, and the picker script loading only in the chooser.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Connection } from '../connections/api';
import { fileIdFromLink } from '../connections/files';
import { PICKER_SCRIPT, PickerUnavailable } from '../connections/googlePicker';
import { DeliveriesSection } from '../deliveries/DeliveriesSection';
import { DeliverySecretsDialog } from '../deliveries/DeliverySecretsDialog';
import {
  badPlaceholders,
  draftFromDelivery,
  draftProblems,
  exampleName,
  fillFromOutputs,
  listChanged,
  newDraft,
  planSync,
  recordKeepingDrafts,
  sampleRow,
  splitAddresses,
  summarize,
  type DeliveryDraft,
  type EmailConfig,
  type FolderConfig,
  type SheetRowConfig,
  type TaskDelivery,
} from '../deliveries/drafts';
import { syncDeliveries } from '../deliveries/sync';
import { needsConfirming, ownAddresses, recipientState } from '../deliveries/recipients';
import type { TaskOutput } from '../taskOutputs/model';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const TASK = '11111111-1111-4111-8111-111111111111';
const WORK = '22222222-2222-4222-8222-222222222222';
const OUTLOOK = '33333333-3333-4333-8333-333333333333';
const READONLY = '44444444-4444-4444-8444-444444444444';

const conn = (over: Partial<Connection>): Connection => ({
  id: WORK,
  provider: 'google',
  label: 'Work',
  accountEmail: 'person-a@example.test',
  accountName: null,
  capabilities: ['mail_read', 'mail_send', 'docs_read', 'docs_write'],
  granted: ['mail_read', 'mail_send', 'docs_read', 'docs_write'],
  defaultFor: [],
  status: 'active',
  statusReason: null,
  connectedAt: '2026-11-01T00:00:00Z',
  lastUsedAt: null,
  lastRefreshAt: null,
  ...over,
});
const CONNECTIONS: Connection[] = [
  conn({}),
  conn({ id: OUTLOOK, provider: 'microsoft', label: 'Outlook', accountEmail: 'person-b@example.test' }),
  conn({ id: READONLY, label: 'Read only', accountEmail: 'person-c@example.test', capabilities: ['mail_read', 'docs_read'] }),
];

const OUTPUTS: TaskOutput[] = [
  { key: 'confirmation', label: 'Confirmation number', type: 'text', required: true },
  { key: 'amount', label: 'Amount paid', type: 'money', required: true },
];
const ctx = { outputs: OUTPUTS, connections: CONNECTIONS };

const delivery = (over: Partial<TaskDelivery> = {}): TaskDelivery => ({
  id: 'd1',
  taskId: TASK,
  kind: 'email',
  enabled: true,
  when: 'succeeded',
  position: 0,
  config: { via: 'console', to: ['person-a@example.test'], attach: { pdf: true, json: false, screenshots: 'none' }, includeOutputs: true, includeSensitive: false },
  recipients: [],
  connection: null,
  disabledReason: null,
  webhookSecretConfigured: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  ...over,
});

describe('the model', () => {
  it('summarises each kind in one line', () => {
    const email = { ...newDraft('email', { ownAddress: 'person-a@example.test' }), when: 'succeeded' as const };
    expect(summarize(email, CONNECTIONS)).toBe('Email to 1 person with the PDF report, when it succeeds');
    (email.config as EmailConfig).to = ['person-a@example.test', 'person-b@example.test'];
    (email.config as EmailConfig).via = { connectionId: WORK };
    expect(summarize(email, CONNECTIONS)).toBe('Email to 2 people from Work with the PDF report, when it succeeds');
    const sheet = newDraft('sheet_row', { outputs: OUTPUTS, connections: CONNECTIONS });
    (sheet.config as SheetRowConfig).createIfMissing = true;
    (sheet.config as SheetRowConfig).newTitle = 'Car loan';
    expect(summarize(sheet, CONNECTIONS)).toBe('Add a row to a new spreadsheet “Car loan” in Work, when it succeeds');
    const folder = newDraft('folder');
    expect(summarize(folder, CONNECTIONS)).toBe('Save the PDF report to Hexactra storage, when it succeeds');
    const hook = { ...newDraft('webhook'), when: 'failed' as const };
    (hook.config as { url: string }).url = 'https://hooks.example.test/run';
    expect(summarize(hook, CONNECTIONS)).toBe("Send the run's fields to hooks.example.test, when it fails");
  });

  it('checks an email like the server: an address, a subject with known details, an attachment or the outputs', () => {
    const d = newDraft('email', { ownAddress: null });
    expect(draftProblems(d, ctx).to).toMatch(/at least one/i);
    (d.config as EmailConfig).to = ['not-an-address'];
    expect(draftProblems(d, ctx).to).toMatch(/not an email address/);
    (d.config as EmailConfig).to = ['person-a@example.test'];
    (d.config as EmailConfig).subject = 'Paid {{output:confirmation}} on {{when}}';
    expect(draftProblems(d, ctx).subject).toMatch(/\{\{when\}\}/);
    (d.config as EmailConfig).subject = 'Paid {{output:confirmation}} on {{date}}';
    expect(draftProblems(d, ctx)).toEqual({});
    expect(badPlaceholders('{{output:nope}}', ['confirmation'])).toEqual(['{{output:nope}}']);
  });

  it('checks a spreadsheet row, a folder and a webhook', () => {
    const sheet = newDraft('sheet_row', { outputs: OUTPUTS, connections: CONNECTIONS });
    expect(draftProblems(sheet, ctx).file).toMatch(/choose a spreadsheet/i);
    (sheet.config as SheetRowConfig).fileId = 'sheet-1';
    expect(draftProblems(sheet, ctx)).toEqual({});
    (sheet.config as SheetRowConfig).columns = [{ header: ' ', value: { kind: 'output', key: 'gone' } }];
    expect(draftProblems(sheet, ctx)['column:0']).toMatch(/header/);
    const folder = newDraft('folder');
    (folder.config as FolderConfig).files = { pdf: false, json: false, screenshots: 'none' };
    expect(draftProblems(folder, ctx).files).toMatch(/at least one file/i);
    (folder.config as FolderConfig).files.pdf = true;
    (folder.config as FolderConfig).target = { connectionId: WORK, folderId: '' };
    expect(draftProblems(folder, ctx).folder).toMatch(/choose a folder/i);
    const hook = newDraft('webhook');
    expect(draftProblems(hook, ctx).url).toBeTruthy();
    (hook.config as { url: string }).url = 'http://hooks.example.test';
    expect(draftProblems(hook, ctx).url).toMatch(/https/);
    (hook.config as { url: string }).url = 'https://hooks.example.test';
    expect(draftProblems(hook, ctx)).toEqual({});
  });

  it('fills one column per output, once, with the run date first, and previews a row', () => {
    const columns = fillFromOutputs(OUTPUTS, []);
    expect(columns.map((c) => c.header)).toEqual(['Run date', 'Confirmation number', 'Amount paid']);
    expect(fillFromOutputs(OUTPUTS, columns)).toHaveLength(3);
    expect(sampleRow(columns, OUTPUTS, 'Pay the car loan')).toEqual(['2026-11-18', 'Sample text', '412.50 USD']);
  });

  it('shows a file name template with placeholders filled and unsafe characters replaced', () => {
    expect(exampleName('{{task}} {{date}} / {{output:confirmation}}', { task: 'Pay loan', date: '2026-11-18', status: 'succeeded', outputs: { confirmation: 'C-1' } })).toBe('Pay loan 2026-11-18 _ C-1');
  });

  it('splits addresses, tells whose they are, and says which need confirming', () => {
    expect(splitAddresses('A@example.test, b@example.test;a@example.test')).toEqual(['a@example.test', 'b@example.test']);
    const own = ownAddresses('Person-A@example.test', [{ accountEmail: 'person-b@example.test', provider: 'google' }]);
    expect(own).toEqual(['person-a@example.test', 'person-b@example.test']);
    const records = [{ address: 'person-d@example.test', confirmedAt: '2026-11-01T00:00:00Z', unsubscribedAt: null }, { address: 'person-e@example.test', confirmedAt: '2026-11-01T00:00:00Z', unsubscribedAt: '2026-11-02T00:00:00Z' }];
    expect(recipientState('person-a@example.test', own, records)).toBe('own');
    expect(recipientState('person-d@example.test', own, records)).toBe('confirmed');
    expect(recipientState('person-e@example.test', own, records)).toBe('unsubscribed');
    expect(needsConfirming(['person-a@example.test', 'person-d@example.test', 'person-e@example.test', 'person-f@example.test'], own, records).map((x) => x.address)).toEqual(['person-e@example.test', 'person-f@example.test']);
  });

  it('plans deletes first, then creates and changes with their positions, and nothing for an unchanged list', () => {
    const a = delivery({ id: 'a', position: 0 });
    const b = delivery({ id: 'b', position: 1, kind: 'webhook', config: { url: 'https://hooks.example.test', includeOutputs: true, includeReportLink: true, includeSensitive: false } });
    const saved = [a, b];
    expect(planSync(saved, saved.map(draftFromDelivery))).toEqual([]);
    expect(listChanged(saved.map(draftFromDelivery), saved)).toBe(false);
    const reordered = [draftFromDelivery(b), draftFromDelivery(a)];
    expect(planSync(saved, reordered).map((o) => `${o.op}:${'id' in o ? o.id : ''}:${'body' in o ? JSON.stringify((o.body as { position?: number }).position) : ''}`)).toEqual(['update:b:0', 'update:a:1']);
    const added = newDraft('folder');
    const ops = planSync(saved, [draftFromDelivery(a), added]);
    expect(ops.map((o) => o.op)).toEqual(['delete', 'create']);
    expect(ops[1]).toMatchObject({ op: 'create', body: { kind: 'folder', position: 1, enabled: true, when: 'succeeded' } });
  });

  it('turns a refusal into words', async () => {
    const { deliveryErrorText } = await import('../deliveries/drafts');
    expect(deliveryErrorText({ code: 'RECIPIENT_NOT_CONFIRMED', details: { addresses: ['person-d@example.test'] } })).toMatch(/person-d@example.test/);
    expect(deliveryErrorText({ code: 'INVALID_DELIVERY', details: { issues: [{ path: ['config', 'to'], message: 'too many' }] } })).toBe('config.to: too many');
  });

  it('reads a Google file id from a link and from a bare id', () => {
    expect(fileIdFromLink('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0')).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(fileIdFromLink('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(fileIdFromLink('https://example.test/x')).toBeNull();
  });

  it('builds the guided setup starting point: an email and a row in a new spreadsheet', () => {
    const [email, sheet] = recordKeepingDrafts({ ownAddress: 'person-a@example.test', outputs: OUTPUTS, connections: CONNECTIONS });
    expect(email!.kind).toBe('email');
    expect((sheet!.config as SheetRowConfig).createIfMissing).toBe(true);
    expect((sheet!.config as SheetRowConfig).columns.map((c) => c.header)).toEqual(['Run date', 'Confirmation number', 'Amount paid']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------

interface MountOptions {
  initial?: DeliveryDraft[];
  saved?: TaskDelivery[];
  permissions?: string[];
  responses?: Record<string, unknown>;
  connections?: Connection[] | null;
  taskId?: string | null;
  email?: string | null;
  loadFailed?: boolean;
  canEdit?: boolean;
  loadPicker?: () => Promise<void>;
}

function Harness({ options, onDrafts }: { options: MountOptions; onDrafts: (d: DeliveryDraft[]) => void }) {
  const [drafts, setDrafts] = useState<DeliveryDraft[]>(options.initial ?? []);
  const [outputs, setOutputs] = useState<TaskOutput[]>(OUTPUTS);
  return (
    <>
      <DeliveriesSection
        drafts={drafts}
        onChange={(d) => {
          setDrafts(d);
          onDrafts(d);
        }}
        saved={options.saved ?? []}
        taskId={options.taskId === undefined ? TASK : options.taskId}
        taskName="Pay the car loan"
        outputs={outputs}
        connections={options.connections === undefined ? CONNECTIONS : options.connections}
        canEdit={options.canEdit ?? true}
        loadFailed={options.loadFailed}
        loadPicker={options.loadPicker}
        onGuided={(r) => {
          setOutputs((o) => [...o, ...r.outputs]);
          setDrafts((d) => [...d, ...r.deliveries]);
          onDrafts([...drafts, ...r.deliveries]);
        }}
      />
      <output data-testid="count">{drafts.length}</output>
    </>
  );
}

function mount(options: MountOptions = {}) {
  const base = createTestPlatformHost({
    permissions: options.permissions ?? ['runs:read', 'runs:write', 'connections:read', 'connections:write'],
    responses: {
      'GET /delivery-recipients': [{ address: 'person-d@example.test', confirmedAt: '2026-11-01T00:00:00Z', unsubscribedAt: null }],
      ...(options.responses ?? {}),
    },
  });
  const host = { ...base, viewer: { ...base.viewer, email: options.email === undefined ? 'person-a@example.test' : options.email } } as typeof base;
  let latest: DeliveryDraft[] = options.initial ?? [];
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>
          <Harness options={options} onDrafts={(d) => (latest = d)} />
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  const requests = (method: string, path: string) => base.requests.filter((r: TestApiRequest) => r.method === method && r.path.startsWith(path));
  return { host: base, requests, drafts: () => latest };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  document.head.querySelectorAll(`script[src="${PICKER_SCRIPT}"]`).forEach((n) => n.remove());
});

const dialog = () => screen.getByRole('dialog');
const emailDraft = (over: Partial<EmailConfig> = {}): DeliveryDraft => ({ ...newDraft('email', { ownAddress: 'person-a@example.test' }), config: { ...(newDraft('email', { ownAddress: 'person-a@example.test' }).config as EmailConfig), ...over } });

describe('the section', () => {
  it('offers the guided setup and the four kinds when there is nothing yet', async () => {
    mount();
    expect(await screen.findByText('Nothing is sent yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep a record of each run' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add a delivery' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Email', 'Spreadsheet row', 'Save to a folder', 'Webhook']);
  });

  it('shows the rows with a summary, a switch, and no editing without permission', async () => {
    mount({ initial: [draftFromDelivery(delivery())], saved: [delivery()], canEdit: false });
    expect(await screen.findByText('Email to 1 person with the PDF report, when it succeeds')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add a delivery' })).toBeNull();
    expect(screen.getByText(/changing them needs permission to run tasks/i)).toBeInTheDocument();
  });

  it('turns editing off, with the reason, when the saved deliveries could not be read', () => {
    mount({ initial: [draftFromDelivery(delivery())], saved: [delivery()], loadFailed: true });
    expect(screen.getByText(/could not be loaded, so they cannot be changed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
  });

  it('switches a delivery off and on, and removes one', async () => {
    const { drafts } = mount({ initial: [draftFromDelivery(delivery())], saved: [delivery()] });
    const sw = await screen.findByRole('switch', { name: /Send Email to 1 person/ });
    fireEvent.click(sw);
    expect(drafts()[0]!.enabled).toBe(false);
    expect(screen.getByText('Switched off')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByTestId('count')).toHaveTextContent('0');
  });

  it('reorders by the move buttons, which are real buttons a keyboard reaches', async () => {
    const a = draftFromDelivery(delivery({ id: 'a' }));
    const b = draftFromDelivery(delivery({ id: 'b', kind: 'webhook', config: { url: 'https://hooks.example.test/run', includeOutputs: true, includeReportLink: true, includeSensitive: false } }));
    const { drafts } = mount({ initial: [a, b], saved: [delivery({ id: 'a' })] });
    const down = await screen.findByRole('button', { name: 'Move delivery 1 down' });
    expect(screen.getByRole('button', { name: 'Move delivery 1 up' })).toBeDisabled();
    down.focus();
    fireEvent.click(down);
    expect(drafts().map((d) => d.id)).toEqual(['b', 'a']);
    expect(screen.getByRole('button', { name: 'Move delivery 2 down' })).toBeDisabled();
  });

  it('sends a test of a saved delivery and shows the answer, and asks to save first for one that changed', async () => {
    const { requests } = mount({
      initial: [draftFromDelivery(delivery())],
      saved: [delivery()],
      responses: { [`POST /tasks/${TASK}/deliveries/d1/test`]: { ok: true, message: 'The test was sent.', detail: {} } },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }));
    expect(await screen.findByText('The test was sent.')).toBeInTheDocument();
    expect(requests('POST', `/tasks/${TASK}/deliveries/d1/test`)).toHaveLength(1);
    // A failed test reads as the server's sentence.
    const second = mount({
      initial: [draftFromDelivery(delivery({ id: 'd2' }))],
      saved: [delivery({ id: 'd2' })],
      responses: { [`POST /tasks/${TASK}/deliveries/d2/test`]: { ok: false, code: 'CAPABILITY_OFF', message: 'The test could not be sent: This is not switched on for the account.', detail: {} } },
    });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Send a test' }))[1]!);
    expect(await screen.findByText(/This is not switched on for the account/)).toBeInTheDocument();
    expect(second.requests('POST', `/tasks/${TASK}/deliveries/d2/test`)).toHaveLength(1);
  });

  it('cannot send a test of a delivery that is not saved yet', async () => {
    mount({ initial: [emailDraft()], saved: [], taskId: null });
    expect(await screen.findByRole('button', { name: 'Send a test' })).toBeDisabled();
    expect(screen.getByText('Not saved yet')).toBeInTheDocument();
  });

  it('explains a delivery whose account lacks the permission and offers to allow it', async () => {
    const d = draftFromDelivery(delivery({ config: { via: { connectionId: READONLY }, to: ['person-a@example.test'], attach: { pdf: true, json: false, screenshots: 'none' }, includeOutputs: true, includeSensitive: false } }));
    mount({ initial: [d], saved: [] });
    expect(await screen.findByText('Read only is not allowed to send mail.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow this account to send mail' })).toBeInTheDocument();
  });

  it('says a delivery was switched off because its account was removed', async () => {
    mount({ initial: [draftFromDelivery(delivery({ enabled: false, disabledReason: 'connection_removed', kind: 'sheet_row', config: { connectionId: 'gone', fileId: 'f', columns: [{ header: 'A', value: { kind: 'field', field: 'status' } }], createIfMissing: false, includeSensitive: false } }))] });
    expect(await screen.findByText(/The account this used was removed/)).toBeInTheDocument();
  });
});

describe('the email editor', () => {
  it('requires an address, offers the owner\'s own first, and says an unconfirmed one will be confirmed', async () => {
    mount({ email: 'person-a@example.test' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Email' }));
    const to = within(dialog()).getByTestId('email-to');
    // The owner's own address is already there; remove it to see the check.
    fireEvent.click(within(dialog()).getByTestId('CancelIcon'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
    expect(await within(dialog()).findByText('Add at least one address')).toBeInTheDocument();
    fireEvent.change(to, { target: { value: 'person-f@example.test' } });
    fireEvent.keyDown(to, { key: 'Enter' });
    expect(await within(dialog()).findByTestId('confirm-hint')).toHaveTextContent("You'll be asked to confirm this address: person-f@example.test");
  });

  it('asks to confirm an address that is not the owner\'s, records it, and keeps the delivery on', async () => {
    const { requests, drafts } = mount({ responses: { 'POST /delivery-recipients': { address: 'person-f@example.test', confirmedAt: '2026-11-19T00:00:00Z', unsubscribedAt: null } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Email' }));
    const to = within(dialog()).getByTestId('email-to');
    fireEvent.change(to, { target: { value: 'person-f@example.test' } });
    fireEvent.keyDown(to, { key: 'Enter' });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
    const confirmDialog = await screen.findByRole('dialog', { name: /Send reports to this address/ });
    expect(within(confirmDialog).getByText('person-f@example.test')).toBeInTheDocument();
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Confirm and keep it on' }));
    await waitFor(() => expect(drafts()).toHaveLength(1));
    expect(requests('POST', '/delivery-recipients')[0]!.body).toEqual({ address: 'person-f@example.test' });
    expect((drafts()[0]!.config as EmailConfig).to).toEqual(['person-a@example.test', 'person-f@example.test']);
    expect(drafts()[0]!.enabled).toBe(true);
  });

  it('can save the delivery switched off instead of confirming, and confirms nothing', async () => {
    const { requests, drafts } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Email' }));
    const to = within(dialog()).getByTestId('email-to');
    fireEvent.change(to, { target: { value: 'person-g@example.test' } });
    fireEvent.keyDown(to, { key: 'Enter' });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save switched off' }));
    await waitFor(() => expect(drafts()).toHaveLength(1));
    expect(drafts()[0]!.enabled).toBe(false);
    expect(requests('POST', '/delivery-recipients')).toHaveLength(0);
  });

  it('does not ask again for an address already confirmed, and sends the subject with a detail added from the menu', async () => {
    const { drafts, requests } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Email' }));
    const to = within(dialog()).getByTestId('email-to');
    fireEvent.change(to, { target: { value: 'person-d@example.test' } });
    fireEvent.keyDown(to, { key: 'Enter' });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add a detail to the subject' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Output: Confirmation number/ }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(drafts()).toHaveLength(1));
    expect(requests('POST', '/delivery-recipients')).toHaveLength(0);
    expect((drafts()[0]!.config as EmailConfig).subject).toBe('{{output:confirmation}}');
  });
});

describe('the spreadsheet editor', () => {
  const open = async () => {
    const m = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Spreadsheet row' }));
    return m;
  };

  it('maps columns to outputs, fills them from the outputs, previews a row and reorders them', async () => {
    const { drafts } = await open();
    const d = dialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Fill from outputs' }));
    expect(within(d).getByTestId('column-0')).toBeInTheDocument();
    expect(within(d).getAllByRole('textbox', { name: /^Header/ }).map((i) => (i as HTMLInputElement).value)).toEqual(['Run date', 'Confirmation number', 'Amount paid']);
    const preview = within(d).getByTestId('row-preview');
    expect(within(preview).getByText('Sample text')).toBeInTheDocument();
    expect(within(preview).getByText('412.50 USD')).toBeInTheDocument();
    // Fill from outputs again: nothing is added twice.
    fireEvent.click(within(d).getByRole('button', { name: 'Fill from outputs' }));
    expect(within(d).getAllByRole('textbox', { name: /^Header/ })).toHaveLength(3);
    fireEvent.click(within(d).getByRole('button', { name: 'Move column 3 up' }));
    expect(within(d).getAllByRole('textbox', { name: /^Header/ }).map((i) => (i as HTMLInputElement).value)).toEqual(['Run date', 'Amount paid', 'Confirmation number']);
    fireEvent.click(within(d).getByRole('button', { name: 'Remove column 1' }));
    // No spreadsheet yet: the check names it.
    fireEvent.click(within(d).getByRole('button', { name: 'Done' }));
    expect(await within(d).findByText('Choose a spreadsheet, or have one created')).toBeInTheDocument();
    expect(drafts()).toHaveLength(0);
  });

  it('can have a new spreadsheet created: the first send makes it, and the title is optional', async () => {
    const { drafts } = await open();
    const d = dialog();
    fireEvent.click(within(d).getByRole('radio', { name: 'Create a new spreadsheet' }));
    fireEvent.change(within(d).getByLabelText('Title of the new spreadsheet'), { target: { value: 'Car loan' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(drafts()).toHaveLength(1));
    const c = drafts()[0]!.config as SheetRowConfig;
    expect(c.createIfMissing).toBe(true);
    expect(c.newTitle).toBe('Car loan');
    expect(c.connectionId).toBe(WORK);
  });

  it('chooses an existing spreadsheet by searching the account', async () => {
    const { drafts, requests } = mount({
      responses: {
        [`GET /connections/${WORK}/files?type=any`]: { items: [{ id: 'sheet-1', name: 'Loan payments', kind: 'spreadsheet', mimeType: 'x', size: null, modifiedAt: null, webUrl: null, parentId: null }, { id: 'folder-1', name: 'Receipts', kind: 'folder', mimeType: 'x', size: null, modifiedAt: null, webUrl: null, parentId: null }], nextPageToken: null },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Spreadsheet row' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Choose a spreadsheet' }));
    const chooser = await screen.findByRole('dialog', { name: /Choose a spreadsheet in Work/ });
    fireEvent.click(await within(chooser).findByRole('button', { name: 'Loan payments' }));
    await waitFor(() => expect(within(dialog()).getByTestId('chosen-file')).toHaveTextContent('Loan payments'));
    expect(requests('GET', `/connections/${WORK}/files`).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(drafts()).toHaveLength(1));
    expect((drafts()[0]!.config as SheetRowConfig).fileId).toBe('sheet-1');
  });

  it('uses a pasted link: the server confirms the account can reach it', async () => {
    mount({
      responses: {
        [`GET /connections/${WORK}/files?type=any`]: { items: [], nextPageToken: null },
        [`POST /connections/${WORK}/files/picked`]: { id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', name: 'Pasted sheet', kind: 'spreadsheet', mimeType: 'x', size: null, modifiedAt: null, webUrl: null, parentId: null },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Spreadsheet row' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Choose a spreadsheet' }));
    const chooser = await screen.findByRole('dialog', { name: /Choose a spreadsheet/ });
    fireEvent.change(within(chooser).getByLabelText('Or paste a link to the spreadsheet'), { target: { value: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit' } });
    fireEvent.click(within(chooser).getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(within(dialog()).getByTestId('chosen-file')).toHaveTextContent('Pasted sheet'));
  });
});

describe('the folder editor', () => {
  it('browses into a folder and chooses it, creates one, and shows a live example of the file name', async () => {
    const root = { items: [{ id: 'folder-1', name: 'Receipts', kind: 'folder', mimeType: 'x', size: null, modifiedAt: null, webUrl: null, parentId: null }], nextPageToken: null };
    const { drafts, requests } = mount({
      responses: {
        [`GET /connections/${WORK}/files?type=folder`]: root,
        [`GET /connections/${WORK}/files?type=folder&folderId=folder-1`]: { items: [], nextPageToken: null },
        [`POST /connections/${WORK}/folders`]: { id: 'folder-9', name: 'Loan 2026', kind: 'folder', mimeType: 'x', size: null, modifiedAt: null, webUrl: null, parentId: 'folder-1' },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save to a folder' }));
    const d = dialog();
    expect(within(d).getByTestId('name-example')).toHaveTextContent('Example: Pay the car loan 2026-11-18.pdf');
    fireEvent.click(within(d).getByRole('radio', { name: 'A folder in one of my accounts' }));
    fireEvent.click(within(d).getByRole('button', { name: 'Choose a folder' }));
    const chooser = await screen.findByRole('dialog', { name: /Choose a folder in Work/ });
    fireEvent.click(await within(chooser).findByRole('button', { name: 'Receipts' }));
    fireEvent.click(await within(chooser).findByRole('button', { name: 'New folder in Receipts' }));
    fireEvent.change(within(chooser).getByLabelText('Folder name'), { target: { value: 'Loan 2026' } });
    fireEvent.click(within(chooser).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(requests('POST', `/connections/${WORK}/folders`)[0]!.body).toEqual({ name: 'Loan 2026', parentId: 'folder-1' }));
    fireEvent.click(await within(chooser).findByRole('button', { name: 'Choose “Receipts”' }));
    await waitFor(() => expect(within(dialog()).getByTestId('chosen-folder')).toHaveTextContent('Receipts'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(drafts()).toHaveLength(1));
    expect((drafts()[0]!.config as FolderConfig).target).toEqual({ connectionId: WORK, folderId: 'folder-1' });
  });

  it('refuses a folder delivery with no file chosen or no folder', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save to a folder' }));
    const d = dialog();
    fireEvent.click(within(d).getByRole('checkbox', { name: 'The PDF report' }));
    fireEvent.click(within(d).getByRole('button', { name: 'Done' }));
    expect(await within(d).findByText('Choose at least one file to save')).toBeInTheDocument();
  });
});

describe('the webhook editor', () => {
  it('needs an https address and keeps sensitive values off unless asked', async () => {
    const { drafts } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Webhook' }));
    const d = dialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Done' }));
    expect(await within(d).findByText('Enter the address to send to')).toBeInTheDocument();
    fireEvent.change(within(d).getByLabelText('Web address'), { target: { value: 'http://hooks.example.test' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Done' }));
    expect(await within(d).findByText('Use an https address')).toBeInTheDocument();
    fireEvent.change(within(d).getByLabelText('Web address'), { target: { value: 'https://hooks.example.test/run' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(drafts()).toHaveLength(1));
    expect(drafts()[0]!.config).toMatchObject({ url: 'https://hooks.example.test/run', includeSensitive: false, includeReportLink: true });
  });
});

describe('the guided setup', () => {
  it('fills the form with the outputs and two deliveries and saves nothing', async () => {
    const { drafts, requests } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Keep a record of each run' }));
    const d = dialog();
    fireEvent.change(within(d).getByLabelText('Value 1'), { target: { value: 'Statement balance' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Next' }));
    fireEvent.change(within(d).getByLabelText('Email address'), { target: { value: 'person-a@example.test' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Next' }));
    fireEvent.change(within(d).getByLabelText('Name of the new spreadsheet'), { target: { value: 'Car loan' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Fill in the form' }));
    await waitFor(() => expect(drafts()).toHaveLength(2));
    expect(drafts().map((x) => x.kind)).toEqual(['email', 'sheet_row']);
    const sheet = drafts()[1]!.config as SheetRowConfig;
    expect(sheet.createIfMissing).toBe(true);
    expect(sheet.newTitle).toBe('Car loan');
    expect(sheet.columns.map((c) => c.header)).toEqual(['Run date', 'Confirmation number', 'Amount paid', 'Statement balance']);
    // Only the form changed: no delivery, task or recipient request.
    expect(requests('POST', '/tasks')).toHaveLength(0);
    expect(requests('POST', '/delivery-recipients')).toHaveLength(0);
  });

  it('skips the spreadsheet step when no account may change documents', async () => {
    mount({ connections: [conn({ capabilities: ['mail_read'] })] });
    fireEvent.click(await screen.findByRole('button', { name: 'Keep a record of each run' }));
    const d = dialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Next' }));
    fireEvent.click(within(d).getByRole('button', { name: 'Next' }));
    expect(within(d).getByText(/Connect a Google or Microsoft account/)).toBeInTheDocument();
  });
});

describe('the Google picker', () => {
  it('is not loaded until the owner asks for it in a chooser, and only for a Google account with Documents on', async () => {
    const loadPicker = vi.fn().mockRejectedValue(new PickerUnavailable('script'));
    mount({
      loadPicker,
      responses: {
        [`GET /connections/${WORK}/files?type=any`]: { items: [], nextPageToken: null },
        [`GET /connections/${OUTLOOK}/files?type=any`]: { items: [], nextPageToken: null },
        [`POST /connections/${WORK}/picker`]: { accessToken: 'ya29.example-token', appId: '123456789012', apiKey: 'AIzaSyExampleKeyNotReal-0001', expiresAt: null },
      },
    });
    // Opening the editor or the chooser adds no script.
    expect(document.querySelector(`script[src="${PICKER_SCRIPT}"]`)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Spreadsheet row' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Choose a spreadsheet' }));
    const chooser = await screen.findByRole('dialog', { name: /Choose a spreadsheet in Work/ });
    expect(document.querySelector(`script[src="${PICKER_SCRIPT}"]`)).toBeNull();
    expect(loadPicker).not.toHaveBeenCalled();
    fireEvent.click(within(chooser).getByRole('button', { name: 'Choose from Google Drive' }));
    await waitFor(() => expect(loadPicker).toHaveBeenCalledTimes(1));
    // The script cannot load here: the dialog says so and offers the link instead, and nothing crashes.
    expect(await within(chooser).findByText(/could not be loaded.*Paste the spreadsheet/s)).toBeInTheDocument();
  });

  it('is not offered for a Microsoft account', async () => {
    mount({ responses: { [`GET /connections/${OUTLOOK}/files?type=any`]: { items: [], nextPageToken: null } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Spreadsheet row' }));
    fireEvent.mouseDown(within(dialog()).getByRole('combobox', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('option', { name: /Outlook/ }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Choose a spreadsheet' }));
    const chooser = await screen.findByRole('dialog', { name: /Choose a spreadsheet in Outlook/ });
    await within(chooser).findByText('Nothing found.');
    expect(within(chooser).queryByRole('button', { name: 'Choose from Google Drive' })).toBeNull();
  });

  it('loads Google\'s script only inside loadGooglePicker, once', async () => {
    const { loadGooglePicker } = await import('../connections/googlePicker');
    expect(document.querySelector(`script[src="${PICKER_SCRIPT}"]`)).toBeNull();
    const first = loadGooglePicker();
    const second = loadGooglePicker();
    expect(document.querySelectorAll(`script[src="${PICKER_SCRIPT}"]`)).toHaveLength(1);
    // The browser could not fetch it: both calls reject, and the next call may try again.
    document.querySelector(`script[src="${PICKER_SCRIPT}"]`)!.dispatchEvent(new Event('error'));
    await expect(first).rejects.toMatchObject({ name: 'PickerUnavailable', reason: 'script' });
    await expect(second).rejects.toMatchObject({ reason: 'script' });
  });
});

describe('saving a list of deliveries', () => {
  it('sends the plan: deletes, a create with its position, and shows a webhook secret once', async () => {
    const calls: string[] = [];
    const api = {
      get: vi.fn(),
      post: vi.fn(async (path: string, body: unknown) => {
        calls.push(`POST ${path} ${JSON.stringify((body as { position?: number }).position)}`);
        return { ...delivery({ id: 'new1', kind: 'webhook', config: { url: 'https://hooks.example.test/run', includeOutputs: true, includeReportLink: true, includeSensitive: false } }), signingSecret: 'whsec_example' };
      }),
      patch: vi.fn(),
      delete: vi.fn(async (path: string) => void calls.push(`DELETE ${path}`)),
    };
    const old = delivery({ id: 'old' });
    const hook = newDraft('webhook');
    (hook.config as { url: string }).url = 'https://hooks.example.test/run';
    const r = await syncDeliveries(api as never, TASK, [old], [hook]);
    expect(calls).toEqual([`DELETE /tasks/${TASK}/deliveries/old`, `POST /tasks/${TASK}/deliveries 0`]);
    expect(r.error).toBeNull();
    expect(r.secrets).toEqual([{ host: 'hooks.example.test', secret: 'whsec_example' }]);
    expect(r.drafts[0]!.id).toBe('new1');
    expect(r.saved.map((s) => s.id)).toEqual(['new1']);
    render(<DeliverySecretsDialog secrets={r.secrets} onClose={() => undefined} />);
    expect(screen.getByTestId('signing-secret')).toHaveTextContent('whsec_example');
    expect(screen.getByText(/only time it is shown/i)).toBeInTheDocument();
  });

  it('stops at the first refusal and reports what the server holds now', async () => {
    const api = {
      post: vi.fn().mockResolvedValueOnce(delivery({ id: 'n1' })).mockRejectedValueOnce(createTestApiError(409, 'Not confirmed', 'RECIPIENT_NOT_CONFIRMED', { addresses: ['person-f@example.test'] })),
      patch: vi.fn(),
      delete: vi.fn(),
    };
    const a = emailDraft();
    const b = emailDraft({ to: ['person-f@example.test'] });
    const r = await syncDeliveries(api as never, TASK, [], [a, b]);
    expect(r.saved.map((s) => s.id)).toEqual(['n1']);
    expect(r.drafts[0]!.id).toBe('n1');
    expect(r.drafts[1]!.id).toBeNull();
    expect(r.error?.key).toBe(b.key);
  });
});
