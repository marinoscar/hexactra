// "This could have used your account" (E41.5): the line under a finished run, on the chat's result card and the run page.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { SuggestedConnections } from '../components/SuggestedConnections';

const item = (scope: 'task' | 'chat') => ({ connectionId: 'c1', label: 'Marin', provider: 'google', site: 'Google Mail', scope, text: `This used the browser for Google Mail. You have "Marin" connected: allow it for this ${scope} to do this without the browser.` });

describe('SuggestedConnections', () => {
  it('says what the run did and links to the task\'s accounts', () => {
    render(<MemoryRouter><SuggestedConnections items={[item('task')]} taskId="t-1" /></MemoryRouter>);
    expect(screen.getByText(/This used the browser for Google Mail\. You have "Marin" connected/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "Choose the task's accounts" })).toHaveAttribute('href', '/tasks/t-1/edit');
  });

  it('points a chat\'s run to the chat settings, and renders nothing without a suggestion', () => {
    const { container, rerender } = render(<MemoryRouter><SuggestedConnections items={[item('chat')]} /></MemoryRouter>);
    expect(screen.getByText(/Add it in this chat.s settings\./)).toBeInTheDocument();
    rerender(<MemoryRouter><SuggestedConnections items={[]} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});
