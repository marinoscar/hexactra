// Task outputs (E39.5, #600): the API's definitions, the views that mask them, and the agent's side
// (the finish schema, the instructions section, what finish does with the values). Pure; the db tier
// runs them against a real run (task-outputs.db.spec.ts, runner.db.spec.ts).
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { TaskOutput } from '@app/shared/task-fields';

import { INSTRUCTIONS } from '../src/runner/goal-runner.service';
import { decideOutputs, finishParameters, instructionsWithOutputs, scrubSensitive } from '../src/runner/outputs';
import { maskedOutputValue, outputsSpecOf, outputsView, prepareOutputs } from '../src/tasks/task-outputs';
import { taskOutputsField } from '../src/tasks/task-outputs.schemas';
import { runWebhookSchema } from '../src/platform/webhooks/hexactra.webhook-events';

const MARKER = 'SECRET-OUT-4417-zq';
const spec: TaskOutput[] = [
  { key: 'confirmation_number', label: 'Confirmation number', type: 'text', required: true, help: 'Shown after the payment' },
  { key: 'amount_paid', label: 'Amount paid', type: 'money', required: true },
  { key: 'paid_on', label: 'Paid on', type: 'date', required: true },
  { key: 'status', label: 'Status', type: 'choice', required: false, options: ['Paid', 'Pending'] },
  { key: 'account', label: 'Account', type: 'text', required: false, sensitive: true },
];

function code(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadRequestException) return e.getResponse() as { code?: string };
  }
  return {};
}

describe('output definitions', () => {
  it('derives keys from labels, suffixing a derived key that is taken', () => {
    const out = prepareOutputs([
      { label: 'Confirmation number', type: 'text', required: true },
      { label: 'Confirmation Number', type: 'number', required: true },
      { key: 'balance', label: 'Remaining balance', type: 'money', required: false },
    ]);
    expect(out.map((o) => o.key)).toEqual(['confirmation_number', 'confirmation_number_2', 'balance']);
    expect(out[2]).toEqual({ key: 'balance', label: 'Remaining balance', type: 'money', required: false });
  });

  it('refuses a duplicate explicit key, a bad key, a choice without options and more than 30', () => {
    expect(code(() => prepareOutputs([{ key: 'a', label: 'A', type: 'text', required: true }, { key: 'a', label: 'B', type: 'text', required: true }]))).toMatchObject({ code: 'INVALID_OUTPUTS' });
    expect(code(() => prepareOutputs([{ key: 'Not Snake', label: 'A', type: 'text', required: true }]))).toMatchObject({ code: 'INVALID_OUTPUTS' });
    expect(code(() => prepareOutputs([{ label: 'A', type: 'choice', required: true }]))).toMatchObject({ code: 'INVALID_OUTPUTS' });
    expect(taskOutputsField.safeParse(Array.from({ length: 31 }, (_, i) => ({ label: `L${i}`, type: 'text' }))).success).toBe(false);
    expect(taskOutputsField.safeParse(Array.from({ length: 30 }, (_, i) => ({ label: `L${i}`, type: 'text' }))).success).toBe(true);
  });

  it('defaults a definition to required text and rejects unknown fields', () => {
    const parsed = taskOutputsField.parse([{ label: 'Amount' }]);
    expect(parsed[0]).toMatchObject({ label: 'Amount', type: 'text', required: true });
    expect(taskOutputsField.safeParse([{ label: 'A', color: 'red' }]).success).toBe(false);
    expect(taskOutputsField.safeParse([{ label: 'A', type: 'matrix' }]).success).toBe(false);
  });

  it('copies a task’s outputs to a run, none as null', () => {
    expect(outputsSpecOf(null)).toBeNull();
    expect(outputsSpecOf([])).toBeNull();
    expect(outputsSpecOf(spec)).toEqual(spec);
  });
});

