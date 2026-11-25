import { act, fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import { QuestionAnswerForm } from '../components/QuestionAnswerForm';
import { SCAN_BLUETOOTH_TEXT, SCAN_REFRESH_MS, scanWarning } from '../components/ScanPicture';
import { requestTitle } from '../components/ChatRequest';
import type { AskedQuestion } from '../components/questions';

const scanQuestion = (over: Partial<AskedQuestion> = {}): AskedQuestion => ({
  id: 'q-1',
  kind: 'login',
  input: 'scan',
  options: null,
  constraints: null,
  confirmLabel: null,
  denyLabel: null,
  risk: null,
  viewerUrl: null,
  scan: { source: 'page', domain: 'example-bank.com', origin: 'https://login.example-bank.com' },
  ...over,
});

function respond(status: number, body?: unknown) {
  return status === 200
    ? new Response(new Blob(['jpeg']), { status, headers: { 'x-scan-domain': 'example-bank.com' } })
    : new Response(JSON.stringify(body ?? { message: 'no' }), { status, headers: { 'content-type': 'application/json' } });
}

describe('a scan question (#924)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => respond(200));
    vi.stubGlobal('fetch', fetchMock);
    let n = 0;
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:frame-${++n}`, revokeObjectURL: () => undefined }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the live picture large, with the permanent warning naming the site, refreshed every 2 s; Done sends no value', async () => {
    const onSubmit = vi.fn();
    render(<QuestionAnswerForm question={scanQuestion()} onSubmit={onSubmit} />);
    expect(screen.getByText(scanWarning('example-bank.com'))).toBeInTheDocument();
    expect(screen.queryByText(SCAN_BLUETOOTH_TEXT)).toBeNull();
    await act(async () => undefined);
    expect(fetchMock).toHaveBeenCalledWith('/api/questions/q-1/scan-image', expect.objectContaining({ cache: 'no-store' }));
    expect(screen.getByRole('img', { name: 'What to scan on example-bank.com' })).toHaveAttribute('src', 'blob:frame-1');
    await act(async () => {
      vi.advanceTimersByTime(SCAN_REFRESH_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('img', { name: 'What to scan on example-bank.com' })).toHaveAttribute('src', 'blob:frame-2');
    fireEvent.click(screen.getByRole('button', { name: 'Done, I scanned it' }));
    expect(onSubmit).toHaveBeenCalledWith({ outcome: 'completed' });
  });

  it("adds the Bluetooth line for Chrome's own passkey window", async () => {
    render(<QuestionAnswerForm question={scanQuestion({ kind: 'passkey', scan: { source: 'desktop', domain: 'example-bank.com', origin: null } })} onSubmit={vi.fn()} />);
    expect(screen.getByText(SCAN_BLUETOOTH_TEXT)).toBeInTheDocument();
    await act(async () => undefined);
  });

  it('replaces the picture with "do not scan" when the browser left the site', async () => {
    fetchMock.mockImplementation(async () => respond(409, { message: 'The browser is no longer on example-bank.com. Do not scan anything for this request.' }));
    render(<QuestionAnswerForm question={scanQuestion()} onSubmit={vi.fn()} />);
    await act(async () => undefined);
    expect(screen.getByText('The browser is no longer on example-bank.com. Do not scan anything for this request.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('keeps trying after a passing failure, without a refusal', async () => {
    fetchMock.mockImplementationOnce(async () => respond(503, { message: 'busy' })).mockImplementation(async () => respond(200));
    render(<QuestionAnswerForm question={scanQuestion()} onSubmit={vi.fn()} />);
    await act(async () => undefined);
    expect(screen.getByText('Taking a picture of the screen…')).toBeInTheDocument();
    expect(screen.queryByText('busy')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(SCAN_REFRESH_MS);
    });
    expect(screen.getByRole('img', { name: 'What to scan on example-bank.com' })).toBeInTheDocument();
  });

  it('shows no picture at all when the address could not be read', async () => {
    render(<QuestionAnswerForm question={scanQuestion({ scan: { source: 'page', domain: null, origin: null } })} onSubmit={vi.fn()} />);
    expect(screen.getByText(/could not read the page's address/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('titles the chat card "Scan with your phone"', () => {
    expect(requestTitle({ input: 'scan', kind: 'login' })).toBe('Scan with your phone');
  });
});
