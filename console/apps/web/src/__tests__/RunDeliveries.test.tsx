// "Deliveries" on the run page (E39.6, #603): what was sent when the run ended, the status of each, a fixed reason for a failure, and a
// Retry for one that failed. Nothing for a run without any; never an address, a subject or a file name.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { describe, expect, it, vi } from 'vitest';

import { RunDeliveries } from '../deliveries/RunDeliveries';
import { canRetry, detailLine, isMoving, kindLabel, statusLabel, type RunDelivery } from '../deliveries/model';

configure({ asyncUtilTimeout: 5_000 });

const RUN = '11111111-1111-4111-8111-111111111111';
const row = (over: Partial<RunDelivery> & Pick<RunDelivery, 'id' | 'kind' | 'status'>): RunDelivery => ({
  runId: RUN,
  deliveryId: '55555555-5555-4555-8555-555555555555',
  attempts: 1,
  errorCode: null,
  errorText: null,
  detail: {},
  sentAt: null,
  nextAttemptAt: null,
  createdAt: '2026-11-18T18:00:00.000Z',
  ...over,
});

function show(rows: RunDelivery[] | Error, permissions: string[] = ['runs:read', 'runs:write'], extra: Record<string, unknown> = {}) {
  const host = createTestPlatformHost({ permissions, responses: { ...(rows instanceof Error ? {} : { [`GET /runs/${RUN}/deliveries`]: rows }), ...extra } });
  render(
    <PlatformHostProvider host={host}>
      <RunDeliveries runId={RUN} canRetryDelivery={permissions.includes('runs:write')} pollMs={50} />
    </PlatformHostProvider>,
  );
  return host;
}

describe('the words of a delivery', () => {
  it('names the kind and the status, and says what a row did in fixed sentences', () => {
    expect(kindLabel('sheet_row')).toBe('Spreadsheet row');
    expect(statusLabel('sending')).toBe('Sending');
    expect(detailLine(row({ id: 'a', kind: 'email', status: 'sent', detail: { messages: 2 } }))).toBe('2 sent');
    expect(detailLine(row({ id: 'a', kind: 'email', status: 'sent', detail: { messages: 1, reportLink: true } }))).toMatch(/link to the report/);
    expect(detailLine(row({ id: 'a', kind: 'folder', status: 'sent', detail: { files: 3 } }))).toBe('3 files saved');
    expect(detailLine(row({ id: 'a', kind: 'sheet_row', status: 'sent', detail: { deduplicated: true } }))).toBe('The row was already there');
    expect(detailLine(row({ id: 'a', kind: 'webhook', status: 'sent', detail: { httpStatus: 200 } }))).toBe('Answered 200');
    expect(detailLine(row({ id: 'a', kind: 'sheet_row', status: 'failed', errorText: 'the connection needs reconnecting' }))).toBe('The connection needs reconnecting');
    expect(detailLine(row({ id: 'a', kind: 'webhook', status: 'pending', errorText: 'the provider asked to slow down' }))).toBe('The provider asked to slow down; trying again');
  });

  it('only a failed delivery can be retried, and a waiting or sending one is "moving"', () => {
    const rows = [row({ id: 'a', kind: 'email', status: 'failed' }), row({ id: 'b', kind: 'email', status: 'sent' }), row({ id: 'c', kind: 'email', status: 'pending' })];
    expect(rows.map(canRetry)).toEqual([true, false, false]);
    expect(isMoving(rows)).toBe(true);
    expect(isMoving(rows.slice(0, 2))).toBe(false);
  });
});

describe('Deliveries on the run page', () => {
  it('lists what was sent for the run, with a status for each', async () => {
    show([
      row({ id: 'a', kind: 'email', status: 'sent', detail: { messages: 1 } }),
      row({ id: 'b', kind: 'sheet_row', status: 'sent', detail: { rows: 1 } }),
      row({ id: 'c', kind: 'folder', status: 'sent', detail: { files: 2 } }),
      row({ id: 'd', kind: 'webhook', status: 'skipped', errorCode: 'RECIPIENT_UNSUBSCRIBED', errorText: 'every recipient stopped these emails' }),
    ]);
    const section = await screen.findByRole('region', { name: 'Deliveries' });
    const items = within(section).getAllByTestId('run-delivery');
    expect(items.map((i) => i.textContent)).toEqual(['EmailSent1 sent', 'Spreadsheet rowSentRow added', 'Files in a folderSent2 files saved', 'WebhookSkippedEvery recipient stopped these emails']);
    expect(within(section).queryByRole('alert')).toBeNull();
    expect(within(section).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says why a delivery failed and retries it for its owner, then shows the new state', async () => {
    const failed = row({ id: 'f1', kind: 'sheet_row', status: 'failed', attempts: 1, errorCode: 'CONNECTION_NEEDS_RECONNECT', errorText: 'the connection needs reconnecting' });
    const host = show([failed], ['runs:read', 'runs:write'], { [`POST /runs/${RUN}/deliveries/f1/retry`]: { ...failed, status: 'pending', errorCode: null, errorText: null } });
    const section = await screen.findByRole('region', { name: 'Deliveries' });
    expect(within(section).getByText(/One delivery could not be sent/)).toBeInTheDocument();
    expect(within(section).getByText('The connection needs reconnecting')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === `/runs/${RUN}/deliveries/f1/retry`)).toBe(true));
  });

  it('offers no Retry without the permission to start runs', async () => {
    show([row({ id: 'f1', kind: 'email', status: 'failed', errorText: 'the daily email limit was reached' })], ['runs:read']);
    const section = await screen.findByRole('region', { name: 'Deliveries' });
    expect(within(section).getByText('The daily email limit was reached')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows nothing for a run without deliveries, or when the API has none to give', async () => {
    const empty = show([]);
    await waitFor(() => expect(empty.requests.some((r) => r.path === `/runs/${RUN}/deliveries`)).toBe(true));
    expect(screen.queryByRole('region', { name: 'Deliveries' })).toBeNull();
  });

  it('looks again while a delivery is still moving, and stops when all are done', async () => {
    const host = show([row({ id: 'p', kind: 'email', status: 'pending', attempts: 1, errorText: 'the provider asked to slow down' })]);
    const reads = () => host.requests.filter((r) => r.method === 'GET' && r.path === `/runs/${RUN}/deliveries`).length;
    await screen.findByText('The provider asked to slow down; trying again');
    await waitFor(() => expect(reads()).toBeGreaterThan(2));
  });

  it('renders every value as text', async () => {
    show([row({ id: 'x', kind: 'email', status: 'failed', errorText: '<img src=x onerror=alert(1)>' })]);
    const section = await screen.findByRole('region', { name: 'Deliveries' });
    expect(section.querySelector('img')).toBeNull();
    expect(section).toHaveTextContent('<img src=x onerror=alert(1)>');
  });
});
