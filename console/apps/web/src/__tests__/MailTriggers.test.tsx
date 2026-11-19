// The email trigger section of the task page (E39.8, #605): the form requires a sender, shows the server's refusals, maps the task's
// parameters, previews what would match without starting anything, and lists what a trigger did with each message.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MailTriggersSection } from '../mailTriggers/MailTriggersSection';
import { draftProblems, draftToBody, eventText, matchText, newDraft, previewReason, splitSenders } from '../mailTriggers/model';
import type { MailTrigger, TriggerEvent, TriggerPreview } from '../mailTriggers/api';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const TASK = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';
const PARAMS = [
  { key: 'invoice_number', label: 'Invoice number', type: 'text' as const, required: true },
  { key: 'password', label: 'Password', type: 'text' as const, required: true, sensitive: true },
];

const trigger = (over: Partial<MailTrigger> = {}): MailTrigger => ({
  id: '33333333-3333-4333-8333-333333333333',
  taskId: TASK,
  connectionId: CONN,
  connectionLabel: 'Work',
  name: 'Invoices',
  enabled: true,
  match: { from: ['billing@example.test'], subjectContains: 'invoice' },
  inputs: null,
  afterStart: 'none',
  pollSeconds: 300,
  maxRunsPerDay: 10,
  acceptUnverified: false,
  status: 'ok',
  statusReason: null,
  lastCheckedAt: '2026-11-18T10:00:00.000Z',
  lastMatchedAt: null,
  runsToday: 2,
  createdAt: '2026-11-17T10:00:00.000Z',
  updatedAt: '2026-11-17T10:00:00.000Z',
  ...over,
});

const CONNECTIONS = [
  { id: CONN, provider: 'google', label: 'Work', accountEmail: 'person-a@example.test', accountName: null, capabilities: ['mail_read', 'mail_modify'], granted: ['mail_read', 'mail_modify'], defaultFor: [], status: 'active', statusReason: null, connectedAt: '2026-11-01T00:00:00Z', lastUsedAt: null, lastRefreshAt: null },
  { id: '44444444-4444-4444-8444-444444444444', provider: 'google', label: 'Read only', accountEmail: 'person-b@example.test', accountName: null, capabilities: ['mail_read'], granted: ['mail_read'], defaultFor: [], status: 'active', statusReason: null, connectedAt: '2026-11-01T00:00:00Z', lastUsedAt: null, lastRefreshAt: null },
  { id: '55555555-5555-4555-8555-555555555555', provider: 'google', label: 'Calendar only', accountEmail: 'person-c@example.test', accountName: null, capabilities: ['calendar_read'], granted: ['calendar_read'], defaultFor: [], status: 'active', statusReason: null, connectedAt: '2026-11-01T00:00:00Z', lastUsedAt: null, lastRefreshAt: null },
];

const EVENTS: TriggerEvent[] = [
  { id: 'e1', outcome: 'started', reason: null, runId: '66666666-6666-4666-8666-666666666666', messageAt: '2026-11-18T09:59:00Z', createdAt: '2026-11-18T10:00:00Z' },
  { id: 'e2', outcome: 'skipped_unverified', reason: 'SENDER_NOT_VERIFIED', runId: null, messageAt: '2026-11-18T09:58:00Z', createdAt: '2026-11-18T09:59:00Z' },
  { id: 'e3', outcome: 'skipped_limit', reason: 'TRIGGER_DAILY_LIMIT', runId: null, messageAt: null, createdAt: '2026-11-18T09:50:00Z' },
];

const PREVIEW: TriggerPreview = {
  messages: [
    { date: '2026-11-18T09:00:00Z', subject: 'Your invoice INV-1 is ready', from: 'billing@example.test', wouldStart: true, reason: null, senderVerified: 'pass' },
    { date: '2026-10-01T09:00:00Z', subject: 'Your invoice INV-0', from: 'billing@example.test', wouldStart: false, reason: 'before_enabled', senderVerified: 'unknown' },
  ],
  note: null,
};

