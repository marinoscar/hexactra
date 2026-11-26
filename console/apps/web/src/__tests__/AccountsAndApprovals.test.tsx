// Accounts on tasks and chats and the approval cards for them (E39.10, #607): the three-way choice, the disabled states, the collapsed
// summary, what the task form and the chat send, the chips above the composer, the three card layouts, the recipient choices of "Don't ask
// again", the question that asks which account, and the Inbox group for approvals that wait on the owner.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatSettingsDialog } from '../components/ChatSettingsDialog';
import { ConnectionActionCard } from '../components/ConnectionActionCard';
import { QuestionAnswerForm } from '../components/QuestionAnswerForm';
import type { AskedQuestion, QuestionAction, Rememberable } from '../components/questions';
import { domainsOf, NO_REMEMBER, rememberRuleOf } from '../components/RememberRuleField';
import type { Connection } from '../connections/api';
import { InboxPage, type InboxItem } from '../pages/InboxPage';
import { TaskCreatePage } from '../pages/TaskCreatePage';
import { TaskEditPage } from '../pages/TaskEditPage';
import { switchedOnNames, switchedOnSummary } from '../taskConnections/model';
import type { Chat } from '../types/chat';
import { ConfirmProvider, ToastHost } from '../ui';
import { mockViewport } from './matchMedia';
import { POLICY_READS } from './policyFixtures';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const WORK = '22222222-2222-4222-8222-222222222222';
const PERSONAL = '33333333-3333-4333-8333-333333333333';
const PAUSED = '44444444-4444-4444-8444-444444444444';
const BROKEN = '55555555-5555-4555-8555-555555555555';
const READER = '66666666-6666-4666-8666-666666666666';
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '77777777-7777-4777-8777-777777777777';

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
  conn({ id: PERSONAL, provider: 'microsoft', label: 'Personal', accountEmail: 'person-b@example.test', capabilities: ['mail_read', 'calendar_read', 'calendar_write'] }),
  conn({ id: PAUSED, label: 'Old', accountEmail: 'person-c@example.test', status: 'paused' }),
  conn({ id: BROKEN, label: 'Stale', accountEmail: 'person-d@example.test', status: 'needs_reconnect', statusReason: 'GRANT_REVOKED' }),
  conn({ id: READER, label: 'Reader', accountEmail: 'person-e@example.test', capabilities: ['mail_read'] }),
];

