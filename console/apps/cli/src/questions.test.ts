import { Readable } from 'node:stream';

import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { renderTuiScreen, stripAnsi } from '@marinoscar/platform-cli/tui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import type { InboxItem } from './inbox.js';
import { inboxCommand } from './inbox.command.js';
import { answerFromFlags, answerText, type Question } from './questions.js';
import { askBody, parseOption, questionsCommand } from './questions.command.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const Q = '77777777-7777-4777-8777-777777777777';

function question(over: Partial<Question> = {}): Question {
  return {
    id: Q,
    askedBy: 'agent:packer',
    runId: null,
    browserBound: false,
    input: 'text',
    kind: 'other',
    prompt: 'What is the reference?',
    options: null,
    constraints: null,
    confirmLabel: null,
    denyLabel: null,
    risk: null,
    status: 'pending',
    response: null,
    pageTitle: null,
    viewerUrl: null,
    createdAt: '2026-11-15T00:00:00Z',
    expiresAt: '2026-11-15T01:00:00Z',
    ...over,
  };
}

/** The console API behind a fake fetch: routes by `METHOD /path`, a route may be a list answered in turn. */
function fakeApi(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; query: string; body: unknown }[] = [];
  const turns: Record<string, number> = {};
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    calls.push({ method, path, query: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    let data = routes[key];
    if (key.startsWith('GET /questions/') && Array.isArray(data)) {
      const n = (turns[key] = (turns[key] ?? -1) + 1);
      data = data[Math.min(n, data.length - 1)];
    }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  setConsoleApiFactory(() => new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch }));
  return calls;
}

async function run(...args: string[]): Promise<string> {
  const program = new Command().exitOverride();
  questionsCommand(program);
  inboxCommand(program);
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    await program.parseAsync(['node', 'hexactra', ...args]);
  } finally {
    spy.mockRestore();
  }
  return out;
}

/** Feed `text` to process.stdin for one command. */
function withStdin(text: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: Readable.from([text]), configurable: true });
  return () => Object.defineProperty(process, 'stdin', original);
}

afterEach(() => setConsoleApiFactory(null));

describe('answer flags', () => {
  const noSecret = async () => {
    throw new Error('stdin read');
  };
  it('turns each flag into its answer body', async () => {
    expect(await answerFromFlags({ value: '42' }, 'number', noSecret)).toEqual({ outcome: 'completed', value: '42' });
    expect(await answerFromFlags({ values: 'a, c' }, 'multi_choice', noSecret)).toEqual({ outcome: 'completed', values: ['a', 'c'] });
    expect(await answerFromFlags({ choice: 'w' }, 'choice', noSecret)).toEqual({ outcome: 'completed', value: 'w' });
    expect(await answerFromFlags({ approve: true }, 'confirm', noSecret)).toEqual({ outcome: 'completed', value: 'approve' });
    expect(await answerFromFlags({ deny: true }, 'confirm', noSecret)).toEqual({ outcome: 'completed', value: 'deny' });
    expect(await answerFromFlags({ done: true }, 'takeover', noSecret)).toEqual({ outcome: 'completed' });
    expect(await answerFromFlags({ decline: true }, 'text', noSecret)).toEqual({ outcome: 'cancelled' });
    expect(await answerFromFlags({ secretStdin: true }, 'secret', async () => '123456')).toEqual({ outcome: 'completed', value: '123456' });
  });

  it('names the missing flag and refuses two answers or an empty secret', async () => {
    await expect(answerFromFlags({}, 'multi_choice', noSecret)).rejects.toThrow(/--values/);
    await expect(answerFromFlags({}, 'confirm', noSecret)).rejects.toThrow(/--approve or --deny/);
    await expect(answerFromFlags({}, 'secret', noSecret)).rejects.toThrow(/--secret-stdin/);
    await expect(answerFromFlags({ approve: true, deny: true }, 'confirm', noSecret)).rejects.toThrow(/one answer/);
    await expect(answerFromFlags({ secretStdin: true }, 'secret', async () => '')).rejects.toThrow(/No secret/);
  });

  it('describes answers without ever showing a secret', () => {
    const opts = [{ id: 'a', label: 'Apples' }, { id: 'c', label: 'Cherries' }];
    expect(answerText(question({ input: 'multi_choice', options: opts, status: 'answered', response: { outcome: 'completed', values: ['a', 'c'], valueWithheld: false, channel: 'web', answeredAt: '' } }))).toBe('answered: Apples, Cherries (via web)');
    expect(answerText(question({ input: 'number', constraints: { unit: 'kg' }, status: 'answered', response: { outcome: 'completed', value: '42', valueWithheld: false, answeredAt: '' } }))).toBe('answered: 42 kg');
    expect(answerText(question({ input: 'secret', status: 'answered', response: { outcome: 'completed', valueWithheld: true, answeredAt: '' } }))).toBe('answered (secret withheld)');
    expect(answerText(question({ input: 'confirm', status: 'answered', response: { outcome: 'completed', value: 'deny', valueWithheld: false, answeredAt: '' } }))).toBe('denied');
    expect(answerText(question({ status: 'cancelled', response: { outcome: 'cancelled', valueWithheld: false, answeredAt: '' } }))).toBe('declined');
  });
});

