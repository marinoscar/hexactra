// "What it is used for" on the Connections page (E39.10, #607): what uses an account, what it was used for lately (the operation, the time and
// the run, never content), and the approvals remembered for it with a link to Saved approvals.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { limitsText, categoryLabel, type ApprovalRule } from '../approvals/types';
import { ConnectionDetails, operationWords } from '../connections/ConnectionDetails';
import type { Connection } from '../connections/api';
import { ConnectionsPage } from '../pages/ConnectionsPage';
import { SavedApprovalsPage } from '../pages/SavedApprovalsPage';
import { ConfirmProvider } from '../ui';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const WORK: Connection = { id: ID, provider: 'google', label: 'Work', accountEmail: 'person.a@example.test', accountName: null, capabilities: ['mail_read', 'mail_send'], granted: ['mail_read', 'mail_send'], defaultFor: [], status: 'active', statusReason: null, connectedAt: '2026-11-18T10:00:00.000Z', lastUsedAt: null, lastRefreshAt: null };
const RULE: ApprovalRule = { id: 'r1', kind: 'connection', host: ID, category: null, matchKey: 'mail_send', summary: 'Send mail with Work', taskId: null, taskName: null, conversationId: null, maxAmount: null, recipients: ['person-f@example.test'], expiresAt: null, enabled: true, createdFromQuestionId: null, useCount: 2, lastUsedAt: null, lastUsedRunId: null, createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z' };
const SITE_RULE: ApprovalRule = { ...RULE, id: 'r2', kind: 'gate', host: 'shop.example.test', category: 'payment', matchKey: 'Pay', summary: "Press 'Pay' on shop.example.test", recipients: [] };

const RUN = '99999999-9999-4999-8999-999999999999';
const responses = {
  [`GET /connections/${ID}`]: { ...WORK, usedBy: [{ kind: 'task', id: 't1', name: 'Pay the car loan' }, { kind: 'delivery', id: 'd1', name: 'Pay the car loan: spreadsheet row delivery' }] },
  [`GET /connections/${ID}/activity`]: { items: [{ kind: 'tool', operation: 'mail_send', ok: true, at: '2026-11-18T18:00:00Z', runId: RUN }, { kind: 'delivery', operation: 'sheet_row', ok: false, at: '2026-11-18T17:00:00Z', runId: null }] },
  'GET /approval-rules': { paused: false, rules: [RULE, SITE_RULE] },
};

function mount(permissions: string[] = ['runs:read', 'connections:read'], extra: Record<string, unknown> = {}) {
  const host = createTestPlatformHost({ permissions, responses: { ...responses, ...extra } });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter>
        <ConnectionDetails connectionId={ID} canReadRuns={permissions.includes('runs:read')} />
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the details of a connection', () => {
  it('loads nothing until opened, then lists what uses it, its recent activity and its saved approvals', async () => {
    const host = mount();
    expect(host.requests).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'What it is used for' }));
    const panel = within(await screen.findByTestId(`connection-details-${ID}`));
    expect(await panel.findByText('Pay the car loan')).toBeInTheDocument();
    expect(panel.getByText('Pay the car loan: spreadsheet row delivery')).toBeInTheDocument();
    expect(panel.getByText('Task')).toBeInTheDocument();
    expect(panel.getByText('Delivery')).toBeInTheDocument();
    const items = await panel.findAllByTestId('connection-activity-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Sent an email');
    expect(items[1]).toHaveTextContent('Added a row after a run (failed)');
    expect(within(items[0]!).getByRole('link', { name: 'The run' })).toHaveAttribute('href', `/runs/${RUN}`);
    expect(within(items[1]!).queryByRole('link', { name: 'The run' })).toBeNull();
    // Only this account's rules, each linking to the rule, and the page of all of them.
    expect(await panel.findByRole('link', { name: 'Send mail with Work' })).toHaveAttribute('href', '/settings/approvals#rule-r1');
    expect(panel.queryByText("Press 'Pay' on shop.example.test")).toBeNull();
    expect(panel.getByRole('link', { name: 'Saved approvals' })).toHaveAttribute('href', '/settings/approvals');
  });

  it('shows no content: the activity holds an operation, a time and a run, nothing else', async () => {
    mount(['runs:read', 'connections:read'], { [`GET /connections/${ID}/activity`]: { items: [{ kind: 'tool', operation: 'mail_send', ok: true, at: '2026-11-18T18:00:00Z', runId: RUN, subject: 'SECRET-SUBJECT' }] } });
    fireEvent.click(screen.getByRole('button', { name: 'What it is used for' }));
    await screen.findByTestId('connection-activity-item');
    expect(document.body).not.toHaveTextContent('SECRET-SUBJECT');
  });

  it('says so when nothing uses the account, and hides the run link and the approvals without runs:read', async () => {
    mount(['connections:read'], { [`GET /connections/${ID}`]: { ...WORK, usedBy: [] } });
    fireEvent.click(screen.getByRole('button', { name: 'What it is used for' }));
    const panel = within(await screen.findByTestId(`connection-details-${ID}`));
    expect(await panel.findByText(/Nothing has used it yet/)).toBeInTheDocument();
    await panel.findAllByTestId('connection-activity-item');
    expect(panel.queryByRole('link', { name: 'The run' })).toBeNull();
    expect(panel.queryByText('Approvals you saved for it')).toBeNull();
  });

  it('names operations in words', () => {
    expect(operationWords('sheet_append_rows')).toBe('Added rows to a spreadsheet');
    expect(operationWords('something_new')).toBe('something new');
  });
});