describe('the view of a run’s outputs', () => {
  const stored = {
    confirmation_number: { value: 'C-1', ok: true },
    amount_paid: { value: { amount: 25.5, currency: 'USD' }, ok: true },
    paid_on: { value: null, ok: false, note: 'Not found' },
    account: { value: MARKER, ok: true },
  };

  it('joins the run’s own definitions with the values and hides a sensitive one', () => {
    const view = outputsView(spec, stored)!;
    expect(view.map((v) => v.key)).toEqual(['confirmation_number', 'amount_paid', 'paid_on', 'status', 'account']);
    expect(view[0]).toMatchObject({ label: 'Confirmation number', type: 'text', required: true, sensitive: false, value: 'C-1', ok: true, note: null });
    expect(view[1]!.value).toEqual({ amount: 25.5, currency: 'USD' });
    expect(view[2]).toMatchObject({ value: null, ok: false, note: 'Not found' });
    // Not stored at all, on a finished run: not found. Optional and never given.
    expect(view[3]).toMatchObject({ value: null, ok: false, note: 'Not found' });
    expect(view[4]).toMatchObject({ sensitive: true, value: '[hidden]' });
    expect(JSON.stringify(view)).not.toContain(MARKER);
  });

  it('is null for a run without outputs, and says nothing is missing yet while the run is live', () => {
    expect(outputsView(null, null)).toBeNull();
    expect(outputsView([], {})).toBeNull();
    expect(outputsView(spec, null, false)!.every((v) => v.note === null && v.value === null)).toBe(true);
  });

  it('masks text like the rest of the trace', () => {
    expect(maskedOutputValue({}, '4111 1111 1111 1111')).not.toContain('4111 1111 1111 1111');
    expect(maskedOutputValue({ sensitive: true }, 'anything')).toBe('[hidden]');
    expect(maskedOutputValue({ sensitive: true }, null)).toBeNull();
    expect(maskedOutputValue({}, 12)).toBe(12);
  });
});

describe('the finish tool’s schema', () => {
  const plain = z.toJSONSchema(z.object({ success: z.boolean(), result: z.string().min(1).max(4000) }));

  it('is today’s schema for a task without outputs', () => {
    expect(z.toJSONSchema(finishParameters([]))).toEqual(plain);
  });

  it('lists exactly the task’s keys, typed from the definitions', () => {
    const json = z.toJSONSchema(finishParameters(spec)) as { properties: Record<string, { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }> };
    const outputs = json.properties.outputs!;
    expect(Object.keys(outputs.properties!)).toEqual(spec.map((s) => s.key));
    expect(outputs.required).toEqual(spec.map((s) => s.key));
    expect(outputs.additionalProperties).toBe(false);
    expect(JSON.stringify(outputs.properties!.amount_paid)).toMatch(/number/);
    expect(JSON.stringify(outputs.properties!.paid_on)).toMatch(/string/);
    expect(JSON.stringify(outputs.properties!.confirmation_number)).toContain('Shown after the payment');
    expect(Object.keys(json.properties)).toEqual(['success', 'result', 'outputs']);
  });

  it('parses a model’s arguments and lets a bad value through to the server’s own check', () => {
    const schema = finishParameters(spec);
    expect(schema.safeParse({ success: true, result: 'ok', outputs: { confirmation_number: 'C-1', amount_paid: 'ten dollars', paid_on: null, status: null, account: null } }).success).toBe(true);
    expect(schema.safeParse({ success: true, result: 'ok', outputs: { confirmation_number: 'C-1' } }).success).toBe(false);
  });
});

describe('the instructions of a run with outputs', () => {
  it('are the shared ones when the task has none', () => {
    expect(instructionsWithOutputs(INSTRUCTIONS, [])).toBe(INSTRUCTIONS);
  });

  it('add one section listing label, type and help, and are the same every time (the stable prefix)', () => {
    const a = instructionsWithOutputs(INSTRUCTIONS, spec);
    expect(a.startsWith(INSTRUCTIONS)).toBe(true);
    expect(a).toContain('Outputs to return:');
    expect(a).toContain('- confirmation_number (Confirmation number): text, required. Shown after the payment');
    expect(a).toContain('- status (Status): choice, optional. One of: Paid, Pending.');
    expect(a).toContain('private: never repeat it in the result');
    expect(a).toMatch(/give null and say why in the result/);
    expect(instructionsWithOutputs(INSTRUCTIONS, spec)).toBe(a);
  });
});

