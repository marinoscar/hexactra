// The Memories page (#551) against canned API answers: grouping, search, the
// dialog with detail rows, the inline secret refusal, delete with confirm,
// the empty state and permissions.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { vi } from 'vitest';

import type { Memory } from '../memories/api';
import { displayValue } from '../memories/api';
import { MemoriesPage } from '../pages/MemoriesPage';
import { ConfirmProvider } from '../ui';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const READ = ['memories:read'];
const WRITE = ['memories:read', 'memories:write'];
const iso = '2026-11-18T10:00:00.000Z';

const memory = (over: Partial<Memory>): Memory => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'person',
  label: 'My wife',
  aliases: ['wife'],
  attributes: { name: 'Person A', phone: '555-010-6020' },
  note: null,
  status: 'active',
  source: 'owner',
  sourceRunId: null,
  sourceConversationId: null,
  supersededById: null,
  lastUsedAt: null,
  createdAt: iso,
  updatedAt: iso,
  ...over,
});

const WIFE = memory({});
const CHECKING = memory({ id: '22222222-2222-4222-8222-222222222222', kind: 'account', label: 'Checking account', aliases: [], attributes: { bank: 'Bank of Example', ending: '0659' }, source: 'agent_proposed', sourceConversationId: '33333333-3333-4333-8333-333333333333' });
const SEAT = memory({ id: '44444444-4444-4444-8444-444444444444', kind: 'preference', label: 'Seat', aliases: [], attributes: { seat: 'aisle' } });

function renderPage(host: ReturnType<typeof createTestPlatformHost>) {
  return render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>
          <MemoriesPage />
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
}

const reads = (list: Memory[]) => ({ 'GET /memories?status=active': list, 'GET /memories?status=all': list });

