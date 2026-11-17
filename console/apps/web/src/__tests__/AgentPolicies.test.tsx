// The Agent policies page and the policy editor (#407), against canned API
// answers (createTestPlatformHost: the platform's test transport, the app's
// convention for page tests).
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestBlobResponse, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { afterEach, vi } from 'vitest';

import { AgentPoliciesPage } from '../pages/AgentPoliciesPage';
import { AgentPolicyEditorPage } from '../pages/AgentPolicyEditorPage';
import type { AgentPolicy, AgentPolicySpec } from '../policies/types';
import { BALANCED, OWN, OWN_ID, POLICY_READS, UNLIMITED } from './policyFixtures';
import { ConfirmProvider } from '../ui';

// Full pages with MUI pickers: slow under a loaded parallel run, never hanging.
vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const READ = ['agent_policies:read'];
const WRITE = ['agent_policies:read', 'agent_policies:write'];

function renderAt(path: string, host: ReturnType<typeof createTestPlatformHost>) {
  return render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/settings/agent-policies" element={<AgentPoliciesPage />} />
            <Route path="/settings/agent-policies/new" element={<AgentPolicyEditorPage />} />
            <Route path="/settings/agent-policies/:id" element={<AgentPolicyEditorPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
}

const lastRequest = (host: { requests: TestApiRequest[] }, method: string, path?: string) =>
  [...host.requests].reverse().find((r) => r.method === method && (path === undefined || r.path === path));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentPoliciesPage', () => {
  it('lists the built-ins as locked, with the default badge, tiers, budget, usage and version', async () => {
    renderAt('/settings/agent-policies', createTestPlatformHost({ permissions: READ, responses: POLICY_READS }));
    const balanced = await screen.findByRole('listitem', { name: 'Policy Balanced' });
    expect(within(balanced).getByRole('img', { name: 'Built-in (read-only)' })).toBeInTheDocument();
    expect(within(balanced).getByText('Default')).toBeInTheDocument();
    expect(within(balanced).getByText('Standard → Frontier')).toBeInTheDocument();
    expect(within(balanced).getByText('60 actions · $2 · 20 min')).toBeInTheDocument();
    expect(within(balanced).getByText('Used by 2 tasks, 1 schedule')).toBeInTheDocument();
    expect(within(balanced).getByText('v1')).toBeInTheDocument();
    // A built-in can be viewed and duplicated, never edited in place.
    expect(within(balanced).getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Policy Unlimited' })).getByText('Unlimited', { selector: '.MuiChip-label' })).toBeInTheDocument();
    const own = screen.getByRole('listitem', { name: 'Policy Careful shopping' });
    expect(within(own).queryByRole('img', { name: 'Built-in (read-only)' })).not.toBeInTheDocument();
    // A reader gets no write controls.
    expect(screen.queryByRole('button', { name: 'New policy' })).not.toBeInTheDocument();
    expect(within(own).queryByRole('button', { name: 'Duplicate' })).not.toBeInTheDocument();
  });

  it('duplicates a built-in, edits the copy and saves it with If-Match', async () => {
    const COPY_ID = '77777777-7777-4777-8777-777777777777';
    const copy: AgentPolicy = { ...BALANCED, id: COPY_ID, name: 'Balanced (copy)', builtin: false, isDefault: false, usage: { tasks: 0, schedules: 0 }, version: 1 };
    const host = createTestPlatformHost({
      permissions: WRITE,
      responses: {
        ...POLICY_READS,
        'POST /agent-policies/builtin:balanced/duplicate': copy,
        [`GET /agent-policies/${COPY_ID}`]: copy,
        [`PATCH /agent-policies/${COPY_ID}`]: (r: TestApiRequest) => ({ ...copy, ...(r.body as object), version: 2 }),
      },
    });
    renderAt('/settings/agent-policies', host);
    const balanced = await screen.findByRole('listitem', { name: 'Policy Balanced' });
    fireEvent.click(within(balanced).getByRole('button', { name: 'Duplicate' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Name of the copy')).toHaveValue('Balanced (copy)');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Duplicate and edit' }));
    expect(lastRequest(host, 'POST')?.body).toEqual({ name: 'Balanced (copy)' });

    // The editor opens on the copy.
    const name = await screen.findByLabelText(/^Name( \*)?$/);
    expect(name).toHaveValue('Balanced (copy)');
    fireEvent.change(name, { target: { value: 'Shopping' } });
    fireEvent.change(screen.getByLabelText('Browser actions'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved\. New runs use this version/);
    const patch = lastRequest(host, 'PATCH');
    expect(patch?.ifMatch).toBe('1');
    expect(patch?.body).toMatchObject({ name: 'Shopping', spec: { budget: { maxActions: 90, maxCostUsd: 2 }, models: { startTier: 'standard', maxTier: 'frontier' } } });
  });

  it('deletes a policy in use through the reassign dialog (409 POLICY_IN_USE)', async () => {
    const host = createTestPlatformHost({
      permissions: WRITE,
      responses: {
        ...POLICY_READS,
        [`DELETE /agent-policies/${OWN_ID}`]: (r: TestApiRequest) => {
          if (r.path.includes('reassignTo=')) return undefined;
          throw createTestApiError(409, 'The policy is used by 1 task(s) and 0 schedule(s)', 'POLICY_IN_USE', {
            tasks: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Weekly order' }],
            schedules: [],
          });
        },
      },
    });
    renderAt('/settings/agent-policies', host);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Careful shopping' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    const reassign = await screen.findByRole('dialog', { name: '“Careful shopping” is in use' });
    expect(within(reassign).getByText('Weekly order')).toBeInTheDocument();
    // The default policy is offered first.
    expect(within(reassign).getByRole('combobox', { name: 'Replacement policy' })).toHaveTextContent('Balanced');
    fireEvent.click(within(reassign).getByRole('button', { name: 'Move and delete' }));
    await screen.findByText('Deleted "Careful shopping".');
    expect(lastRequest(host, 'DELETE')?.path).toBe(`/agent-policies/${OWN_ID}?reassignTo=builtin%3Abalanced`);
  });

  it('sets the default policy', async () => {
    const host = createTestPlatformHost({ permissions: WRITE, responses: { ...POLICY_READS, 'PUT /agent-policies/default': { policyId: OWN_ID, explicit: true } } });
    renderAt('/settings/agent-policies', host);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Careful shopping' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Set as default' }));
    await screen.findByText('"Careful shopping" is now your default policy.');
    expect(lastRequest(host, 'PUT')?.body).toEqual({ policyId: OWN_ID });
  });

  it('imports a file and shows what was created, skipped and warned about', async () => {
    const host = createTestPlatformHost({
      permissions: WRITE,
      responses: {
        ...POLICY_READS,
        'POST /agent-policies/import': {
          created: [{ index: 0, id: OWN_ID, name: 'Careful shopping (2)', renamedFrom: 'Careful shopping' }],
          replaced: [],
          skipped: [{ index: 1, name: 'Quick look', reason: 'name_taken' }],
          warnings: [{ index: 0, name: 'Careful shopping', code: 'PIN_DROPPED', message: 'The frontier pin "provider-z:gone" is not enabled here and was dropped' }],
          errors: [],
        },
      },
    });
    renderAt('/settings/agent-policies', host);
    await screen.findByRole('listitem', { name: 'Policy Balanced' });
    const file = { kind: 'hexactra.agent-policies', formatVersion: 1, exportedAt: '2026-11-17T12:00:00Z', policies: [{ name: 'Careful shopping', description: null, spec: OWN.spec }, { name: 'Quick look', description: null, spec: OWN.spec }] };
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [new File([JSON.stringify(file)], 'policies.json', { type: 'application/json' })] } });
    const dialog = await screen.findByRole('dialog', { name: 'Import policies.json' });
    expect(within(dialog).getByText(/2 policies: Careful shopping, Quick look/)).toBeInTheDocument();
    fireEvent.mouseDown(within(dialog).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Skip it: keep mine' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    const done = await screen.findByRole('dialog', { name: 'Import finished' });
    expect(lastRequest(host, 'POST', '/agent-policies/import')?.body).toEqual({ file, onConflict: 'skip' });
    expect(within(done).getByText('Careful shopping (2) (renamed from Careful shopping)')).toBeInTheDocument();
    expect(within(done).getByText('Skipped: 1')).toBeInTheDocument();
    expect(within(done).getByText(/provider-z:gone" is not enabled here and was dropped/)).toBeInTheDocument();
  });

  it('refuses a file that is not a policy file before calling the API', async () => {
    const host = createTestPlatformHost({ permissions: WRITE, responses: POLICY_READS });
    renderAt('/settings/agent-policies', host);
    await screen.findByRole('listitem', { name: 'Policy Balanced' });
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [new File(['not json'], 'notes.txt')] } });
    expect(await screen.findByText(/notes.txt is not an agent policy file/)).toBeInTheDocument();
    expect(host.requests.some((r) => r.path === '/agent-policies/import')).toBe(false);
  });

  it('exports all policies as a downloaded file, without pins when asked', async () => {
    const createObjectURL = vi.fn(() => 'blob:policies');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const host = createTestPlatformHost({
      permissions: READ,
      responses: {
        ...POLICY_READS,
        'GET /agent-policies/export?ids=all&includePins=false': createTestBlobResponse('{"kind":"hexactra.agent-policies"}', {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="agent-policies-20261117.json"',
        }),
      },
    });
    renderAt('/settings/agent-policies', host);
    await screen.findByRole('listitem', { name: 'Policy Balanced' });
    fireEvent.click(screen.getByLabelText('Include model pins'));
    fireEvent.click(screen.getByRole('button', { name: 'Export all' }));
    await waitFor(() => expect(downloads).toEqual(['agent-policies-20261117.json']));
    expect(createObjectURL).toHaveBeenCalled();
  });
});

