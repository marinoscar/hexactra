// The question card (#467) against a mocked MCP Apps host: the list from
// inbox_list, one question from question_status, submit and decline through
// question_card_answer, "Sent" and the message to the conversation, the
// already-answered and expired states, "Not sent", the countdown, polling
// that starts and stops, the scopes, and injection strings as text.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QuestionCard } from '../src/QuestionCard';
import type { QuestionCardTool } from '../src/question-model';
import type { ToolResultLike } from '../src/shared/text';
import { mockWidgetHost } from './fixtures';

const NOW = new Date('2026-11-18T10:00:00Z').getTime();
const Q1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const Q2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APP = 'https://console.example.test';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function item(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    questionId: id,
    runId: null,
    goal: '',
    handoffId: null,
    askedBy: 'agent:packer',
    kind: 'other',
    prompt: `Question ${id.slice(0, 2)}?`,
    input: 'choice',
    choices: ['s', 'l'],
    options: [
      { id: 's', label: 'Small' },
      { id: 'l', label: 'Large' },
    ],
    constraints: null,
    confirmLabel: null,
    denyLabel: null,
    risk: null,
    pageTitle: null,
    viewerUrl: null,
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 3600_000).toISOString(),
    ...extra,
  };
}

const list = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}): ToolResultLike => ({
  content: [{ type: 'text', text: `${items.length} waiting questions.` }],
  structuredContent: { items, app_url: APP, granted_scopes: ['inbox:read', 'inbox:write'], ...extra },
});

const answered = (id: string, value: string, extra: Record<string, unknown> = {}): ToolResultLike => ({
  content: [{ type: 'text', text: 'ok' }],
  structuredContent: { question_id: id, status: 'answered', input: 'choice', outcome: 'completed', value, ...extra },
});

type Handler = (name: QuestionCardTool, args: Record<string, unknown>) => Promise<ToolResultLike>;
const hang: Handler = () => new Promise(() => undefined);

function mount(tools: Handler = hang, visible: () => boolean = () => true) {
  const m = mockWidgetHost<QuestionCardTool>({ tools });
  render(<QuestionCard host={m.host} isVisible={visible} channelFactory={() => null} />);
  return m;
}

describe('the list (inbox_list)', () => {
  it('renders each pending question; one opens into its form; text only', () => {
    const evil = '<img src=x onerror="alert(1)">';
    const m = mount();
    m.push(list([item(Q1), item(Q2, { prompt: evil, goal: evil })]));
    expect(screen.getByText('Waiting for you (2)')).toBeInTheDocument();
    expect(screen.getByText('Question aa?')).toBeInTheDocument();
    expect(screen.getAllByText(evil).length).toBeGreaterThan(0);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getAllByText('from packer')).toHaveLength(2);
    // Collapsed in a list of two: "Answer" opens one.
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Answer' })[0]!);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('says so when nothing is waiting, and does not poll', async () => {
    const m = mount();
    m.push(list([]));
    expect(screen.getByText('Nothing is waiting for you')).toBeInTheDocument();
    await advance(60_000);
    expect(m.host.callTool).not.toHaveBeenCalled();
  });
});

