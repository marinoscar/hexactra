// Saved approvals (#554): the page (grouping by site, the risky chip, limits,
// uses, the switch, Pause all and its banner, the limit dialog and its refusal
// to loosen, delete with confirm, the empty state, permissions), the pure
// helpers, and the "Allowed by a saved approval" link on a run step.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, createTestApiError, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { categoryLabel, groupBySite, limitPatch, limitsText, savedApprovalHref, toLimitDraft, usesText, type ApprovalRule } from '../approvals/types';
import { RunTimeline, approvalRuleOf, type RunTimelineStep } from '../components/RunTimeline';
import { SavedApprovalsPage } from '../pages/SavedApprovalsPage';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const PAY: ApprovalRule = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  kind: 'gate',
  host: 'bankofamerica.com',
  category: 'payment',
  matchKey: 'pay',
  summary: "Press 'Pay' on bankofamerica.com",
  taskId: null,
  taskName: null,
  conversationId: null,
  maxAmount: null,
  expiresAt: null,
  enabled: true,
  createdFromQuestionId: null,
  useCount: 4,
  lastUsedAt: '2026-11-16T10:00:00.000Z',
  lastUsedRunId: 'bbbbbbbb-2222-4222-8222-222222222222',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};
const DATES: ApprovalRule = { ...PAY, id: 'cccccccc-3333-4333-8333-333333333333', kind: 'ask', category: null, matchKey: 'choose_date', summary: 'Choose dates on bankofamerica.com', useCount: 0, lastUsedAt: null, lastUsedRunId: null };
const SHOP: ApprovalRule = { ...PAY, id: 'dddddddd-4444-4444-8444-444444444444', host: 'example.com', category: 'purchase', summary: "Press 'Buy now' on example.com", maxAmount: 50, taskId: 'eeeeeeee-5555-4555-8555-555555555555', taskName: 'Weekly groceries', useCount: 1 };

const WRITE = ['approvals:read', 'approvals:write', 'runs:read'];

function renderPage(responses: Record<string, unknown>, permissions = WRITE) {
  const host = createTestPlatformHost({ permissions, responses: { 'GET /tasks': [{ id: 'eeeeeeee-5555-4555-8555-555555555555', name: 'Weekly groceries' }], ...responses } });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/settings/approvals']}>
          <Routes>
            <Route path="/settings/approvals" element={<SavedApprovalsPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  cleanup();
});

describe('the helpers', () => {
  it('groups by site, alphabetically, keeping the order inside a site', () => {
    expect(groupBySite([SHOP, PAY, DATES]).map((g) => [g.host, g.rules.map((r) => r.id)])).toEqual([
      ['bankofamerica.com', [PAY.id, DATES.id]],
      ['example.com', [SHOP.id]],
    ]);
  });

  it('labels, limits and uses in words', () => {
    expect(categoryLabel(PAY)).toBe('Payment');
    expect(categoryLabel(DATES)).toBe('Question');
    expect(limitsText(PAY)).toBe('No limits');
    expect(limitsText({ ...SHOP, expiresAt: '2026-12-31T12:00:00.000Z' }, () => 'Dec 31, 2026')).toBe('up to $50.00 · only in the task Weekly groceries · until Dec 31, 2026');
    expect(limitsText({ ...PAY, conversationId: 'x' })).toBe('only in one chat');
    expect(usesText({ useCount: 0 })).toBe('Never used');
    expect(usesText({ useCount: 1 })).toBe('Used once');
    expect(usesText({ useCount: 4 })).toBe('Used 4 times');
    expect(savedApprovalHref(PAY.id)).toBe(`/settings/approvals#rule-${PAY.id}`);
  });

  it('limitPatch tightens and refuses to loosen', () => {
    expect(limitPatch(PAY, { ...toLimitDraft(PAY), maxAmount: '25' })).toEqual({ patch: { maxAmount: 25 } });
    expect(limitPatch(SHOP, { ...toLimitDraft(SHOP), maxAmount: '40' })).toEqual({ patch: { maxAmount: 40 } });
    expect(limitPatch(SHOP, { ...toLimitDraft(SHOP), maxAmount: '75' })).toMatchObject({ field: 'maxAmount', error: expect.stringMatching(/only go down/) });
    expect(limitPatch(SHOP, { ...toLimitDraft(SHOP), maxAmount: '' })).toMatchObject({ field: 'maxAmount' });
    expect(limitPatch(SHOP, { ...toLimitDraft(SHOP), taskId: '' })).toMatchObject({ field: 'taskId' });
    expect(limitPatch(SHOP, toLimitDraft(SHOP))).toEqual({ patch: {} });
    const dated = { ...PAY, expiresAt: '2026-12-31T23:59:59.000Z' };
    expect(limitPatch(dated, toLimitDraft(dated))).toEqual({ patch: {} });
    expect(limitPatch(dated, { ...toLimitDraft(dated), expiresOn: '2027-06-01' })).toMatchObject({ field: 'expiresOn' });
    expect(limitPatch(dated, { ...toLimitDraft(dated), expiresOn: '' })).toMatchObject({ field: 'expiresOn' });
    expect(limitPatch(PAY, { ...toLimitDraft(PAY), maxAmount: '-3' })).toMatchObject({ field: 'maxAmount' });
  });
});