describe('MemoriesPage', () => {
  it('groups memories by kind, masks long numbers and names the source', async () => {
    renderPage(createTestPlatformHost({ permissions: READ, responses: reads([WIFE, CHECKING, SEAT]) }));
    const people = await screen.findByRole('list', { name: 'People' });
    expect(within(people).getByText('My wife')).toBeInTheDocument();
    expect(within(people).getByText('phone: •••• 6020')).toBeInTheDocument();
    expect(within(people).getByText('Added by you', { exact: false })).toBeInTheDocument();
    const accounts = screen.getByRole('list', { name: 'Accounts' });
    expect(within(accounts).getByText('ending: 0659')).toBeInTheDocument();
    expect(within(accounts).getByText('Suggested by the agent, approved by you', { exact: false })).toBeInTheDocument();
    expect(within(accounts).getByRole('link', { name: 'the chat' })).toHaveAttribute('href', `/chat/${CHECKING.sourceConversationId}`);
    expect(screen.getByRole('list', { name: 'Preferences' })).toBeInTheDocument();
    // A reader cannot add.
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for My wife' }));
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'View history' })).toBeInTheDocument();
  });

  it('searches labels, aliases and values, and filters by kind', async () => {
    renderPage(createTestPlatformHost({ permissions: READ, responses: reads([WIFE, CHECKING, SEAT]) }));
    await screen.findByText('My wife');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'aisle' } });
    expect(screen.queryByText('My wife')).not.toBeInTheDocument();
    expect(screen.getByText('Seat')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'WIFE' } });
    expect(screen.getByText('My wife')).toBeInTheDocument();
    expect(screen.queryByText('Seat')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: '' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Kind' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Accounts' }));
    expect(screen.queryByText('My wife')).not.toBeInTheDocument();
    expect(screen.getByText('Checking account')).toBeInTheDocument();
  });

  it('adds a memory with detail rows', async () => {
    const host = createTestPlatformHost({ permissions: WRITE, responses: { ...reads([SEAT]), 'POST /memories': (r: TestApiRequest) => memory(r.body as Partial<Memory>) } });
    renderPage(host);
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a memory' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Label/ }), { target: { value: 'My wife' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Detail 1 name' }), { target: { value: 'name' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Detail 1 value' }), { target: { value: 'Person A' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a detail' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Detail 2 name' }), { target: { value: 'phone' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Detail 2 value' }), { target: { value: '555-010-6020' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === '/memories')).toBe(true));
    const post = host.requests.find((r) => r.method === 'POST' && r.path === '/memories')!;
    expect(post.body).toEqual({ kind: 'person', label: 'My wife', aliases: [], attributes: { name: 'Person A', phone: '555-010-6020' }, note: null });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a memory' })).not.toBeInTheDocument());
  });

  it('shows a secret refusal under the field that failed', async () => {
    const host = createTestPlatformHost({
      permissions: WRITE,
      responses: {
        ...reads([SEAT]),
        'POST /memories': () => {
          throw createTestApiError(422, '"card" looks like a full card number.', 'MEMORY_HOLDS_SECRET', { issues: [{ field: 'card', reason: 'card', message: '"card" looks like a full card number. Keep the last four digits.' }] });
        },
      },
    });
    renderPage(host);
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Label/ }), { target: { value: 'Card' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Detail 1 name' }), { target: { value: 'card' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Detail 1 value' }), { target: { value: '4242 4242 4242 4242' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('"card" looks like a full card number. Keep the last four digits.')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Detail 1 value' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('edits a value through supersede and the label through patch', async () => {
    const host = createTestPlatformHost({
      permissions: WRITE,
      responses: { ...reads([WIFE]), [`POST /memories/${WIFE.id}/supersede`]: WIFE, [`PATCH /memories/${WIFE.id}`]: WIFE },
    });
    renderPage(host);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for My wife' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit memory' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Detail 2 value' }), { target: { value: '555-010-7777' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.some((r) => r.path === `/memories/${WIFE.id}/supersede`)).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Actions for My wife' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit memory' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Label/ }), { target: { value: 'Spouse' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'PATCH')).toBe(true));
    expect(host.requests.find((r) => r.method === 'PATCH')!.body).toMatchObject({ label: 'Spouse' });
  });

  it('deletes after confirming', async () => {
    const host = createTestPlatformHost({ permissions: WRITE, responses: { ...reads([WIFE]), [`DELETE /memories/${WIFE.id}`]: undefined } });
    renderPage(host);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for My wife' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this memory?' });
    expect(within(confirm).getByText('The agent will ask you for it again when it needs it.')).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'DELETE' && r.path === `/memories/${WIFE.id}`)).toBe(true));
  });

  it('archives and shows the history', async () => {
    const host = createTestPlatformHost({
      permissions: WRITE,
      responses: {
        ...reads([WIFE]),
        [`POST /memories/${WIFE.id}/archive`]: { ...WIFE, status: 'archived' },
        [`GET /memories/${WIFE.id}`]: { ...WIFE, history: [memory({ id: '55555555-5555-4555-8555-555555555555', status: 'superseded', attributes: { phone: '555-010-1111' } })] },
      },
    });
    renderPage(host);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for My wife' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(host.requests.some((r) => r.path === `/memories/${WIFE.id}/archive`)).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for My wife' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'View history' }));
    const dialog = await screen.findByRole('dialog', { name: 'History of My wife' });
    expect(within(dialog).getByText('phone: •••• 1111')).toBeInTheDocument();
  });

  it('explains memories when there are none', async () => {
    renderPage(createTestPlatformHost({ permissions: WRITE, responses: reads([]) }));
    expect(await screen.findByText('No memories yet')).toBeInTheDocument();
    expect(screen.getByText(/My wife: her name and the phone/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a memory' })).toBeInTheDocument();
  });

  it('hides Add in the empty state for a reader', async () => {
    renderPage(createTestPlatformHost({ permissions: READ, responses: reads([]) }));
    expect(await screen.findByText('No memories yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a memory' })).not.toBeInTheDocument();
  });
});

describe('displayValue', () => {
  it('shows the last four of a long number and the rest as typed', () => {
    expect(displayValue('555-010-6020')).toBe('•••• 6020');
    expect(displayValue('0659')).toBe('0659');
    expect(displayValue('Person A')).toBe('Person A');
  });
});