describe('answering', () => {
  it('submits through question_card_answer, shows "Sent" in words, disables the form and tells the conversation', async () => {
    const m = mount(async (name) => (name === 'question_card_answer' ? answered(Q1, 'l') : new Promise(() => undefined)));
    m.push(list([item(Q1)]));
    fireEvent.click(screen.getByRole('radio', { name: 'Large' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await advance(0);
    expect(m.host.callTool).toHaveBeenCalledWith('question_card_answer', { question_id: Q1, outcome: 'completed', value: 'l' });
    expect(screen.getByRole('status')).toHaveTextContent('Sent: Large');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(m.host.sendMessage).toHaveBeenCalledWith("I answered the agent's question: Large");
  });

  it('multi_choice sends values; Decline sends cancelled', async () => {
    const calls: Record<string, unknown>[] = [];
    const m = mount(async (name, args) => {
      if (name !== 'question_card_answer') return new Promise(() => undefined);
      calls.push(args);
      return { content: [], structuredContent: { question_id: args.question_id, status: args.outcome === 'cancelled' ? 'cancelled' : 'answered', input: 'multi_choice' } };
    });
    m.push(list([item(Q1, { input: 'multi_choice', constraints: { maxSelections: 2 } }), item(Q2)]));
    const [first, second] = screen.getAllByRole('button', { name: 'Answer' });
    fireEvent.click(first!);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Large' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Small' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await advance(0);
    expect(calls[0]).toEqual({ question_id: Q1, outcome: 'completed', values: ['s', 'l'] });
    expect(screen.getByText('Sent: Small, Large')).toBeInTheDocument();
    fireEvent.click(second!);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await advance(0);
    expect(calls[1]).toEqual({ question_id: Q2, outcome: 'cancelled' });
    expect(screen.getByText('Sent: you declined.')).toBeInTheDocument();
    expect(m.host.sendMessage).toHaveBeenLastCalledWith("I declined the agent's question.");
  });

  it('first answer wins: "Answered on another device" with their answer; an expired question says so', async () => {
    let n = 0;
    const m = mount(async (name) => {
      if (name !== 'question_card_answer') return new Promise(() => undefined);
      n += 1;
      return n === 1 ? answered(Q1, 's', { already_answered: true }) : { content: [], structuredContent: { question_id: Q2, status: 'expired', input: 'choice' } };
    });
    m.push(list([item(Q1), item(Q2)]));
    for (const b of screen.getAllByRole('button', { name: 'Answer' })) fireEvent.click(b);
    fireEvent.click(screen.getAllByRole('radio', { name: 'Large' })[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Send' })[0]!);
    await advance(0);
    expect(screen.getByText('Answered on another device: Small')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Large' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await advance(0);
    expect(screen.getByText('This question expired.')).toBeInTheDocument();
    expect(m.host.sendMessage).not.toHaveBeenCalled();
  });

  it('a refused answer keeps the form with the server sentence; a host refusal says "Not sent"', async () => {
    let refuse: 'server' | 'host' = 'server';
    const m = mount(async (name) => {
      if (name !== 'question_card_answer') return new Promise(() => undefined);
      if (refuse === 'host') throw new Error('declined');
      return { isError: true, content: [{ type: 'text', text: 'This question cannot be answered from the chat [NOT_ANSWERABLE_HERE]' }] };
    });
    m.push(list([item(Q1)]));
    fireEvent.click(screen.getByRole('radio', { name: 'Large' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await advance(0);
    expect(screen.getByRole('alert')).toHaveTextContent('This question cannot be answered from the chat');
    expect(screen.getByRole('radio', { name: 'Large' })).not.toBeDisabled();
    refuse = 'host';
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await advance(0);
    expect(screen.getByRole('alert')).toHaveTextContent(/^Not sent/);
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
  });

  it('without inbox:write it offers only the inbox', () => {
    const m = mount();
    m.push(list([item(Q1)], { granted_scopes: ['inbox:read'] }));
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('This connection cannot answer questions.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open inbox' }));
    expect(m.host.openLink).toHaveBeenCalledWith(`${APP}/inbox/q/${Q1}`);
  });

  it('a secret and a high-risk confirm render no answering control, only the inbox link', () => {
    const m = mount();
    m.push(list([item(Q1, { input: 'secret', kind: 'code', options: null }), item(Q2, { input: 'confirm', risk: 'high', options: null })]));
    for (const b of screen.getAllByRole('button', { name: 'Answer' })) fireEvent.click(b);
    expect(document.querySelectorAll('input, textarea')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open inbox' })).toHaveLength(2);
  });
});

describe('one question (question_status, ask_human)', () => {
  const single = (status: string, extra: Record<string, unknown> = {}): ToolResultLike => ({
    content: [{ type: 'text', text: 'Question' }],
    structuredContent: {
      question_id: Q1,
      status,
      input: 'number',
      expires_at: new Date(NOW + 3600_000).toISOString(),
      question: { id: Q1, input: 'number', prompt: 'How many bags?', options: null, constraints: { max: 5, unit: 'bags' }, risk: null, expires_at: new Date(NOW + 3600_000).toISOString(), answerable_here: true, run_id: null },
      app_url: APP,
      ...extra,
    },
  });

  it('opens its form at once', () => {
    const m = mount();
    m.push(single('pending'));
    expect(screen.getByText('Your agent asks')).toBeInTheDocument();
    expect(screen.getByLabelText('Number (bags)')).toBeInTheDocument();
  });

  it('shows a settled question as settled', () => {
    const m = mount();
    m.push(single('answered', { outcome: 'completed', value: '3' }));
    expect(screen.getByText('Answered on another device: 3 bags')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });
});

describe('countdown and refresh', () => {
  it('shows the time left under 10 minutes and expires the question at zero', async () => {
    const m = mount();
    m.push(list([item(Q1, { expiresAt: new Date(NOW + 5 * 60_000 + 30_000).toISOString() })]));
    expect(screen.getByText('Expires in 5 min 30 s')).toBeInTheDocument();
    await advance(10_000);
    expect(screen.getByText('Expires in 5 min 20 s')).toBeInTheDocument();
    await advance(6 * 60_000);
    expect(screen.getByText('This question expired.')).toBeInTheDocument();
  });

  it('no countdown with more than 10 minutes left', () => {
    const m = mount();
    m.push(list([item(Q1)]));
    expect(screen.queryByText(/Expires in/)).toBeNull();
  });

  it('refreshes through inbox_list every 15 s while visible; a question that left is followed with question_status; it stops when nothing is pending', async () => {
    const lists = [list([item(Q1), item(Q2)]), list([item(Q2)])];
    const calls: string[] = [];
    const m = mount(async (name) => {
      calls.push(name);
      if (name === 'inbox_list') return lists.shift() ?? list([]);
      if (name === 'question_status') return { content: [], structuredContent: { question_id: Q1, status: 'answered', input: 'choice', outcome: 'completed', value: 'l' } };
      return new Promise(() => undefined);
    });
    m.push(list([item(Q1), item(Q2)]));
    await advance(14_000);
    expect(calls).toEqual([]);
    await advance(1_000);
    expect(calls).toEqual(['inbox_list']);
    await advance(15_000);
    expect(calls).toEqual(['inbox_list', 'inbox_list', 'question_status']);
    expect(screen.getByText('Answered on another device: Large')).toBeInTheDocument();
    await advance(15_000);
    // Q2 left with no final state known: "No longer waiting", and the refresh stops.
    expect(calls.filter((c) => c === 'inbox_list')).toHaveLength(3);
    await advance(60_000);
    expect(calls.filter((c) => c === 'inbox_list')).toHaveLength(3);
  });

  it('does not refresh while hidden, and backs off after an error', async () => {
    let visible = false;
    let fail = true;
    const calls: string[] = [];
    const m = mount(
      async (name) => {
        calls.push(name);
        if (fail) throw new Error('offline');
        return list([item(Q1)]);
      },
      () => visible,
    );
    m.push(list([item(Q1)]));
    await advance(60_000);
    expect(calls).toEqual([]);
    visible = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await advance(0);
    expect(calls).toHaveLength(1);
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    fail = false;
    await advance(4_000);
    expect(calls).toHaveLength(1);
    await advance(1_000);
    expect(calls).toHaveLength(2);
    expect(screen.queryByText('Reconnecting…')).toBeNull();
  });
});
