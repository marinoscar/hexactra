// The facts of a TEST send (E39.6, #603): invented sample values built from the task's own output definitions, marked as a test. A test
// never reads a real run, so it can never leak one, and never touches one.
import { MASKED_OUTPUT, formatOutputValue, type OutputValue } from '@app/shared/task-fields';

import type { TaskOutput } from '../tasks/task-outputs.schemas';
import type { FactOutput, RunFacts } from './delivery-facts';

const SAMPLE_RUN_ID = '00000000-0000-4000-8000-000000000000';

/** One invented value of the output's type. */
export function sampleValue(def: Pick<TaskOutput, 'type' | 'options'>): Exclude<OutputValue, null> {
  switch (def.type) {
    case 'number':
      return 42;
    case 'money':
      return { amount: 12.34, currency: 'USD' };
    case 'date':
      return '2026-01-31';
    case 'datetime':
      return '2026-01-31T09:30:00Z';
    case 'boolean':
      return true;
    case 'url':
      return 'https://example.test/sample';
    case 'choice':
      return def.options?.[0] ?? 'Option A';
    default:
      return 'Sample text';
  }
}

export function sampleFacts(userId: string, task: { id: string; name: string; outputs: TaskOutput[] }, now = new Date()): RunFacts {
  const outputs: FactOutput[] | null = task.outputs.length
    ? task.outputs.map((def) => {
        const v = sampleValue(def);
        const text = formatOutputValue(def, v);
        const cell = typeof v === 'object' ? text : v;
        return {
          key: def.key,
          label: def.label,
          type: def.type,
          required: def.required !== false,
          sensitive: def.sensitive === true,
          masked: def.sensitive ? MASKED_OUTPUT : v,
          text: def.sensitive ? MASKED_OUTPUT : text,
          ...(def.sensitive ? { rawText: 'sample sensitive value', rawValue: 'sample sensitive value', rawCell: 'sample sensitive value' } : {}),
          maskedCell: def.sensitive ? MASKED_OUTPUT : cell,
          ok: true,
          note: null,
        };
      })
    : null;
  return {
    runId: SAMPLE_RUN_ID,
    userId,
    taskId: task.id,
    taskName: `[TEST] ${task.name}`,
    goal: 'A sample run, to test this delivery.',
    trigger: 'manual',
    status: 'succeeded',
    result: 'This is a sample result. No run was sent.',
    error: null,
    createdAt: now,
    finishedAt: now,
    costUsd: 0,
    costKnown: true,
    stepCount: 0,
    confirmedActions: 0,
    outputs,
    outputsComplete: outputs ? true : null,
    scheduleId: null,
  };
}