function mount(options: { triggers?: MailTrigger[]; permissions?: string[]; responses?: Record<string, unknown>; canWrite?: boolean } = {}) {
  const host = createTestPlatformHost({
    permissions: options.permissions ?? ['runs:read', 'runs:write', 'connections:read'],
    responses: {
      [`GET /tasks/${TASK}/mail-triggers`]: options.triggers ?? [trigger()],
      'GET /connections': CONNECTIONS,
      'GET /mail-triggers/33333333-3333-4333-8333-333333333333/events': EVENTS,
      ...(options.responses ?? {}),
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>
          <MailTriggersSection taskId={TASK} parameters={PARAMS} canWrite={options.canWrite ?? true} canRead canReadConnections />
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  const posted = (method: string, path: string) => host.requests.filter((r: TestApiRequest) => r.method === method && r.path.startsWith(path));
  return { host, posted };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('the model', () => {
  it('splits senders at commas, spaces and lines, without repeats', () => {
    expect(splitSenders('a@example.test, b@example.test\n@example.test  a@example.test')).toEqual(['a@example.test', 'b@example.test', '@example.test']);
    expect(splitSenders('  ')).toEqual([]);
  });

  it('requires a sender and refuses wildcards; marking mail needs the account to allow it', () => {
    const d = { ...newDraft(CONN) };
    expect(draftProblems(d, { canModify: true }).from).toMatch(/sender is required/i);
    expect(draftProblems({ ...d, from: '*@example.test' }, { canModify: true }).from).toMatch(/wildcards/i);
    expect(draftProblems({ ...d, from: 'a@example.test' }, { canModify: true })).toEqual({});
    expect(draftProblems({ ...d, from: 'a@example.test', afterStart: 'mark_read' }, { canModify: false }).afterStart).toMatch(/change mail/);
    expect(draftProblems({ ...d, from: 'a@example.test', afterStart: 'add_label', labelId: '' }, { canModify: true }).labelId).toBeTruthy();
    expect(draftProblems({ ...d, from: 'a@example.test', mappings: { k: { kind: 'capture_subject', value: 'no group' } } }, { canModify: true })['mapping:k']).toMatch(/one group/);
  });

  it('builds the request from the draft', () => {
    const body = draftToBody({
      ...newDraft(CONN),
      from: 'billing@example.test @corp.example.test',
      subjectContains: ' invoice ',
      attachment: 'with',
      afterStart: 'add_label',
      labelId: 'Processed',
      pollMinutes: 15,
      mappings: { invoice_number: { kind: 'capture_subject', value: '#(INV-\\d+)' }, other: { kind: 'none', value: '' }, who: { kind: 'from', value: '' } },
    });
    expect(body).toEqual({
      connectionId: CONN,
      match: { from: ['billing@example.test', '@corp.example.test'], subjectContains: 'invoice', hasAttachment: true },
      inputs: { invoice_number: { capture: { source: 'subject', pattern: '#(INV-\\d+)' } }, who: { header: 'from' } },
      afterStart: 'add_label:Processed',
      pollSeconds: 900,
      maxRunsPerDay: 10,
      acceptUnverified: false,
      enabled: true,
    });
  });

  it('says what happened in words', () => {
    expect(eventText({ outcome: 'started', reason: null })).toBe('Started a run');
    expect(eventText({ outcome: 'skipped_unverified', reason: 'SENDER_NOT_VERIFIED' })).toBe('Skipped: sender not verified');
    expect(eventText({ outcome: 'skipped_limit', reason: 'USER_DAILY_LIMIT' })).toBe('Skipped: your daily limit');
    expect(eventText({ outcome: 'failed', reason: 'START_FAILED' })).toBe('Could not start: the run could not be started');
    expect(matchText({ from: ['a@example.test'], hasAttachment: false, subjectContains: 'x' })).toBe('from a@example.test, subject has “x”, without an attachment');
    expect(previewReason({ wouldStart: false, reason: 'own_message' })).toBe('Would not start: sent from the account itself');
    expect(previewReason({ wouldStart: false, reason: 'sender_not_checked' })).toMatch(/could not check the sender/);
    expect(eventText({ outcome: 'skipped_unverified', reason: 'SENDER_NOT_CHECKED' })).toBe('Skipped: the provider could not check the sender');
  });
});

describe('the email triggers on the task page', () => {
  it('lists the triggers with their rules, status and history', async () => {
    restore = mockViewport(1024);
    mount({ triggers: [trigger({ status: 'needs_reconnect' })] });
    const card = await screen.findByTestId('mail-trigger');
    expect(within(card).getByText('Invoices')).toBeInTheDocument();
    expect(within(card).getByText(/from billing@example.test, subject has “invoice”/)).toBeInTheDocument();
    expect(within(card).getByText(/2 of 10 runs today/)).toBeInTheDocument();
    expect(within(card).getByText('Reconnect the account')).toBeInTheDocument();
    const events = await within(card).findByTestId('trigger-events');
    expect(within(events).getByRole('link', { name: 'Started a run' })).toHaveAttribute('href', '/runs/66666666-6666-4666-8666-666666666666');
    expect(within(events).getByText('Skipped: sender not verified')).toBeInTheDocument();
    expect(within(events).getByText('Skipped: this trigger\'s daily limit')).toBeInTheDocument();
  });

  it('cannot save without a sender: the button is off, and the sentence says why', async () => {
    restore = mockViewport(1024);
    const { posted } = mount({ triggers: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a trigger' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
    // Only accounts that can read mail are offered.
    fireEvent.mouseDown(within(dialog).getByLabelText(/Account to watch/));
    const options = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Work (person-a@example.test)', 'Read only (person-b@example.test)']);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: 'billing@example.test' } });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Add' })).toBeEnabled());
    expect(posted('POST', `/tasks/${TASK}/mail-triggers`)).toHaveLength(0);
  });

  it('saves the rules and the mapping; a sensitive parameter is not offered', async () => {
    restore = mockViewport(1024);
    const { posted } = mount({ triggers: [], responses: { [`POST /tasks/${TASK}/mail-triggers`]: trigger() } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a trigger' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Password')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: 'billing@example.test' } });
    fireEvent.change(within(dialog).getByLabelText('Subject contains'), { target: { value: 'invoice' } });
    fireEvent.mouseDown(within(dialog).getByLabelText('Invoice number'));
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'A part of the subject (pattern)' }));
    fireEvent.change(within(dialog).getByLabelText('Invoice number value'), { target: { value: '#(INV-\\d+)' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(posted('POST', `/tasks/${TASK}/mail-triggers`)).toHaveLength(1));
    expect(posted('POST', `/tasks/${TASK}/mail-triggers`)[0]!.body).toMatchObject({
      match: { from: ['billing@example.test'], subjectContains: 'invoice' },
      inputs: { invoice_number: { capture: { source: 'subject', pattern: '#(INV-\\d+)' } } },
      afterStart: 'none',
      pollSeconds: 300,
    });
  });

  it('shows the server\'s refusal of a pattern next to its parameter', async () => {
    restore = mockViewport(1024);
    mount({
      triggers: [],
      responses: {
        [`POST /tasks/${TASK}/mail-triggers`]: () => {
          throw createTestApiError(400, 'invoice_number: The pattern may not repeat a group that repeats (nested quantifiers)', 'MAIL_TRIGGER_INPUTS_INVALID', { issues: [{ key: 'invoice_number', message: 'The pattern may not repeat a group that repeats (nested quantifiers)' }] });
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a trigger' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: 'billing@example.test' } });
    fireEvent.mouseDown(within(dialog).getByLabelText('Invoice number'));
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'A part of the text (pattern)' }));
    fireEvent.change(within(dialog).getByLabelText('Invoice number value'), { target: { value: '(a+)+' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findAllByText(/nested quantifiers/)).not.toHaveLength(0);
  });

  it('accepting unverified senders is off by default and is sent only when switched on', async () => {
    restore = mockViewport(1024);
    const { posted } = mount({ triggers: [], responses: { [`POST /tasks/${TASK}/mail-triggers`]: trigger() } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a trigger' }));
    const dialog = await screen.findByRole('dialog');
    const sw = within(dialog).getByRole('switch', { name: /accept mail the provider could not verify/i });
    expect(sw).not.toBeChecked();
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: 'billing@example.test' } });
    fireEvent.click(sw);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(posted('POST', `/tasks/${TASK}/mail-triggers`)).toHaveLength(1));
    expect(posted('POST', `/tasks/${TASK}/mail-triggers`)[0]!.body).toMatchObject({ acceptUnverified: true });
  });

  it('Test shows what would match and starts nothing', async () => {
    restore = mockViewport(1024);
    const { posted } = mount({ responses: { 'POST /mail-triggers/33333333-3333-4333-8333-333333333333/test': PREVIEW } });
    fireEvent.click(await screen.findByRole('button', { name: 'Test: Invoices' }));
    const box = await screen.findByTestId('trigger-preview');
    expect(within(box).getByText(/Would start a run/)).toBeInTheDocument();
    expect(within(box).getByText(/Would not start: arrived before the trigger was switched on/)).toBeInTheDocument();
    expect(within(box).getByText(/Your invoice INV-1 is ready/)).toBeInTheDocument();
    expect(posted('POST', '/runs')).toHaveLength(0);
  });

  it('switches a trigger off, and a viewer without runs:write only reads', async () => {
    restore = mockViewport(1024);
    const first = mount({ responses: { 'PATCH /mail-triggers/33333333-3333-4333-8333-333333333333': trigger({ enabled: false }) } });
    fireEvent.click(await screen.findByRole('switch', { name: 'On: Invoices' }));
    await waitFor(() => expect(first.posted('PATCH', '/mail-triggers/')).toHaveLength(1));
    expect(first.posted('PATCH', '/mail-triggers/')[0]!.body).toEqual({ enabled: false });
  });

  it('read-only: no buttons, no switch', async () => {
    restore = mockViewport(1024);
    mount({ canWrite: false, permissions: ['runs:read'] });
    await screen.findByTestId('mail-trigger');
    expect(screen.queryByRole('button', { name: /Test|Edit|Delete/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