describe('what finish does with the values', () => {
  const good = { confirmation_number: 'C-1', amount_paid: '$25.00', paid_on: 'March 25, 2026', status: 'Paid', account: MARKER };

  it('stores every value and is complete', () => {
    const d = decideOutputs(spec, good, { attempts: 0, final: false });
    expect(d.refusal).toBeNull();
    expect(d.complete).toBe(true);
    expect(d.fields.amount_paid).toEqual({ value: { amount: 25, currency: 'USD' }, ok: true });
    expect(d.fields.paid_on).toEqual({ value: '2026-03-25', ok: true });
  });

  it('refuses a missing required value and a value that does not parse, naming each', () => {
    const d = decideOutputs(spec, { amount_paid: 'ten dollars', paid_on: 'soon' }, { attempts: 0, final: false });
    expect(d.refusal).toContain('`confirmation_number` is required');
    expect(d.refusal).toContain("`amount_paid` is not an amount of money: 'ten dollars'");
    expect(d.problemKeys).toEqual(['confirmation_number', 'amount_paid', 'paid_on']);
  });

  it('asks twice at most; the third time, and a failure or the wrap-up, take what there is', () => {
    const bad = { amount_paid: 'ten dollars' };
    expect(decideOutputs(spec, bad, { attempts: 1, final: false }).refusal).toContain('last time');
    const third = decideOutputs(spec, bad, { attempts: 2, final: false });
    expect(third.refusal).toBeNull();
    expect(third.complete).toBe(false);
    expect(third.fields.amount_paid).toEqual({ value: null, ok: false, note: 'Not an amount of money' });
    expect(decideOutputs(spec, bad, { attempts: 0, final: true }).refusal).toBeNull();
  });

  it('keeps a sensitive value out of the result text', () => {
    expect(scrubSensitive(`Paid. Account ${MARKER} charged.`, spec, good)).toBe('Paid. Account [hidden] charged.');
    expect(scrubSensitive('Paid.', spec, good)).toBe('Paid.');
    expect(scrubSensitive(`x ab y`, [{ key: 'k', label: 'K', type: 'text', required: true, sensitive: true }], { k: 'ab' })).toBe('x ab y');
  });
});

describe('the runs.run.finished webhook', () => {
  const run = { runId: '00000000-0000-4000-8000-000000000001', taskId: null, goal: 'g', trigger: 'manual', status: 'succeeded', result: 'ok' };
  it('validates with and without outputs', () => {
    expect(runWebhookSchema.safeParse(run).success).toBe(true);
    const outputs = outputsView(spec, { confirmation_number: { value: 'C-1', ok: true }, account: { value: MARKER, ok: true } })!;
    const withOutputs = runWebhookSchema.safeParse({ ...run, outputs });
    expect(withOutputs.success).toBe(true);
    expect(JSON.stringify(withOutputs.data)).not.toContain(MARKER);
    expect(runWebhookSchema.safeParse({ ...run, outputs: [{ key: 'x' }] }).success).toBe(false);
  });
});

describe('the save-as-task draft proposes outputs', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseDraft, draftOutputDefinitions } = require('../src/chat/chat-task-draft.service') as typeof import('../src/chat/chat-task-draft.service');

  it('reads outputs from the model’s answer, keeps types it knows, and turns a choice into text', () => {
    const draft = parseDraft(
      JSON.stringify({
        name: 'Pay rent',
        goal: 'Pay the rent',
        outputs: [{ label: 'Confirmation number', type: 'text', help: 'On the receipt' }, { label: 'Amount paid', type: 'money' }, { label: 'Status', type: 'choice' }, { label: '', type: 'text' }, { type: 'text' }],
      }),
    )!;
    expect(draft.outputs).toEqual([
      { label: 'Confirmation number', type: 'text', help: 'On the receipt' },
      { label: 'Amount paid', type: 'money' },
      { label: 'Status', type: 'text' },
    ]);
    expect(draftOutputDefinitions(draft.outputs!).map((o) => o.key)).toEqual(['confirmation_number', 'amount_paid', 'status']);
  });

  it('proposes none when the answer has none, never marks one sensitive, and drops duplicates', () => {
    expect(parseDraft('{"name":"x","goal":"y"}')!.outputs).toBeUndefined();
    const defs = draftOutputDefinitions([
      { label: 'Amount', type: 'money' },
      { label: 'amount', type: 'text' },
    ]);
    expect(defs).toHaveLength(1);
    expect(defs.every((d) => d.sensitive === undefined && d.required)).toBe(true);
  });
});