describe('hexactra questions', () => {
  it('ask: maps every flag to the contract and refuses a secret', () => {
    expect(parseOption('w=Window seat')).toEqual({ id: 'w', label: 'Window seat' });
    expect(parseOption('Aisle')).toBe('Aisle');
    expect(
      askBody({ input: 'multi_choice', prompt: 'Which?', option: ['a=Apples', 'Pears'], minSelections: 1, maxSelections: 2, timeout: 600 }),
    ).toEqual({ input: 'multi_choice', prompt: 'Which?', options: [{ id: 'a', label: 'Apples' }, 'Pears'], constraints: { minSelections: 1, maxSelections: 2 }, timeoutMs: 600_000, asker: 'cli' });
    expect(askBody({ input: 'number', prompt: 'Weight?', min: 0, max: 50, step: 0.5, unit: 'kg' })).toMatchObject({ constraints: { min: 0, max: 50, step: 0.5, unit: 'kg' } });
    expect(askBody({ input: 'text', prompt: 'Ref?', pattern: '[A-Z]{3}', maxLength: 3, multiline: true })).toMatchObject({ constraints: { pattern: '[A-Z]{3}', maxLength: 3, multiline: true } });
    expect(askBody({ input: 'confirm', prompt: 'Go?', confirmLabel: 'Go', denyLabel: 'Stop', risk: 'low', kind: 'confirmation' })).toMatchObject({ confirmLabel: 'Go', denyLabel: 'Stop', risk: 'low', kind: 'confirmation' });
    expect(() => askBody({ input: 'secret', prompt: 'Password?' })).toThrow(/browser session/);
    expect(() => askBody({ input: 'essay', prompt: 'x' })).toThrow(/--input is one of/);
  });

  it('ask --wait: posts the question and long-polls until it is answered', async () => {
    const asked = question({ input: 'choice', options: [{ id: 'w', label: 'Window' }, { id: 'a', label: 'Aisle' }] });
    const answered = { ...asked, status: 'answered', response: { outcome: 'completed', value: 'w', valueWithheld: false, channel: 'web', answeredAt: '2026-11-15T00:01:00Z' } };
    const calls = fakeApi({ 'POST /questions': asked, [`GET /questions/${Q}`]: [asked, answered] });
    const out = await run('questions', 'ask', '--input', 'choice', '--prompt', 'Seat?', '--option', 'w=Window', '--option', 'a=Aisle', '--timeout', '120', '--wait', '60');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/questions', body: { input: 'choice', prompt: 'Seat?', options: [{ id: 'w', label: 'Window' }, { id: 'a', label: 'Aisle' }], timeoutMs: 120_000, asker: 'cli' } });
    expect(calls.filter((c) => c.method === 'GET').every((c) => /waitMs=\d+/.test(c.query))).toBe(true);
    expect(out).toContain('answered: Window (via web)');
  });

  it('ask rejects a non-numeric constraint', async () => {
    fakeApi({});
    await expect(run('questions', 'ask', '--input', 'number', '--prompt', 'n', '--min', 'lots')).rejects.toThrow(/--min must be a number/);
  });

  it('list shows pending questions, --all every recent one', async () => {
    const calls = fakeApi({ 'GET /questions': [question({ input: 'choice', options: [{ id: 'w', label: 'Window', description: 'By the window' }] })] });
    const out = await run('questions', 'list');
    expect(calls[0]!.query).toContain('status=pending');
    expect(out).toContain('77777777  [other, choice]  What is the reference?');
    expect(out).toContain('w) Window — By the window');
    await run('questions', 'list', '--all');
    expect(calls[1]!.query).not.toContain('status=');
  });

  it('show --wait prints the final state', async () => {
    fakeApi({ [`GET /questions/${Q}`]: [question({ status: 'expired' })] });
    expect(await run('questions', 'show', Q, '--wait', '5')).toContain('expired');
  });

  it('answer: each form posts to the broker as the cli channel, a prefix names the question', async () => {
    const forms: [string[], Partial<Question>, Record<string, unknown>][] = [
      [['--value', 'ABC'], {}, { outcome: 'completed', value: 'ABC' }],
      [['--values', 'a,c'], { input: 'multi_choice' }, { outcome: 'completed', values: ['a', 'c'] }],
      [['--choice', 'w'], { input: 'choice' }, { outcome: 'completed', value: 'w' }],
      [['--approve'], { input: 'confirm' }, { outcome: 'completed', value: 'approve' }],
      [['--deny'], { input: 'confirm' }, { outcome: 'completed', value: 'deny' }],
      [['--done'], { input: 'takeover' }, { outcome: 'completed' }],
      [['--decline'], {}, { outcome: 'cancelled' }],
    ];
    for (const [flags, over, body] of forms) {
      const q = question(over);
      const calls = fakeApi({ 'GET /questions': [q], [`GET /questions/${Q}`]: q, [`POST /questions/${Q}/answer`]: { ...q, status: 'answered', response: { ...body, valueWithheld: false, answeredAt: '' } } });
      await run('questions', 'answer', Q.slice(0, 8), ...flags);
      expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/questions/${Q}/answer`, body: { ...body, channel: 'cli' } });
    }
  });

  it('answer --secret-stdin reads the secret from stdin, never from argv', async () => {
    const q = question({ input: 'secret', browserBound: true, runId: '66666666-6666-4666-8666-666666666666' });
    const calls = fakeApi({ [`GET /questions/${Q}`]: q, [`POST /questions/${Q}/answer`]: { ...q, status: 'answered', response: { outcome: 'completed', valueWithheld: true, answeredAt: '' } } });
    const restore = withStdin('246810\n');
    let out: string;
    try {
      out = await run('questions', 'answer', Q, '--secret-stdin');
    } finally {
      restore();
    }
    expect(calls.at(-1)?.body).toEqual({ outcome: 'completed', value: '246810', channel: 'cli' });
    expect(out).toContain('secret withheld');
    expect(out).not.toContain('246810');
    // There is no flag that takes a secret as an argument.
    await expect(run('questions', 'answer', Q, '--secret', '246810')).rejects.toThrow();
  });
});

describe('hexactra inbox (free-standing questions)', () => {
  const item: InboxItem = {
    questionId: Q,
    runId: null,
    goal: 'Which sides?',
    askedBy: 'agent:packer',
    kind: 'other',
    prompt: 'Which sides?',
    input: 'multi_choice',
    choices: ['a', 'b'],
    options: [{ id: 'a', label: 'Apples' }, { id: 'b', label: 'Beans' }],
    constraints: { maxSelections: 2 },
    confirmLabel: null,
    denyLabel: null,
    risk: null,
    pageTitle: null,
    viewerUrl: null,
    expiresAt: '2026-11-15T01:00:00Z',
  };

  it('lists a question without a run and answers it through the broker', async () => {
    const calls = fakeApi({ 'GET /inbox': [item], [`POST /questions/${Q}/answer`]: question() });
    const out = await run('inbox', 'list');
    expect(out).toContain('77777777  [other, multi_choice]  Which sides?');
    expect(out).toContain('a) Apples');
    expect(out).toContain('choose at most 2');
    await run('inbox', 'answer', Q.slice(0, 8), '--values', 'a,b');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/questions/${Q}/answer`, body: { outcome: 'completed', values: ['a', 'b'], channel: 'cli' } });
  });

  it('TUI: toggles several choices and sends them', async () => {
    const { InboxScreen } = await import('./inbox.screen.js');
    const calls = fakeApi({ 'GET /inbox': [item], [`POST /questions/${Q}/answer`]: question() });
    const screen = await renderTuiScreen(InboxScreen, { columns: 100 });
    await screen.waitForFrame((f) => stripAnsi(f).includes('[ ] 1) Apples'));
    await screen.press('1');
    await screen.press('2');
    await screen.press('2');
    await screen.waitForFrame((f) => stripAnsi(f).includes('[x] 1) Apples') && stripAnsi(f).includes('[ ] 2) Beans'));
    await screen.press('enter');
    await screen.waitForFrame((f) => stripAnsi(f).includes('sent; the agent continues'));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: `/questions/${Q}/answer`, body: { outcome: 'completed', values: ['a'], channel: 'tui' } });
    screen.unmount();
  });

  it('TUI: a high-risk confirmation needs y twice; a number shows its unit', async () => {
    const { InboxScreen } = await import('./inbox.screen.js');
    const confirm: InboxItem = { ...item, questionId: '88888888-8888-4888-8888-888888888888', runId: '99999999-9999-4999-8999-999999999999', input: 'confirm', prompt: 'Pay 20?', options: null, choices: [], constraints: null, confirmLabel: 'Pay', denyLabel: 'Stop', risk: 'high' };
    const number: InboxItem = { ...item, input: 'number', prompt: 'Weight?', options: null, choices: [], constraints: { min: 0, unit: 'kg' } };
    const calls = fakeApi({ 'GET /inbox': [confirm, number], [`POST /inbox/${confirm.runId}/respond`]: { ok: true }, [`POST /questions/${Q}/answer`]: question() });
    const screen = await renderTuiScreen(InboxScreen, { columns: 100 });
    await screen.waitForFrame((f) => stripAnsi(f).includes('y Pay · n Stop'));
    await screen.press('y');
    await screen.waitForFrame((f) => stripAnsi(f).includes('press y again to Pay'));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await screen.press('y');
    await screen.waitForFrame((f) => stripAnsi(f).includes('sent; the agent continues'));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: `/inbox/${confirm.runId}/respond`, body: { outcome: 'completed', value: 'approve' } });
    await screen.press('down');
    for (const ch of '4.5') await screen.press(ch);
    await screen.waitForFrame((f) => stripAnsi(f).includes('answer: 4.5 kg'));
    await screen.press('enter');
    await screen.waitForFrame(() => calls.filter((c) => c.method === 'POST').length === 2);
    expect(calls.filter((c) => c.method === 'POST')[1]).toMatchObject({ path: `/questions/${Q}/answer`, body: { outcome: 'completed', value: '4.5', channel: 'tui' } });
    screen.unmount();
  });
});
