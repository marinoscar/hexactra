import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setConsoleApiFactory } from './console-api.js';
import { missingParameters, parseInputFlags, promptFor, promptMissing, type CliTaskParameter } from './task-inputs.js';

const params: CliTaskParameter[] = [
  { key: 'amount', label: 'Amount', type: 'money', required: true },
  { key: 'phone_number', label: 'Phone Number', type: 'phone', required: true, default: { value: '555-010-6020' } },
  { key: 'account', label: 'Account', type: 'choice', required: true, options: ['Checking', 'Savings'], help: 'Which account pays' },
  { key: 'code', label: 'Gift code', type: 'text', required: true, sensitive: true },
  { key: 'note', label: 'Note', type: 'text', required: false },
];

describe('--input (#552)', () => {
  it('parses name=value flags, keeping = in the value', () => {
    expect(parseInputFlags(['amount=25', 'Phone Number=555 010', 'memo=a=b'])).toEqual({ amount: '25', 'Phone Number': '555 010', memo: 'a=b' });
    expect(() => parseInputFlags(['amount'])).toThrow(/name=value/);
    expect(parseInputFlags(undefined)).toEqual({});
  });

  it('asks only for required values without a default, never a sensitive one, matching names as the server does', () => {
    expect(missingParameters(params, {}).map((p) => p.key)).toEqual(['amount', 'account']);
    expect(missingParameters(params, { Amount: '5' }).map((p) => p.key)).toEqual(['account']);
  });

  it('prompts once per missing value and leaves empty answers out', async () => {
    const asked: string[] = [];
    const answers = ['25', ''];
    const got = await promptMissing(missingParameters(params, {}), async (q) => (asked.push(q), answers.shift() ?? ''));
    expect(got).toEqual({ amount: '25' });
    expect(asked).toEqual(['Amount (amount): ', 'Account (one of Checking, Savings) – Which account pays: ']);
    expect(promptFor(params[0]!)).toBe('Amount (amount): ');
  });
});

describe('hexactra tasks run --input', () => {
  const T = '33333333-3333-4333-8333-333333333333';
  afterEach(() => setConsoleApiFactory(null));

  async function runCli(...args: string[]): Promise<{ out: string; calls: { method: string; path: string; body?: unknown }[] }> {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const reply = (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === 'GET' && path === '/tasks') return [{ id: T, name: 'Zelle', goal: 'Send {{Amount}}', profile: 'default', allowedDomains: [], parameters: params }];
      if (method === 'POST' && path === `/tasks/${T}/runs`) return { id: 'r1', status: 'waiting_human', goal: 'Send {{Amount}}', stepCount: 0 };
      throw new Error(`unexpected ${method} ${path}`);
    };
    setConsoleApiFactory(() => ({ get: async (p: string) => reply('GET', p), post: async (p: string, b: unknown) => reply('POST', p, b) }) as never);
    const { runsCommand } = await import('./runs.command.js');
    const program = new Command().exitOverride();
    runsCommand(program);
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
    try {
      await program.parseAsync(['node', 'hexactra', ...args]);
    } finally {
      spy.mockRestore();
    }
    return { out, calls };
  }

  it('sends every --input by name and says when the run waits for values or asks for a sensitive one in the console', async () => {
    const { out, calls } = await runCli('tasks', 'run', 'Zelle', '--input', 'amount=25', '--input', 'Phone Number=555 010 6020');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/tasks/${T}/runs`, body: { inputs: { amount: '25', 'Phone Number': '555 010 6020' } } });
    expect(out).toContain('run r1');
    expect(out).toContain('waiting for values');
    expect(out).toContain('Gift code: asked for in the console');
  });

  it('sends no inputs when none are given (and no terminal is attached to ask)', async () => {
    const { calls } = await runCli('tasks', 'run', 'Zelle');
    expect(calls.at(-1)?.body).toEqual({});
  });
});
