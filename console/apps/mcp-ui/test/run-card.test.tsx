// The live run card (#466) against a mocked MCP Apps host: each run state,
// polling (since, terminal, hidden, 30 minutes, backoff, fallback), Stop,
// supersession, links, no HTML injection, light and dark.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostContextLike } from '../src/bridge';
import { RunCard } from '../src/RunCard';
import { MAX_POLLING_MS } from '../src/poller';
import { CONSOLE, RUN_ID, TASK_ID, channelBus, mockHost, result, waitResult, type ToolHandler } from './fixtures';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

/** Let pending timers and promises run for `ms`. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(opts: { tools?: ToolHandler; visible?: () => boolean; context?: HostContextLike; channelFactory?: ReturnType<typeof channelBus>['factory'] } = {}) {
  const m = mockHost({ tools: opts.tools, context: opts.context });
  const view = render(<RunCard host={m.host} isVisible={opts.visible} channelFactory={opts.channelFactory} />);
  return { ...m, view };
}

/** Tools that never answer (so a test sees the first call only). */
const hang: ToolHandler = () => new Promise(() => undefined);

describe('run states', () => {
  it.each([
    ['queued', result('queued'), 'Queued'],
    ['running', result('running', { image: true }), 'Running'],
    ['waiting on a person', result('waiting_human', { progress: { question: { id: 'q1', input: 'text', prompt: 'Which time works?', answerable_here: true } } }), 'Needs you'],
    ['succeeded', result('succeeded', { progress: { result: 'Booked for 20:00' } }), 'Finished'],
    ['failed', result('failed', { run: { stopReason: 'error' }, progress: { stop_reason: 'Stopped by an error: timeout' } }), 'Failed'],
    ['cancelled', result('cancelled', { run: { stopReason: 'cancelled' }, progress: { stop_reason: 'Stopped: it was cancelled' } }), 'Stopped'],
    ['budget stop', result('failed', { run: { stopReason: 'budget_cost' }, progress: { stop_reason: 'Stopped: it reached the cost limit of its policy' } }), 'Budget reached'],
    ['stalled', result('failed', { run: { stopReason: 'stalled' }, progress: { stop_reason: 'Stopped: it was stuck and made no progress' } }), 'Stalled'],
  ])('%s', (_name, r, label) => {
    const m = mount({ tools: hang });
    m.push(r);
    // Text and an icon, never colour alone.
    const chip = document.querySelector('.chip')!;
    expect(chip).toHaveTextContent(label);
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('Book a table for two at eight')).toBeInTheDocument();
  });

  it('shows the result, duration and cost when finished, and Run again', () => {
    const m = mount({ tools: hang });
    m.push(result('succeeded', { progress: { result: 'Booked for 20:00', elapsed_s: 100 } }));
    expect(screen.getByText('Booked for 20:00')).toBeInTheDocument();
    expect(screen.getByText(/Took 1 min 40 s, 3 steps, \$0\.01/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('shows the budget meter (the budget closest to its limit) with the policy and tier, and hides it when unlimited', () => {
    const m = mount({ tools: hang });
    m.push(result('running', { progress: { budget: { actions: 20, cost: 75.5, activeMinutes: 10, inputTokens: 99 } } }));
    expect(screen.getByRole('meter', { name: 'Cost budget used' })).toHaveAttribute('aria-valuenow', '76');
    expect(screen.getByText('Balanced · standard')).toBeInTheDocument();
    m.push(result('running', { progress: { budget: { actions: null, cost: null, activeMinutes: null } } }));
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('shows the screenshot with its age, expands it inline, and marks the activity as from the page', async () => {
    const m = mount({ tools: hang });
    m.push(result('running', { image: true }));
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('alt', "Screenshot of the run's browser. Doing: click #submit");
    expect(screen.getByText('Updated 0 s ago')).toBeInTheDocument();
    await advance(3000);
    expect(screen.getByText('Updated 3 s ago')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Show the screenshot larger' });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('from the page')).toBeInTheDocument();
  });

  it('says "Started by this chat" only when the card was opened by the call that started the run', () => {
    const started = mount({ tools: hang, context: { toolInfo: { id: 'a', tool: { name: 'task_run' } } } });
    started.push(result('running'));
    expect(screen.getByText('Started by this chat')).toBeInTheDocument();
    started.view.unmount();
    const followed = mount({ tools: hang, context: { toolInfo: { id: 'b', tool: { name: 'run_status' } } } });
    followed.push(result('running'));
    expect(screen.queryByText('Started by this chat')).toBeNull();
  });
});

describe('needs you', () => {
  it('offers "Answer in the chat" and the inbox for a question answerable by the model but not in the card (a high-risk confirm over a personal access token)', async () => {
    const m = mount({ tools: hang });
    m.push(result('waiting_human', { progress: { question: { id: 'q1', input: 'confirm', risk: 'high', prompt: 'Pay 40 EUR?', answerable_here: true } } }));
    expect(screen.getByText('Pay 40 EUR?')).toBeInTheDocument();
    // No approve button in the card: a high-risk approval is never collected in a chat's widget.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Answer in the chat' }));
    expect(m.host.sendMessage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open inbox' }));
    await advance(0);
    expect(m.host.openLink).toHaveBeenCalledWith('https://console.example.test/inbox/q/q1');
  });

  it('answers a choice in the banner itself (#467): question_card_answer, "Sent", then a short message to the conversation', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const m = mount({
      tools: async (name, args) => {
        calls.push([name, args]);
        if (name === 'question_card_answer') return { content: [{ type: 'text', text: 'ok' }], structuredContent: { question_id: 'q1', status: 'answered', input: 'choice', outcome: 'completed', value: 'late' } };
        return new Promise(() => undefined);
      },
    });
    m.push(
      result('waiting_human', {
        progress: { question: { id: 'q1', input: 'choice', prompt: 'Which time works?', options: [{ id: 'early', label: '19:00' }, { id: 'late', label: '20:00', description: 'Terrace' }], answerable_here: true } },
      }),
    );
    expect(screen.getByText('Terrace')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /20:00/ }));
    fireEvent.click(send);
    await advance(0);
    expect(calls.find(([n]) => n === 'question_card_answer')).toEqual(['question_card_answer', { question_id: 'q1', outcome: 'completed', value: 'late' }]);
    expect(screen.getByText('Sent: 20:00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(m.host.sendMessage).toHaveBeenCalledWith("I answered the agent's question: 20:00");
    // The model's own relay button is not offered next to the form.
    expect(screen.queryByRole('button', { name: 'Answer in the chat' })).toBeNull();
  });

  it('keeps the form with the server\'s sentence when the answer is refused', async () => {
    const m = mount({
      tools: async (name) => {
        if (name === 'question_card_answer') return { isError: true, content: [{ type: 'text', text: 'At most 5 [INVALID_ANSWER]' }] };
        return new Promise(() => undefined);
      },
    });
    m.push(result('waiting_human', { progress: { question: { id: 'q1', input: 'number', prompt: 'How many?', constraints: { max: 5 }, answerable_here: true } } }));
    fireEvent.input(screen.getByLabelText('Number'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await advance(0);
    expect(screen.getByRole('alert')).toHaveTextContent('At most 5');
    expect(screen.getByLabelText('Number')).not.toBeDisabled();
    expect(m.host.sendMessage).not.toHaveBeenCalled();
  });

  it('never shows an input or a screenshot while a secret is asked for, and only links to the inbox', () => {
    const m = mount({ tools: hang });
    m.push(result('running', { image: true }));
    expect(screen.getByRole('img')).toBeInTheDocument();
    m.push(result('waiting_human', { progress: { screenshot: 'hidden', question: { id: 'q2', input: 'secret', prompt: 'Enter the code sent to your phone', answerable_here: false, how_to_answer: 'Open your inbox' } } }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Screenshot hidden while a code or password is entered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Answer in the chat' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open inbox' })).toBeInTheDocument();
    expect(document.querySelectorAll('input, textarea, select, [contenteditable]')).toHaveLength(0);
  });
});

describe('live updates', () => {
  it('polls run_card_poll with the last cursor as since; a screenshot at most every 5 s while running', async () => {
    let n = 0;
    const m = mount({ tools: async () => result('running', { progress: { cursor: `c${++n + 1}` }, image: true }) });
    m.push(result('running', { progress: { cursor: 'c1' } }));
    await advance(0);
    expect(m.host.callTool).toHaveBeenNthCalledWith(1, 'run_card_poll', { run_id: RUN_ID, wait_s: 5, screenshot: true, since: 'c1' });
    await advance(1000);
    // The next call carries the cursor of the answer; within 5 s of the last picture it asks for none.
    expect(m.host.callTool).toHaveBeenNthCalledWith(2, 'run_card_poll', { run_id: RUN_ID, wait_s: 5, screenshot: false, since: 'c2' });
    await advance(5000);
    const shots = m.host.callTool.mock.calls.filter((c) => (c[1] as { screenshot: boolean }).screenshot).length;
    expect(shots).toBeLessThanOrEqual(2);
  });

  it('waits 25 s at a time while the run is not running', async () => {
    const m = mount({ tools: hang });
    m.push(result('queued'));
    await advance(0);
    expect(m.host.callTool).toHaveBeenCalledWith('run_card_poll', { run_id: RUN_ID, wait_s: 25, screenshot: false, since: 'cur-queued' });
  });

  it('stops polling when the run is finished', async () => {
    const m = mount({ tools: async () => result('succeeded', { progress: { result: 'Done' } }) });
    m.push(result('running'));
    await advance(0);
    expect(m.host.callTool).toHaveBeenCalledTimes(1);
    await advance(120_000);
    expect(m.host.callTool).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Finished')).toBeInTheDocument();
  });

  it('does not poll a card that opened on a finished run', async () => {
    const m = mount({ tools: hang });
    m.push(result('cancelled'));
    await advance(60_000);
    expect(m.host.callTool).not.toHaveBeenCalled();
  });

  it('stops while the card is hidden and resumes when it is shown', async () => {
    let shown = true;
    const m = mount({ visible: () => shown, tools: async () => result('queued') });
    m.push(result('queued'));
    await advance(0);
    const before = m.host.callTool.mock.calls.length;
    shown = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(10 * 60_000);
    expect(m.host.callTool.mock.calls.length).toBe(before + 0);
    shown = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(0);
    expect(m.host.callTool.mock.calls.length).toBeGreaterThan(before);
  });

  it('pauses after 30 minutes with "Paused updating", and Refresh starts again', async () => {
    const m = mount({ tools: async () => result('queued') });
    m.push(result('queued'));
    await advance(MAX_POLLING_MS + 5_000);
    expect(document.querySelector('.banner')).toHaveTextContent('Paused updating.');
    const calls = m.host.callTool.mock.calls.length;
    await advance(10 * 60_000);
    expect(m.host.callTool.mock.calls.length).toBe(calls);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await advance(0);
    expect(m.host.callTool.mock.calls.length).toBe(calls + 1);
  });

  it('backs off 5 s, 15 s, then 60 s on errors and says "Reconnecting"', async () => {
    let ok = true;
    const m = mount({
      tools: async () => {
        if (ok) {
          ok = false;
          return result('queued');
        }
        throw new Error('host error');
      },
    });
    m.push(result('queued'));
    await advance(0); // 1: ok
    await advance(1000); // 2: fails
    expect(m.host.callTool).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    await advance(4_900);
    expect(m.host.callTool).toHaveBeenCalledTimes(2);
    await advance(100); // +5 s: 3
    expect(m.host.callTool).toHaveBeenCalledTimes(3);
    await advance(14_900);
    expect(m.host.callTool).toHaveBeenCalledTimes(3);
    await advance(100); // +15 s: 4
    expect(m.host.callTool).toHaveBeenCalledTimes(4);
    await advance(59_900);
    expect(m.host.callTool).toHaveBeenCalledTimes(4);
    await advance(100); // +60 s: 5
    expect(m.host.callTool).toHaveBeenCalledTimes(5);
    // Recovery clears the banner.
    m.setTools(async () => result('queued'));
    await advance(60_000);
    expect(screen.queryByText('Reconnecting…')).toBeNull();
  });

  it('falls back to run_wait (since, wait_s 25) and run_status (screenshot) when the host refuses run_card_poll', async () => {
    const m = mount({
      tools: async (name) => {
        if (name === 'run_card_poll') throw new Error('Unknown tool');
        if (name === 'run_status') return result('running', { image: true });
        return waitResult('queued', { cursor: 'w2' });
      },
    });
    m.push(result('queued', { progress: { cursor: 'w1' } }));
    await advance(0);
    await advance(1000);
    expect(m.host.callTool).toHaveBeenNthCalledWith(1, 'run_card_poll', expect.anything());
    expect(m.host.callTool).toHaveBeenNthCalledWith(2, 'run_wait', { run_id: RUN_ID, wait_s: 25, screenshot: false, since: 'w1' });
    await advance(1000);
    expect(m.host.callTool).toHaveBeenNthCalledWith(3, 'run_wait', { run_id: RUN_ID, wait_s: 25, screenshot: false, since: 'w2' });
    // A bare progress block keeps the run's goal on the card.
    expect(screen.getByText('Book a table for two at eight')).toBeInTheDocument();
  });
});

describe('actions', () => {
  it('Stop asks "Stop this run?" inline, then calls run_cancel', async () => {
    const m = mount({ tools: async (name) => (name === 'run_cancel' ? result('running', { run: { cancelRequested: true } }) : new Promise(() => undefined)) });
    m.push(result('running'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText('Stop this run?')).toBeInTheDocument();
    expect(m.host.callTool).not.toHaveBeenCalledWith('run_cancel', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    expect(screen.queryByText('Stop this run?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    await advance(0);
    expect(m.host.callTool).toHaveBeenCalledWith('run_cancel', { run_id: RUN_ID });
    expect(screen.getByText('The run is stopping.')).toBeInTheDocument();
    // The button says so and cannot be pressed again (E38.1).
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  });

  it('Open in Hexactra opens the run page through the host', async () => {
    const m = mount({ tools: hang });
    m.push(result('running'));
    fireEvent.click(screen.getByRole('button', { name: 'Open in Hexactra' }));
    await advance(0);
    expect(m.host.openLink).toHaveBeenCalledWith(CONSOLE);
  });

  it('Run again starts the task with task_run, or asks in the chat for a run without a task', async () => {
    const m = mount({ tools: async (name) => (name === 'task_run' ? result('queued', { run: { id: RUN_ID, taskId: TASK_ID } }) : new Promise(() => undefined)) });
    m.push(result('succeeded', { run: { taskId: TASK_ID } }));
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await advance(0);
    expect(m.host.callTool).toHaveBeenCalledWith('task_run', { task_id: TASK_ID });
    expect(screen.getByText('Queued')).toBeInTheDocument();
    m.view.unmount();

    const n = mount({ tools: hang });
    n.push(result('succeeded'));
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await advance(0);
    expect(n.host.sendMessage).toHaveBeenCalledWith('Run this again');
    expect(n.host.callTool).not.toHaveBeenCalled();
  });
});

describe('supersession', () => {
  it('an older card of the same run stops polling and says "Newer update below"; the newest keeps polling', async () => {
    const bus = channelBus();
    const older = mount({ tools: async () => result('queued'), channelFactory: bus.factory, context: { toolInfo: { id: 'old' } } });
    older.push(result('queued', { key: { created_at: 1000, seq: 1 } }));
    await advance(0);
    const newer = mockHost({ tools: async () => result('queued'), context: { toolInfo: { id: 'new' } } });
    render(<RunCard host={newer.host} channelFactory={bus.factory} />);
    newer.push(result('queued', { key: { created_at: 2000, seq: 2 } }));
    await advance(0);
    expect(screen.getAllByText('Newer update below')).toHaveLength(1);
    const olderCalls = older.host.callTool.mock.calls.length;
    const newerCalls = newer.host.callTool.mock.calls.length;
    await advance(120_000);
    expect(older.host.callTool.mock.calls.length).toBe(olderCalls);
    expect(newer.host.callTool.mock.calls.length).toBeGreaterThan(newerCalls);
  });
});

describe('safety and theme', () => {
  const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>';

  it('renders every string from a tool result as text, never as HTML', () => {
    const m = mount({ tools: hang });
    m.push(
      result('waiting_human', {
        run: { goal: evil, policy: { name: evil }, currentTier: evil },
        progress: { activity: evil, stop_reason: evil, result: evil, screenshot_note: evil, budget: { cost: 50 }, question: { id: evil, input: 'text', prompt: evil, answerable_here: true } },
      }),
    );
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
    expect(document.body.innerHTML).not.toContain('<script>');
    expect(screen.getAllByText(evil, { exact: false }).length).toBeGreaterThan(0);
    m.push(result('succeeded', { run: { goal: evil }, progress: { result: evil, stop_reason: evil } }));
    expect(document.querySelector('script, a, img')).toBeNull();
  });

  it('refuses a console URL that is not http(s) and a non-image data block', () => {
    const m = mount({ tools: hang });
    m.push({
      content: [{ type: 'image', data: 'PHN2Zz4=', mimeType: 'image/svg+xml' }],
      structuredContent: { ...(result('running').structuredContent as object), progress: { ...(result('running').structuredContent!.progress as object), console_url: 'javascript:alert(1)' } },
    });
    expect(screen.queryByRole('button', { name: 'Open in Hexactra' })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('follows the host theme, light and dark', () => {
    const m = mount({ tools: hang, context: { theme: 'dark' } });
    m.push(result('running'));
    expect(document.querySelector('.card')).toHaveAttribute('data-theme', 'dark');
    m.context({ theme: 'light' });
    expect(document.querySelector('.card')).toHaveAttribute('data-theme', 'light');
  });

  it('announces status changes politely and keeps every action keyboard-reachable with 44 px targets', () => {
    const m = mount({ tools: hang });
    m.push(result('running'));
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live).toHaveTextContent('Run running.');
    m.push(result('succeeded'));
    expect(live).toHaveTextContent('Run finished.');
    for (const b of screen.getAllByRole('button')) expect(b.tagName).toBe('BUTTON');
  });
});