describe('the Saved approvals page', () => {
  it('lists rules grouped by site: summary, category (risky in warning), limits, uses linking to the last run', async () => {
    restore = mockViewport(1440);
    renderPage({ 'GET /approval-rules': { paused: false, rules: [SHOP, PAY, DATES] } });
    expect(await screen.findByText(PAY.summary)).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['bankofamerica.com', 'example.com']);
    expect(screen.getByTestId(`category-${PAY.id}`)).toHaveTextContent('Payment');
    expect(screen.getByTestId(`category-${PAY.id}`).className).toMatch(/Warning/);
    expect(screen.getByTestId(`category-${DATES.id}`).className).not.toMatch(/Warning/);
    const shop = screen.getByTestId(`rule-${SHOP.id}`);
    expect(within(shop).getByText(/up to \$50\.00 · only in the task Weekly groceries/)).toBeInTheDocument();
    const pay = screen.getByTestId(`rule-${PAY.id}`);
    expect(within(pay).getByText(/Used 4 times/)).toBeInTheDocument();
    expect(within(pay).getByRole('link')).toHaveAttribute('href', `/runs/${PAY.lastUsedRunId}`);
    expect(within(screen.getByTestId(`rule-${DATES.id}`)).getByText('Never used')).toBeInTheDocument();
  });

  it('the switch turns one rule off with a patch of `enabled` only', async () => {
    restore = mockViewport(1440);
    const host = renderPage({ 'GET /approval-rules': { paused: false, rules: [PAY] }, [`PATCH /approval-rules/${PAY.id}`]: (r: TestApiRequest) => ({ ...PAY, ...(r.body as object) }) });
    fireEvent.click(await screen.findByRole('switch', { name: `Turn off: ${PAY.summary}` }));
    await waitFor(() => expect(screen.getByRole('switch', { name: `Turn on: ${PAY.summary}` })).not.toBeChecked());
    expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ path: `/approval-rules/${PAY.id}`, body: { enabled: false } });
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('Pause all: the switch in the header and the banner while paused', async () => {
    restore = mockViewport(1440);
    const host = renderPage({ 'GET /approval-rules': { paused: false, rules: [PAY] }, 'PUT /approval-rules/paused': (r: TestApiRequest) => r.body });
    expect(await screen.findByText(PAY.summary)).toBeInTheDocument();
    expect(screen.queryByTestId('paused-banner')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Pause all saved approvals' }));
    expect(await screen.findByTestId('paused-banner')).toHaveTextContent(/All saved approvals are paused/);
    expect(host.requests.find((r) => r.method === 'PUT')).toMatchObject({ path: '/approval-rules/paused', body: { paused: true } });
  });

  it('Add a limit: tightens with a patch, explains that limits cannot be loosened, and shows the refusal', async () => {
    restore = mockViewport(1440);
    const host = renderPage({ 'GET /approval-rules': { paused: false, rules: [SHOP] }, [`PATCH /approval-rules/${SHOP.id}`]: (r: TestApiRequest) => ({ ...SHOP, ...(r.body as object) }) });
    fireEvent.click(await screen.findByRole('button', { name: `More for ${SHOP.summary}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add a limit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a limit' });
    expect(within(dialog).getByText(/Limits can be tightened here, never loosened/)).toBeInTheDocument();
    const amount = within(dialog).getByLabelText('Up to an amount (USD)');
    fireEvent.change(amount, { target: { value: '80' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    expect(await within(dialog).findByText('The limit can only go down from $50.00.')).toBeInTheDocument();
    expect(host.requests.some((r) => r.method === 'PATCH')).toBe(false);
    fireEvent.change(amount, { target: { value: '30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ body: { maxAmount: 30 } });
    expect(screen.getByText(/up to \$30\.00/)).toBeInTheDocument();
  });

  it("shows the server's refusal when a limit would widen", async () => {
    restore = mockViewport(1440);
    renderPage({
      'GET /approval-rules': { paused: false, rules: [PAY] },
      [`PATCH /approval-rules/${PAY.id}`]: () => {
        throw createTestApiError(400, 'The amount limit cannot be removed.', 'RULE_CANNOT_WIDEN');
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: `More for ${PAY.summary}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add a limit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a limit' });
    fireEvent.change(within(dialog).getByLabelText('Up to an amount (USD)'), { target: { value: '10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    expect(await within(dialog).findByText('The amount limit cannot be removed.')).toBeInTheDocument();
  });

  it('Delete asks first, then removes the rule', async () => {
    restore = mockViewport(1440);
    const host = renderPage({ 'GET /approval-rules': { paused: false, rules: [PAY, DATES] }, [`DELETE /approval-rules/${PAY.id}`]: null });
    fireEvent.click(await screen.findByRole('button', { name: `More for ${PAY.summary}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const ask = await screen.findByRole('dialog', { name: 'Delete this saved approval?' });
    expect(within(ask).getByText(/ask you again/)).toBeInTheDocument();
    fireEvent.click(within(ask).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText(PAY.summary)).not.toBeInTheDocument());
    expect(host.requests.find((r) => r.method === 'DELETE')).toMatchObject({ path: `/approval-rules/${PAY.id}` });
    expect(screen.getByText(DATES.summary)).toBeInTheDocument();
  });

  it('the empty state says what a saved approval is and where it comes from', async () => {
    restore = mockViewport(390);
    renderPage({ 'GET /approval-rules': { paused: false, rules: [] } });
    expect(await screen.findByText('No saved approvals')).toBeInTheDocument();
    expect(screen.getByText(/tick “Don’t ask again” on the request/)).toBeInTheDocument();
  });

  it('without approvals:write: no switches, no menus, no Pause all', async () => {
    restore = mockViewport(1440);
    renderPage({ 'GET /approval-rules': { paused: true, rules: [PAY] } }, ['approvals:read']);
    expect(await screen.findByText(PAY.summary)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /More for/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('paused-banner')).toBeInTheDocument();
  });
});

describe('a run step allowed by a saved approval', () => {
  const step = (args: Record<string, unknown> | null): RunTimelineStep => ({ id: 's1', seq: 12, kind: 'action', action: 'click', ok: true, summary: 'Clicked Pay', durationMs: null, createdAt: '2026-11-18T10:00:00.000Z', args, reasoning: null }) as unknown as RunTimelineStep;

  it('reads the rule id from the step', () => {
    expect(approvalRuleOf(step({ approval: { ruleId: PAY.id } }))).toBe(PAY.id);
    expect(approvalRuleOf(step({ approval: 'yes' }))).toBeNull();
    expect(approvalRuleOf(step(null))).toBeNull();
  });

  it('links to the rule on the Saved approvals page', () => {
    render(
      <MemoryRouter>
        <RunTimeline steps={[step({ approval: { ruleId: PAY.id } })]} live={false} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('saved-approval-12')).toHaveAttribute('href', `/settings/approvals#rule-${PAY.id}`);
    expect(screen.getByTestId('saved-approval-12')).toHaveTextContent('Allowed by a saved approval');
  });
});