describe('on the Connections page', () => {
  it('each account has the details button', async () => {
    const host = createTestPlatformHost({ permissions: ['connections:read', 'connections:write', 'runs:read'], responses: { 'GET /connections': [WORK], 'GET /connections/providers': [], ...responses } });
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <MemoryRouter>
            <ConnectionsPage />
          </MemoryRouter>
        </ConfirmProvider>
      </PlatformHostProvider>,
    );
    const row = await screen.findByRole('listitem', { name: 'Connection Work' });
    fireEvent.click(within(row).getByRole('button', { name: 'What it is used for' }));
    expect(await within(row).findByText('Used by')).toBeInTheDocument();
  });
});

describe('Saved approvals for an account', () => {
  it('names the account in the group, shows who the rule covers, and calls it an account rule', async () => {
    expect(categoryLabel(RULE)).toBe('Account');
    expect(limitsText(RULE)).toBe('to person-f@example.test');
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write', 'connections:read'], responses: { 'GET /approval-rules': { paused: false, rules: [RULE, SITE_RULE] }, 'GET /connections': [WORK], 'GET /tasks': [] } });
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <MemoryRouter>
            <SavedApprovalsPage />
          </MemoryRouter>
        </ConfirmProvider>
      </PlatformHostProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Work (account)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'shop.example.test' })).toBeInTheDocument();
  });
});

describe('Home needs you', () => {
  it('says so when an account must be connected again, and is silent otherwise', async () => {
    const { NeedsReconnectBlock } = await import('../connections/NeedsReconnectBlock');
    const run = (list: Connection[], permissions = ['connections:read']) => {
      const host = createTestPlatformHost({ permissions, responses: { 'GET /connections': list } });
      return render(
        <PlatformHostProvider host={host}>
          <MemoryRouter>
            <NeedsReconnectBlock />
          </MemoryRouter>
        </PlatformHostProvider>,
      );
    };
    const first = run([WORK, { ...WORK, id: 'b', label: 'Old', status: 'needs_reconnect', statusReason: 'GRANT_REVOKED' }]);
    const block = await screen.findByTestId('home-needs-reconnect');
    expect(block).toHaveTextContent('Old needs to be connected again.');
    expect(within(block).getByRole('link', { name: 'Reconnect' })).toHaveAttribute('href', '/settings/connections');
    first.unmount();
    const quiet = run([WORK]);
    await waitFor(() => expect(quiet.container).toBeEmptyDOMElement());
    quiet.unmount();
    const none = run([{ ...WORK, status: 'needs_reconnect' }], []);
    expect(none.container).toBeEmptyDOMElement();
  });
});
