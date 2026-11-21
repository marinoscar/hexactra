// The browser agent's settings pages (#407): the user's Model tiers, and the
// administrator's deployment tiers, budget ceilings and model prices (each a
// namespace of the platform's system settings document).
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import type { ReactElement } from 'react';

import { AgentCeilingsPage } from '../pages/AgentCeilingsPage';
import { AgentPricingPage } from '../pages/AgentPricingPage';
import { ModelTiersPage } from '../pages/ModelTiersPage';
import { AI_MODELS, EFFECTIVE } from './policyFixtures';

// Full pages with MUI pickers: slow under a loaded parallel run, never hanging.
vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

function renderPage(page: ReactElement, permissions: string[], responses: Record<string, unknown>) {
  const host = createTestPlatformHost({ permissions, responses: { 'GET /ai/models': AI_MODELS, ...responses } });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter>{page}</MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}

const patchOf = (host: { requests: TestApiRequest[] }) => host.requests.find((r) => r.method === 'PATCH');
const NONE = { model: null, reasoningEffort: null, maxOutputTokens: null, fallbackModel: null };

describe('Model tiers (user)', () => {
  it('inherits the deployment by default, shows the effective model, and saves an override', async () => {
    const host = renderPage(<ModelTiersPage scope="user" />, ['agent_policies:read', 'user_settings:write'], {
      'GET /user-settings': { version: 7, theme: 'system', profile: {}, browserAgent: { defaultPolicyRef: null, tiers: { frontier: { model: 'provider-a:model-big', reasoningEffort: 'high' } } } },
      'GET /agent-policies/model-tiers/effective': { policy: { id: 'builtin:balanced', name: 'Balanced', startTier: 'standard', maxTier: 'frontier' }, tiers: EFFECTIVE },
      'PATCH /user-settings': (r: TestApiRequest) => ({ version: 8, browserAgent: r.body && (r.body as { browserAgent: object }).browserAgent }),
    });
    const standard = await screen.findByLabelText('Standard tier');
    expect(within(standard).getByRole('switch', { name: 'Inherit from deployment' })).toBeChecked();
    await waitFor(() => expect(within(standard).getByTestId('effective-standard')).toHaveTextContent('Now: Model Std (the deployment default)'));
    const frontier = screen.getByLabelText('Frontier tier');
    expect(within(frontier).getByRole('switch', { name: 'Inherit from deployment' })).not.toBeChecked();
    expect(screen.getByText(/same model for Standard and Frontier with a different reasoning effort/)).toBeInTheDocument();

    // Override Standard: same model as Frontier, low effort.
    fireEvent.click(within(standard).getByRole('switch', { name: 'Inherit from deployment' }));
    fireEvent.change(within(standard).getByRole('combobox', { name: 'Model' }), { target: { value: 'provider-a:model-big' } });
    fireEvent.mouseDown(within(standard).getByRole('combobox', { name: 'Reasoning effort' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Low' }));
    fireEvent.change(within(standard).getByLabelText('Max output tokens'), { target: { value: '4096' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }));
    await screen.findByText(/Saved\. New runs use these tiers/);
    const patch = patchOf(host)!;
    expect(patch.path).toBe('/user-settings');
    expect(patch.ifMatch).toBe('7');
    expect(patch.body).toEqual({
      browserAgent: {
        tiers: {
          fast: NONE,
          standard: { model: 'provider-a:model-big', reasoningEffort: 'low', maxOutputTokens: 4096, fallbackModel: null },
          frontier: { model: 'provider-a:model-big', reasoningEffort: 'high', maxOutputTokens: null, fallbackModel: null },
        },
      },
    });
  });

  it('offers only models with tool calls and labels those without vision', async () => {
    renderPage(<ModelTiersPage scope="user" />, ['agent_policies:read', 'user_settings:write'], {
      'GET /user-settings': { version: 1, browserAgent: { tiers: { fast: { model: null } } } },
      'GET /agent-policies/model-tiers/effective': { policy: { id: 'builtin:balanced', name: 'Balanced', startTier: 'standard', maxTier: 'frontier' }, tiers: EFFECTIVE },
    });
    const fast = await screen.findByLabelText('Fast tier');
    await waitFor(() => expect(within(fast).getByRole('switch', { name: 'Inherit from deployment' })).not.toBeChecked());
    fireEvent.mouseDown(within(fast).getByRole('combobox', { name: 'Model' }));
    const list = await screen.findByRole('listbox');
    expect(within(list).getByText('Model Std')).toBeInTheDocument();
    expect(within(list).getByText('Model Text')).toBeInTheDocument();
    expect(within(list).getByText('no vision')).toBeInTheDocument();
    expect(within(list).queryByText('Model Chat')).not.toBeInTheDocument();
  });
});

describe('Agent model tiers (deployment)', () => {
  it('saves the browserAgentTiers namespace with the document version', async () => {
    const host = renderPage(<ModelTiersPage scope="deployment" />, ['system_settings:read', 'system_settings:write'], {
      'GET /system-settings': { version: 12, browserAgentTiers: { fast: NONE, standard: { ...NONE, model: 'provider-a:model-std' }, frontier: NONE } },
      'PATCH /system-settings': { version: 13 },
    });
    const frontier = await screen.findByLabelText('Frontier tier');
    expect(screen.queryByRole('switch', { name: 'Inherit from deployment' })).not.toBeInTheDocument();
    fireEvent.change(within(frontier).getByRole('combobox', { name: 'Model' }), { target: { value: 'provider-a:model-std' } });
    fireEvent.mouseDown(within(frontier).getByRole('combobox', { name: 'Reasoning effort' }));
    fireEvent.click(await screen.findByRole('option', { name: 'High' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save tiers' }));
    await screen.findByText(/Saved\./);
    const patch = patchOf(host)!;
    expect(patch.ifMatch).toBe('12');
    expect(patch.body).toEqual({
      browserAgentTiers: {
        fast: NONE,
        standard: { ...NONE, model: 'provider-a:model-std' },
        frontier: { ...NONE, model: 'provider-a:model-std', reasoningEffort: 'high' },
      },
    });
  });

  it('is read-only without system_settings:write', async () => {
    renderPage(<ModelTiersPage scope="deployment" />, ['system_settings:read'], { 'GET /system-settings': { version: 1 } });
    await screen.findByLabelText('Fast tier');
    expect(screen.queryByRole('button', { name: 'Save tiers' })).not.toBeInTheDocument();
  });
});

describe('Agent budget ceilings', () => {
  it('saves ceilings, null for "No ceiling"', async () => {
    const host = renderPage(<AgentCeilingsPage />, ['system_settings:read', 'system_settings:write'], {
      'GET /system-settings': { version: 3, browserAgentCeilings: { maxActions: 300, maxModelCalls: null, maxActiveMinutes: null, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: null } },
      'PATCH /system-settings': { version: 4 },
    });
    expect(await screen.findByLabelText('Browser actions')).toHaveValue(300);
    fireEvent.click(screen.getByRole('switch', { name: 'No ceiling: Cost (US$)' }));
    fireEvent.change(screen.getByLabelText('Cost (US$)'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('switch', { name: 'No ceiling: Browser actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save ceilings' }));
    await screen.findByText(/Saved\./);
    const patch = patchOf(host)!;
    expect(patch.ifMatch).toBe('3');
    expect(patch.body).toEqual({ browserAgentCeilings: { maxActions: null, maxModelCalls: null, maxActiveMinutes: null, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: 25 } });
  });

  it('says so when the settings changed elsewhere (409)', async () => {
    renderPage(<AgentCeilingsPage />, ['system_settings:read', 'system_settings:write'], {
      'GET /system-settings': { version: 3 },
      'PATCH /system-settings': () => {
        throw createTestApiError(409, 'Version conflict');
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Save ceilings' }));
    expect(await screen.findByText(/changed elsewhere; reload the page/)).toBeInTheDocument();
  });
});

describe('Model prices', () => {
  it('lists, adds and saves model prices', async () => {
    const host = renderPage(<AgentPricingPage />, ['system_settings:read', 'system_settings:write'], {
      'GET /system-settings': { version: 5, agentPricing: { currency: 'USD', models: { 'provider-a:model-std': { inputPerMTok: 1, outputPerMTok: 4 } } } },
      'PATCH /system-settings': { version: 6 },
    });
    const first = await screen.findByLabelText('Price provider-a:model-std');
    expect(within(first).getByLabelText('Input $/M')).toHaveValue(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add a model' }));
    const added = screen.getByLabelText('Price 2');
    // A bad key is refused before saving.
    fireEvent.change(within(added).getByRole('combobox', { name: 'Model' }), { target: { value: 'no-colon' } });
    expect(within(added).getByText(/provider:modelId/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save prices' })).toBeDisabled();
    fireEvent.change(within(added).getByRole('combobox', { name: 'Model' }), { target: { value: 'provider-a:model-big' } });
    const row = screen.getByLabelText('Price provider-a:model-big');
    fireEvent.change(within(row).getByLabelText('Input $/M'), { target: { value: '5' } });
    fireEvent.change(within(row).getByLabelText('Output $/M'), { target: { value: '20' } });
    fireEvent.change(within(row).getByLabelText('Cached $/M'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    await screen.findByText(/Saved\./);
    expect(patchOf(host)!.body).toEqual({
      agentPricing: {
        models: {
          'provider-a:model-std': { inputPerMTok: 1, outputPerMTok: 4 },
          'provider-a:model-big': { inputPerMTok: 5, outputPerMTok: 20, cachedInputPerMTok: 0.5 },
        },
      },
    });
    expect(patchOf(host)!.ifMatch).toBe('5');
  });
});

describe('My model prices (#735)', () => {
  it("loads and saves the user's own prices in /user-settings, and clears them with null", async () => {
    const host = renderPage(<AgentPricingPage scope="user" />, ['user_settings:read', 'user_settings:write'], {
      'GET /user-settings': { version: 3, agentPricing: { currency: 'USD', models: { 'provider-a:model-big': { inputPerMTok: 1, outputPerMTok: 4 } } } },
      'PATCH /user-settings': (r: TestApiRequest) => ({ version: 4, ...(r.body as object) }),
    });
    expect(await screen.findByRole('heading', { name: 'My model prices' })).toBeInTheDocument();
    expect(screen.getByText(/replaces the deployment’s price of the same model for your runs/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    await screen.findByText(/Your usage report uses them now/);
    const first = host.requests.find((r) => r.method === 'PATCH')!;
    expect(first.path).toBe('/user-settings');
    expect(first.ifMatch).toBe('3');
    expect(first.body).toEqual({ agentPricing: { models: { 'provider-a:model-big': { inputPerMTok: 1, outputPerMTok: 4 } } } });

    fireEvent.click(screen.getByRole('button', { name: 'Remove provider-a:model-big' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    await waitFor(() => expect(host.requests.filter((r) => r.method === 'PATCH')).toHaveLength(2));
    expect(host.requests.filter((r) => r.method === 'PATCH')[1]!.body).toEqual({ agentPricing: null });
  });
});
