// #1031: the edit page shows the task's Knowledge Graph control first, above the form (it saves on its own). The form itself is
// stubbed: its own tests are TaskForm.test.tsx.
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../components/TaskForm', () => ({ TaskForm: () => <form data-testid="task-form" />, taskPath: (id: string) => `/tasks/${id}` }));
vi.mock('../taskForm/values', () => ({ valuesFromTask: () => ({}) }));

import { TaskEditPage } from '../pages/TaskEditPage';
import { taskRow, TASK_ID } from './taskFixtures';

describe('the task edit page (#1031)', () => {
  it('renders the Knowledge Graph control above the form, with what the next run does', async () => {
    const host = createTestPlatformHost({
      permissions: ['tasks:read', 'tasks:write', 'kgraph:read', 'kgraph:write'],
      responses: {
        [`GET /tasks/${TASK_ID}`]: taskRow(),
        'GET /kgraph/status': { deployment: true, user: true, available: true, everyday: false, autoApproveFacts: false },
        [`GET /tasks/${TASK_ID}/kgraph`]: { taskId: TASK_ID, mode: 'learn', available: true },
      },
    });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter initialEntries={[`/tasks/${TASK_ID}/edit`]}>
          <Routes>
            <Route path="/tasks/:id/edit" element={<TaskEditPage />} />
          </Routes>
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    const control = await screen.findByTestId('task-kgraph');
    const form = await screen.findByTestId('task-form');
    expect(control.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('task-kgraph-chip')).toHaveTextContent('Learning');
    expect(screen.getByRole('radio', { name: 'Learn only (default)' })).toBeChecked();
  });
});
