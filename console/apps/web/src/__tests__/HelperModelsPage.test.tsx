// Helper models (E55.1, #1094): the title model and the task model of the user's `aiHelpers` settings.
import { configure, fireEvent, render, screen, within } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';

import { HelperModelsPage } from '../pages/HelperModelsPage';
import { mockViewport } from './matchMedia';
import { AI_MODELS } from './policyFixtures';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

function renderPage(permissions: string[], aiHelpers?: Record<string, unknown>) {
  const host = createTestPlatformHost({
    permissions,
    responses: {
      'GET /ai/models': AI_MODELS,
      'GET /user-settings': { version: 3, theme: 'system', profile: {}, ...(aiHelpers ? { aiHelpers } : {}) },
      'PATCH /user-settings': (r: TestApiRequest) => ({ version: 4, aiHelpers: (r.body as { aiHelpers: object }).aiHelpers }),
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter>
        <HelperModelsPage />
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}
const options = async () => (await screen.findAllByRole('option')).map((o) => o.textContent);

describe('Helper models', () => {
  beforeEach(() => mockViewport(390));

  it('starts on the default model with both title switches on, and saves the picks with the document version', async () => {
    const host = renderPage(['user_settings:read', 'user_settings:write']);
    const titles = await screen.findByLabelText('Titles');
    const tasks = screen.getByLabelText('Task creation');
    expect(within(titles).getByRole('combobox', { name: 'Title model' })).toHaveValue('');
    expect(within(titles).getByRole('switch', { name: 'Write a short title for each run' })).toBeChecked();
    expect(within(titles).getByRole('switch', { name: 'Write a short title for each chat' })).toBeChecked();
    expect(within(tasks).getByText(/Build with AI, by the chat when it drafts a task, and by Improve this task/)).toBeInTheDocument();

    fireEvent.change(within(titles).getByRole('combobox', { name: 'Title model' }), { target: { value: 'provider-b:model-chat' } });
    fireEvent.change(within(tasks).getByRole('combobox', { name: 'Task model' }), { target: { value: 'provider-a:model-big' } });
    fireEvent.click(within(titles).getByRole('switch', { name: 'Write a short title for each chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved\. The next title and the next task use these models/);
    const patch = host.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.path).toBe('/user-settings');
    expect(patch.ifMatch).toBe('3');
    expect(patch.body).toEqual({ aiHelpers: { titleModel: 'provider-b:model-chat', taskModel: 'provider-a:model-big', runTitles: true, chatTitles: false } });
  });

  it('offers every model for titles, and only models with tool calls for tasks', async () => {
    renderPage(['user_settings:read', 'user_settings:write']);
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'Title model' }));
    expect((await options()).join(' | ')).toContain('Model Chat');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Title model' }), { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Task model' }));
    const forTasks = (await options()).join(' | ');
    expect(forTasks).toContain('Model Text');
    expect(forTasks).not.toContain('Model Chat');
  });

  it('refuses a model that is not provider:model, and says when a saved model can no longer be used', async () => {
    renderPage(['user_settings:read', 'user_settings:write'], { titleModel: 'provider-gone:model-old', taskModel: null, runTitles: true, chatTitles: true });
    expect(await screen.findByText(/can no longer be used\. Your default model is used/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Task model' }), { target: { value: 'just-a-name' } });
    expect(screen.getByText(/type provider:model/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('is read-only without user_settings:write', async () => {
    renderPage(['user_settings:read']);
    expect(await screen.findByRole('combobox', { name: 'Title model' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Write a short title for each run' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
