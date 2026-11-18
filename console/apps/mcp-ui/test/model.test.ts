// The card's pure rules: reading tool results, states, the budget meter, links, supersession order.
import { describe, expect, it } from 'vitest';

import { ALLOWED_TOOLS, budgetMeter, cardState, inboxUrl, safeUrl, shortGoal, snapshotOf } from '../src/model';
import { isYounger } from '../src/supersede';
import { PNG, RUN_ID, progress, result, waitResult } from './fixtures';

describe('snapshotOf', () => {
  it('reads a run with its progress block, the image and the card key', () => {
    const s = snapshotOf(result('running', { image: true, key: { created_at: 5, seq: 2 } }))!;
    expect(s.progress).toMatchObject({ run_id: RUN_ID, status: 'running', cursor: 'cur-running' });
    expect(s.run).toMatchObject({ id: RUN_ID, goal: 'Book a table for two at eight', policy: { name: 'Balanced' } });
    expect(s.image).toEqual({ data: PNG, mimeType: 'image/png' });
    expect(s.key).toEqual({ created_at: 5, seq: 2 });
  });

  it('reads a bare progress block (run_wait) and the JSON text of a host that drops structuredContent', () => {
    expect(snapshotOf(waitResult('queued'))!.run).toBeUndefined();
    const text = { content: [{ type: 'text', text: `Queued: waiting to start.\n\n${JSON.stringify(progress('queued'))}` }] };
    expect(snapshotOf(text)!.progress.status).toBe('queued');
  });

  it('ignores errors, junk and non-raster images', () => {
    expect(snapshotOf({ isError: true, structuredContent: progress('running') })).toBeUndefined();
    expect(snapshotOf({ content: [{ type: 'text', text: 'nope' }] })).toBeUndefined();
    expect(snapshotOf(null)).toBeUndefined();
    const svg = { ...result('running'), content: [{ type: 'image', data: 'PHN2Zz4=', mimeType: 'image/svg+xml' }] };
    expect(snapshotOf(svg)!.image).toBeUndefined();
  });
});

describe('cardState', () => {
  it('maps statuses and stop reasons to the eight states', () => {
    const st = (status: string, stopReason: string | null = null, extra: Record<string, unknown> = {}) => {
      const s = snapshotOf(result(status, { run: { stopReason }, progress: extra }))!;
      return cardState(s.progress, s.run);
    };
    expect(st('queued')).toBe('queued');
    expect(st('running')).toBe('running');
    expect(st('waiting_human')).toBe('waiting');
    expect(st('succeeded', 'finished')).toBe('succeeded');
    expect(st('failed', 'error')).toBe('failed');
    expect(st('cancelled', 'cancelled')).toBe('cancelled');
    expect(st('failed', 'budget_actions')).toBe('budget');
    expect(st('succeeded', 'budget_cost')).toBe('budget');
    expect(st('failed', 'stalled')).toBe('stalled');
  });
});

describe('helpers', () => {
  it('budgetMeter picks the budget closest to its limit among actions, cost and active time; null when unlimited', () => {
    expect(budgetMeter({ actions: 10, cost: 80, activeMinutes: 30, inputTokens: 99 })).toEqual({ label: 'Cost', percent: 80 });
    expect(budgetMeter({ actions: null, cost: null, activeMinutes: null })).toBeNull();
    expect(budgetMeter(undefined)).toBeNull();
    expect(budgetMeter({ actions: 140 })).toEqual({ label: 'Actions', percent: 100 });
  });

  it('opens only http(s) links and builds the inbox link on the console origin', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,x')).toBeNull();
    expect(safeUrl('https://console.example.test/runs/1')).toBe('https://console.example.test/runs/1');
    expect(inboxUrl('https://console.example.test/runs/1', 'a/b')).toBe('https://console.example.test/inbox/q/a%2Fb');
  });

  it('shortens a goal to 120 characters', () => {
    expect(shortGoal('x'.repeat(200))).toEqual({ text: `${'x'.repeat(119)}…`, more: true });
    expect(shortGoal('  short   goal ')).toEqual({ text: 'short goal', more: false });
  });

  it('elects by server time, then counter, then instance id', () => {
    const a = { instanceId: 'a', key: { created_at: 1, seq: 9 } };
    const b = { instanceId: 'b', key: { created_at: 2, seq: 1 } };
    expect(isYounger(b, a)).toBe(true);
    expect(isYounger(a, b)).toBe(false);
    expect(isYounger({ instanceId: 'a', key: { created_at: 1, seq: 10 } }, a)).toBe(true);
  });

  it('calls only the run tools, and question_card_answer for the question in its banner (#467)', () => {
    expect([...ALLOWED_TOOLS].sort()).toEqual(['question_card_answer', 'run_cancel', 'run_card_poll', 'run_status', 'run_wait', 'task_run']);
  });
});