describe('AgentPolicyEditorPage', () => {
  const ownHost = (extra: Record<string, unknown> = {}, permissions = WRITE) =>
    createTestPlatformHost({
      permissions,
      responses: { ...POLICY_READS, [`GET /agent-policies/${OWN_ID}`]: OWN, [`PATCH /agent-policies/${OWN_ID}`]: { ...OWN, version: 4 }, ...extra },
    });

  it('sends null for a budget whose "No limit" switch is on, and disables its field', async () => {
    const host = ownHost();
    renderAt(`/settings/agent-policies/${OWN_ID}`, host);
    const actions = await screen.findByLabelText('Browser actions');
    expect(actions).toHaveValue(120);
    fireEvent.click(screen.getByRole('switch', { name: 'No limit: Browser actions' }));
    expect(screen.getByLabelText('Browser actions')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved\./);
    const body = lastRequest(host, 'PATCH')!.body as { spec: AgentPolicySpec };
    expect(body.spec.budget.maxActions).toBeNull();
    expect(body.spec.budget.maxCostUsd).toBe(4);
    // The pin is kept.
    expect(body.spec.models.pins).toEqual({ frontier: 'provider-a:model-big' });
  });

  it('warns while every budget is unlimited, and still saves', async () => {
    const host = ownHost();
    renderAt(`/settings/agent-policies/${OWN_ID}`, host);
    await screen.findByLabelText('Browser actions');
    const warning = 'Nothing will stop this run except finishing, Stop, or stall detection.';
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    for (const label of ['Browser actions', 'Model calls', 'Active minutes', 'Input tokens', 'Output tokens', 'Cost (US$)']) {
      const toggle = screen.getByRole('switch', { name: `No limit: ${label}` });
      if (!(toggle as HTMLInputElement).checked) fireEvent.click(toggle);
    }
    expect(screen.getByText(warning)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved\./);
    const body = lastRequest(host, 'PATCH')!.body as { spec: AgentPolicySpec };
    expect(Object.values({ ...body.spec.budget, warnAtPercent: null }).every((v) => v === null)).toBe(true);
  });

  it('turning "No limit" off again restores a value', async () => {
    renderAt(`/settings/agent-policies/${OWN_ID}`, ownHost());
    await screen.findByLabelText('Browser actions');
    const tokens = screen.getByRole('switch', { name: 'No limit: Input tokens' });
    expect(tokens).toBeChecked();
    fireEvent.click(tokens);
    expect(screen.getByLabelText('Input tokens')).toBeEnabled();
    expect(screen.getByLabelText('Input tokens')).toHaveValue(2000000);
  });

  it('shows "This policy changed elsewhere; reload" on a 412', async () => {
    const host = ownHost({
      [`PATCH /agent-policies/${OWN_ID}`]: () => {
        throw createTestApiError(412, 'The policy changed since you loaded it', 'POLICY_VERSION_CONFLICT', { version: 5 });
      },
    });
    renderAt(`/settings/agent-policies/${OWN_ID}`, host);
    fireEvent.change(await screen.findByLabelText(/^Name( \*)?$/), { target: { value: 'Careful shopping v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/This policy changed elsewhere; reload/)).toBeInTheDocument();
    expect(lastRequest(host, 'PATCH')?.ifMatch).toBe('3');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByLabelText(/^Name( \*)?$/)).toHaveValue('Careful shopping'));
  });

  it('shows a built-in read-only with its all-unlimited warning, and offers to duplicate it', async () => {
    renderAt('/settings/agent-policies/builtin:unlimited', createTestPlatformHost({ permissions: WRITE, responses: { ...POLICY_READS, 'GET /agent-policies/builtin:unlimited': UNLIMITED } }));
    expect(await screen.findByText('Built-in policies are read-only. Duplicate one to edit a copy.')).toBeInTheDocument();
    expect(screen.getByText('Nothing will stop this run except finishing, Stop, or stall detection.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name( \*)?$/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Duplicate to edit' })).toBeInTheDocument();
  });

  it('creates a policy from a built-in template', async () => {
    const created = { ...OWN, id: '88888888-8888-4888-8888-888888888888', name: 'Night runs' };
    const host = createTestPlatformHost({
      permissions: WRITE,
      responses: { ...POLICY_READS, 'GET /agent-policies/builtin:balanced': BALANCED, 'POST /agent-policies': created, [`GET /agent-policies/${created.id}`]: created },
    });
    renderAt('/settings/agent-policies/new?from=builtin:balanced', host);
    fireEvent.change(await screen.findByLabelText(/^Name( \*)?$/), { target: { value: 'Night runs' } });
    // Start on Fast; Max stays at Frontier.
    fireEvent.click(within(screen.getByRole('group', { name: 'Start tier' })).getByRole('button', { name: 'Fast' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create policy' }));
    await waitFor(() => expect(lastRequest(host, 'POST', '/agent-policies')).toBeDefined());
    expect(lastRequest(host, 'POST', '/agent-policies')?.body).toMatchObject({ name: 'Night runs', spec: { schemaVersion: 1, models: { startTier: 'fast', maxTier: 'frontier' }, budget: { maxActions: 60 } } });
    expect(await screen.findByRole('heading', { name: 'Night runs' })).toBeInTheDocument();
  });

  it('refuses an out-of-range value before saving', async () => {
    const host = ownHost();
    renderAt(`/settings/agent-policies/${OWN_ID}`, host);
    fireEvent.change(await screen.findByLabelText('Warn at (%)'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('From 10 to 95')).toBeInTheDocument();
    expect(lastRequest(host, 'PATCH')).toBeUndefined();
  });

  it('shows each tier\'s effective model and where it comes from (a pin wins)', async () => {
    renderAt(`/settings/agent-policies/${OWN_ID}`, ownHost());
    await waitFor(() => expect(screen.getByTestId('effective-standard')).toHaveTextContent('Model Std · the deployment default'));
    expect(screen.getByTestId('effective-fast')).toHaveTextContent('Model Std · borrowed from Standard');
    expect(screen.getByTestId('effective-frontier')).toHaveTextContent('Model Big · pinned by the policy');
  });

  it('shows the administrator\'s ceiling under a budget it caps', async () => {
    const host = ownHost(
      {
        'GET /system-settings': { version: 1, browserAgentCeilings: { maxActions: 100, maxModelCalls: null, maxActiveMinutes: null, maxInputTokens: 5000000, maxOutputTokens: null, maxCostUsd: null } },
      },
      [...WRITE, 'system_settings:read'],
    );
    renderAt(`/settings/agent-policies/${OWN_ID}`, host);
    expect(await screen.findByText('Capped at 100 actions by your administrator: runs get 100 actions.')).toBeInTheDocument();
    expect(screen.getByText('Capped at 5M input tokens by your administrator: runs get 5M input tokens.')).toBeInTheDocument();
  });

  it('keeps every "No limit" switch reachable for a reader-turned-writer and hides them from nobody', async () => {
    renderAt(`/settings/agent-policies/${OWN_ID}`, ownHost({}, READ));
    await screen.findByLabelText('Browser actions');
    // A reader sees the same six switches, disabled.
    const switches = screen.getAllByRole('switch', { name: /^No limit:/ });
    expect(switches).toHaveLength(6);
    for (const s of switches) expect(s).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
