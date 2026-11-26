// "This could have used your account" (E41.5, reworded by E50.17): the line under a finished run, on the chat's result card and the run page.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { SuggestedConnections } from '../components/SuggestedConnections';

const item = (scope: 'task' | 'chat') => ({ connectionId: 'c1', label: 'Marin', provider: 'google', site: 'Google Mail', scope, fix: 'resume' as const, text: 'This used the browser for Google Mail. "Marin" is paused: resume it in Connections and tools to do this without the browser.' });

describe('SuggestedConnections', () => {
  it('says which switch to turn on and links to the Connections page, for a task or a chat', () => {
    for (const scope of ['task', 'chat'] as const) {
      const { unmount } = render(<MemoryRouter><SuggestedConnections items={[item(scope)]} taskId="t-1" /></MemoryRouter>);
      expect(screen.getByText(/"Marin" is paused: resume it in Connections and tools/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open Connections and tools' })).toHaveAttribute('href', '/settings/connections');
      unmount();
    }
  });

  it('renders nothing without a suggestion', () => {
    const { container } = render(<MemoryRouter><SuggestedConnections items={[]} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});