describe('the model (E50.17)', () => {
  it('names what is switched on: the active connections, and nothing paused or to reconnect', () => {
    expect(switchedOnNames(CONNECTIONS)).toEqual(['Work', 'Personal', 'Reader']);
    expect(switchedOnSummary(CONNECTIONS)).toBe('Everything you switched on: Work, Personal, Reader');
    expect(switchedOnSummary([])).toBe('Nothing switched on yet: the agent uses the browser.');
    expect(switchedOnSummary(null)).toBe('Everything you switched on');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------

const hostBase = { version: '0.1.0', browserConnected: false, onDemand: true, viewerUrl: null, desktop: true, lastSeen: '2026-11-17T00:00:00Z' };
const TASK = {
  id: TASK_ID,
  name: 'Check the inbox',
  goal: 'Summarise my unread email each morning',
  profile: 'default',
  hostId: null,
  hostFallback: true,
  allowedDomains: [],
  confirmRiskyActions: false,
  policyId: null,
  connections: [{ connectionId: WORK, access: 'read', label: 'Work', provider: 'google', accountEmail: 'person-a@example.test', status: 'active' }],
  needsBrowser: 'auto',
  summary: { schedules: [] },
};

function mountForm(path: string, permissions: string[], responses: Record<string, unknown> = {}) {
  const host = createTestPlatformHost({
    permissions,
    responses: {
      ...POLICY_READS,
      'GET /fleet/hosts': [{ ...hostBase, id: 'h1', name: 'home', online: true, draining: false, mode: 'unattended', profiles: [{ name: 'default', running: false }] }],
      'GET /connections': CONNECTIONS,
      'POST /tasks': { ...TASK, id: NEW_ID },
      [`GET /tasks/${TASK_ID}?include=summary`]: TASK,
      [`PATCH /tasks/${TASK_ID}`]: TASK,
      ...responses,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/tasks/new" element={<TaskCreatePage />} />
            <Route path="/tasks/:id/edit" element={<TaskEditPage />} />
            <Route path="/tasks/:id" element={<div>task page</div>} />
            <Route path="/tasks" element={<div>tasks</div>} />
          </Routes>
        </MemoryRouter>
        <ToastHost />
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return { host, sent: (method: string, p: string) => host.requests.filter((r: TestApiRequest) => r.method === method && r.path === p) };
}
const PERMS = ['tasks:read', 'tasks:write', 'runs:write', 'agent_policies:read', 'fleet:read', 'connections:read'];

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('the tools and accounts section of the task form (E50.17)', () => {
  it('is hidden without connections:read', async () => {
    mountForm('/tasks/new', ['tasks:read', 'tasks:write', 'runs:write', 'agent_policies:read', 'fleet:read']);
    await screen.findByRole('heading', { name: 'Outputs' });
    expect(screen.queryByRole('button', { name: /Tools and accounts/ })).toBeNull();
  });

  it('asks nothing: one read-only line names what is switched on, links to the page, and nothing about accounts is sent', async () => {
    const { sent } = mountForm('/tasks/new', PERMS);
    const toggle = await screen.findByRole('button', { name: /Tools and accounts/ });
    await waitFor(() => expect(screen.getByTestId('accounts-summary')).toHaveTextContent('Everything you switched on: Work, Personal, Reader'));
    fireEvent.click(toggle);
    const line = await screen.findByTestId('switched-on-tools');
    expect(line).toHaveTextContent('The agent can use everything you switched on in Connections and tools: Work, Personal, Reader.');
    expect(within(line).getByRole('link', { name: 'Connections and tools' })).toHaveAttribute('href', '/settings/connections');
    expect(screen.queryByRole('button', { name: 'Limit this task' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Read only: / })).toBeNull();
    expect(screen.queryByLabelText('Does this task use a browser?')).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Inbox digest' } });
    fireEvent.change(screen.getByLabelText(/^Goal/), { target: { value: 'Summarise my unread email each morning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/tasks')).toHaveLength(1));
    const body = sent('POST', '/tasks')[0]!.body;
    expect(body).not.toHaveProperty('connections');
    expect(body).not.toHaveProperty('connectionsMode');
    expect(body).not.toHaveProperty('needsBrowser');
  });

  it('editing a task that once listed accounts sends no account field', async () => {
    const { sent } = mountForm(`/tasks/${TASK_ID}/edit`, PERMS);
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', `/tasks/${TASK_ID}`)).toHaveLength(1));
    expect(sent('PATCH', `/tasks/${TASK_ID}`)[0]!.body).toEqual({ name: 'Renamed' });
  });

  it('says so when the list of connections could not be loaded', async () => {
    mountForm(`/tasks/${TASK_ID}/edit`, PERMS, { 'GET /connections': () => { throw Object.assign(new Error('down'), { status: 500 }); } });
    fireEvent.click(await screen.findByRole('button', { name: /Tools and accounts/ }));
    expect(await screen.findByText(/Your connections could not be loaded/)).toBeInTheDocument();
  });
});

describe('the deliveries section of the task form is hidden without runs:read and saved with the task', () => {
  const SAVED = { id: 'd1', taskId: TASK_ID, kind: 'email', enabled: true, when: 'succeeded', position: 0, config: { via: 'console', to: ['person-a@example.test'], attach: { pdf: true, json: false, screenshots: 'none' }, includeOutputs: true, includeSensitive: false }, recipients: [], connection: null, disabledReason: null, webhookSecretConfigured: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };

  it('is hidden without runs:read, and read-only without runs:write', async () => {
    mountForm(`/tasks/${TASK_ID}/edit`, ['tasks:read', 'tasks:write', 'agent_policies:read', 'fleet:read']);
    await screen.findByRole('heading', { name: 'Outputs' });
    expect(screen.queryByRole('button', { name: /Where the result goes/ })).toBeNull();
  });

  it('says it is loading, not that nothing is sent, until the saved deliveries are read', async () => {
    let release: (v: unknown) => void = () => undefined;
    const pending = new Promise((r) => (release = r));
    mountForm(`/tasks/${TASK_ID}/edit`, ['tasks:read', 'tasks:write', 'runs:read', 'runs:write', 'connections:read'], { [`GET /tasks/${TASK_ID}/deliveries`]: () => pending, 'GET /delivery-recipients': [] });
    await waitFor(() => expect(screen.getByTestId('deliveries-summary')).toHaveTextContent('Loading the deliveries…'));
    expect(screen.queryByText('Nothing is sent when a run ends.')).toBeNull();
    release([]);
    await waitFor(() => expect(screen.getByTestId('deliveries-summary')).toHaveTextContent('Nothing is sent when a run ends.'));
  });

  it('shows the saved deliveries read-only without runs:write', async () => {
    mountForm(`/tasks/${TASK_ID}/edit`, ['tasks:read', 'tasks:write', 'runs:read', 'connections:read'], { [`GET /tasks/${TASK_ID}/deliveries`]: [SAVED], 'GET /delivery-recipients': [] });
    // While the saved list is being read the summary says so, never "Nothing is sent".
    expect(screen.queryByText('Nothing is sent when a run ends.')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('deliveries-summary')).toHaveTextContent('Email to 1 person with the PDF report, when it succeeds'));
    fireEvent.click(screen.getByRole('button', { name: /Where the result goes/ }));
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add a delivery' })).toBeNull();
    expect(screen.getByText(/needs permission to run tasks/)).toBeInTheDocument();
  });

  it('saves a new delivery after the task, with its position', async () => {
    const created = { id: 'd-new', taskId: NEW_ID, kind: 'webhook', enabled: true, when: 'succeeded', position: 0, config: { url: 'https://hooks.example.test/run', includeOutputs: true, includeReportLink: true, includeSensitive: false }, recipients: [], connection: null, disabledReason: null, webhookSecretConfigured: true, createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z', signingSecret: 'whsec_example' };
    const { sent } = mountForm('/tasks/new', [...PERMS, 'runs:read'], { 'GET /delivery-recipients': [], [`POST /tasks/${NEW_ID}/deliveries`]: created });
    fireEvent.click(await screen.findByRole('button', { name: /Where the result goes/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Webhook' }));
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Web address'), { target: { value: 'https://hooks.example.test/run' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Done' }));
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Pay' } });
    fireEvent.change(await screen.findByLabelText(/^Goal/), { target: { value: 'Pay the bill' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', `/tasks/${NEW_ID}/deliveries`)).toHaveLength(1));
    expect(sent('POST', `/tasks/${NEW_ID}/deliveries`)[0]!.body).toMatchObject({ kind: 'webhook', enabled: true, when: 'succeeded', position: 0, config: { url: 'https://hooks.example.test/run' } });
    // The signing secret is shown once, before the page leaves.
    expect(await screen.findByTestId('signing-secret')).toHaveTextContent('whsec_example');
    expect(screen.queryByText('task page')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'I copied it' }));
    expect(await screen.findByText('task page')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------

const CHAT: Chat = {
  id: 'c1',
  title: 'Mail',
  status: 'active',
  profile: 'default',
  hostId: null,
  hostFallback: true,
  policyId: null,
  allowedDomains: [],
  confirmRiskyActions: false,
  connections: [{ connectionId: WORK, access: 'read', label: 'Work', provider: 'google', accountEmail: 'person-a@example.test', status: 'active' }],
  lastMessageAt: '2026-11-19T00:00:00Z',
  createdAt: '2026-11-19T00:00:00Z',
  updatedAt: '2026-11-19T00:00:00Z',
};

describe('chat', () => {
  function mountDialog(permissions: string[], onSave = vi.fn().mockResolvedValue(undefined)) {
    const host = createTestPlatformHost({ permissions, responses: { ...POLICY_READS, 'GET /fleet/hosts': [], 'GET /connections': CONNECTIONS, 'GET /memories/settings': { suggest: false } } });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter>
          <ChatSettingsDialog open chat={CHAT} onClose={() => undefined} onSave={onSave} />
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    return onSave;
  }

  it('shows the one read-only line instead of a choice, and never sends accounts', async () => {
    const onSave = mountDialog(['connections:read', 'agent_policies:read']);
    const region = await screen.findByRole('region', { name: 'Tools and accounts' });
    await waitFor(() => expect(within(region).getByTestId('switched-on-tools')).toHaveTextContent('The agent can use everything you switched on in Connections and tools: Work, Personal, Reader.'));
    expect(screen.queryByRole('button', { name: /Read and change: / })).toBeNull();
    expect(screen.queryByText(/New chats/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('connections');
  });

  it('has no tools section without connections:read', () => {
    mountDialog(['agent_policies:read']);
    expect(screen.queryByRole('region', { name: 'Tools and accounts' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------

const EMAIL: QuestionAction = {
  connectionId: WORK,
  connectionLabel: 'Work',
  tool: 'mail_send',
  summary: 'Send mail with Work',
  lines: [
    { label: 'From', value: 'person-a@example.test' },
    { label: 'To', value: 'person-f@example.test, person-g@example.test' },
    { label: 'Subject', value: 'Loan payment confirmation' },
    { label: 'Message', value: 'Hello Person F, I paid… (120 more characters: show all)' },
  ],
  body: 'Hello Person F, I paid the loan today.\nConfirmation C-8841.',
};
const EVENT: QuestionAction = {
  connectionId: PERSONAL,
  connectionLabel: 'Personal',
  tool: 'calendar_create_event',
  summary: 'Create calendar events with Personal',
  lines: [
    { label: 'Title', value: 'Loan review' },
    { label: 'When', value: '2026-12-01T10:00:00Z to 2026-12-01T10:30:00Z' },
    { label: 'Attendees', value: 'person-f@example.test (they will be emailed)' },
  ],
};
const ROW: QuestionAction = {
  connectionId: WORK,
  connectionLabel: 'Work',
  tool: 'sheet_append_rows',
  summary: 'Add rows with Work',
  lines: [
    { label: 'File', value: 'Car loan' },
    { label: 'Cells', value: '2026-11-18 | C-8841 | 412.50' },
  ],
};
const ask = (action: QuestionAction, rememberable?: Rememberable): AskedQuestion => ({ kind: 'confirmation', input: 'confirm', options: null, constraints: null, confirmLabel: 'Allow', denyLabel: 'Deny', risk: 'high', viewerUrl: null, action, rememberable: rememberable ?? null });

describe('the approval cards', () => {
  it('an email shows From, To, Subject and a preview, and "Show all" reveals the whole message', () => {
    render(<ConnectionActionCard action={EMAIL} />);
    const card = within(screen.getByTestId('connection-action-card'));
    expect(card.getByRole('heading', { name: 'Work: send an email' })).toBeInTheDocument();
    for (const label of ['From', 'To', 'Subject', 'Message']) expect(card.getByText(label)).toBeInTheDocument();
    expect(card.getByText('person-f@example.test, person-g@example.test')).toBeInTheDocument();
    expect(card.queryByTestId('action-body')).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Show all' }));
    expect(card.getByTestId('action-body')).toHaveTextContent('Confirmation C-8841.');
    expect(card.queryByTestId('notify-warning')).toBeNull();
  });

  it('an event shows the title, the time, the attendees and "They will be notified"', () => {
    render(<ConnectionActionCard action={EVENT} />);
    const card = within(screen.getByTestId('connection-action-card'));
    expect(card.getByRole('heading', { name: 'Personal: create an event' })).toBeInTheDocument();
    expect(card.getByText('Loan review')).toBeInTheDocument();
    expect(card.getByText('person-f@example.test (they will be emailed)')).toBeInTheDocument();
    expect(card.getByTestId('notify-warning')).toHaveTextContent('They will be notified.');
  });

  it('an event nobody is told about carries no warning', () => {
    render(<ConnectionActionCard action={{ ...EVENT, lines: [...EVENT.lines.slice(0, 2), { label: 'Attendees', value: 'person-f@example.test (they will not be emailed)' }] }} />);
    expect(screen.queryByTestId('notify-warning')).toBeNull();
  });

  it('a row shows the file and the cells', () => {
    render(<ConnectionActionCard action={ROW} />);
    const card = within(screen.getByTestId('connection-action-card'));
    expect(card.getByRole('heading', { name: 'Work: add a row to a spreadsheet' })).toBeInTheDocument();
    expect(card.getByText('Car loan')).toBeInTheDocument();
    expect(card.getByText('2026-11-18 | C-8841 | 412.50')).toBeInTheDocument();
    expect(card.queryByRole('button', { name: 'Show all' })).toBeNull();
  });

  it('renders text, never markup, whatever a message holds', () => {
    render(<ConnectionActionCard action={{ ...EMAIL, lines: [{ label: 'Subject', value: '<img src=x onerror=alert(1)>' }] }} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe("\"Don't ask again\" for a call that reaches people", () => {
  const REMEMBER: Rememberable = { kind: 'connection', host: WORK, category: null, matchKey: 'mail_send', summary: 'Send mail with Work', scopes: ['everywhere', 'this_task'], recipients: ['person-f@example.test', 'person-g@example.test'] };

  it('offers these people or anyone at their domain, with no "anyone", and sends the choice', () => {
    const onSubmit = vi.fn();
    render(<QuestionAnswerForm question={ask(EMAIL, REMEMBER)} onSubmit={onSubmit} />);
    expect(screen.getByTestId('connection-action-card')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: "Don't ask again: Send mail with Work" }));
    expect(screen.getByRole('radio', { name: 'Only these people: person-f@example.test, person-g@example.test' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Anyone at example.test' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /^Anyone$/ })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Anyone at example.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    // A high-risk approval asks once more, and the card stays in view.
    expect(screen.getByTestId('connection-action-card')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Allow' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'approve', rememberRule: { enabled: true, recipientsFrom: 'domain' } });
  });

  it('defaults to these people, and Deny never carries the rule', () => {
    const onSubmit = vi.fn();
    render(<QuestionAnswerForm question={ask(EMAIL, REMEMBER)} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Don't ask again/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'deny' });
    expect(rememberRuleOf(REMEMBER, { ...NO_REMEMBER, ticked: true })).toEqual({ enabled: true, recipientsFrom: 'these' });
    expect(domainsOf(['a@example.test', 'b@Example.test', 'c@other.test'])).toEqual(['example.test', 'other.test']);
  });

  it('a tool that reaches no one offers no recipient choice', () => {
    render(<QuestionAnswerForm question={ask(ROW, { kind: 'connection', host: WORK, category: null, matchKey: 'sheet_append_rows', summary: 'Add rows with Work', scopes: ['everywhere'] })} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Don't ask again/ }));
    expect(screen.queryByText('Who it covers')).toBeNull();
  });
});

describe('the question that asks which account', () => {
  it('is a choice of account labels the owner picks from', () => {
    const onSubmit = vi.fn();
    render(
      <QuestionAnswerForm
        question={{ kind: 'other', input: 'choice', options: [{ id: 'Work', label: 'Work' }, { id: 'Personal', label: 'Personal' }], constraints: null, confirmLabel: null, denyLabel: null, risk: null, viewerUrl: null }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Personal' }));
    fireEvent.click(screen.getByRole('button', { name: /Send|Submit|Answer|Done/ }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed', value: 'Personal' });
  });
});

describe('the Inbox group for approvals', () => {
  const base = { goal: 'Pay the loan', askedBy: 'run:r', pageTitle: null, viewerUrl: null, choices: [], options: null, constraints: null, confirmLabel: 'Allow', denyLabel: 'Deny', risk: 'high' as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  const items: InboxItem[] = [
    { ...base, questionId: 'q1', runId: 'r1', handoffId: null, kind: 'confirmation', prompt: 'Send this email from Work?', input: 'confirm', action: EMAIL },
    { ...base, questionId: 'q2', runId: 'r2', handoffId: 'h2', kind: 'confirmation', prompt: 'Book the 9:00 flight for $120?', input: 'none', risk: null },
  ];

  it('lists the calls through accounts apart from the other requests, and counts both as waiting', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:write', 'runs:read'], responses: { 'GET /inbox': items } });
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <MemoryRouter>
            <InboxPage />
          </MemoryRouter>
        </ConfirmProvider>
      </PlatformHostProvider>,
    );
    const group = await screen.findByRole('region', { name: 'Account approvals' });
    expect(within(group).getByText('Send this email from Work?')).toBeInTheDocument();
    expect(within(group).getByTestId('connection-action-card')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Requests')).getByText('Book the 9:00 flight for $120?')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Requests')).queryByText('Send this email from Work?')).toBeNull();
    expect(screen.getByText('2 waiting for you')).toBeInTheDocument();
  });
});

describe('chips on a task', () => {
  it('say how many deliveries a task has and that an email starts it, no accounts chip (E50.17), and nothing for a plain task', async () => {
    const { TaskChips, taskChipLabels } = await import('../taskConnections/TaskChips');
    const wired = { connections: [], summary: { mailTriggers: 1, deliveries: 3 } };
    expect(taskChipLabels(wired as never)).toEqual(['3 deliveries', 'Starts from email']);
    render(<TaskChips task={wired as never} />);
    expect(within(screen.getByTestId('task-chips')).getAllByText(/deliver|email/).map((n) => n.textContent)).toEqual(['3 deliveries', 'Starts from email']);
    expect(taskChipLabels({ connections: [], summary: { mailTriggers: 0, deliveries: 0 } } as never)).toEqual([]);
    expect(taskChipLabels({ connections: undefined, summary: { deliveries: 1 } } as never)).toEqual(['1 delivery']);
  });
});
