// The run's trace id (E38.4, #585): shown as a copyable id, nothing when the run has none (telemetry off).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunTraceId } from '../components/RunTraceId';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

describe('RunTraceId', () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('shows the id and copies it', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<RunTraceId traceId={TRACE} />);
    expect(screen.getByTestId('run-trace-id')).toHaveTextContent(TRACE);
    fireEvent.click(screen.getByRole('button', { name: 'Copy the trace id' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TRACE));
  });

  it('renders nothing for a run without a trace id', () => {
    const { container } = render(<RunTraceId traceId={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
