import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTaskSchema } from '../src/tasks/tasks.schemas';
import { TASK_DEFAULTS } from '../src/tasks/task-defaults';
import { RUN_BUDGET_ERRORS, RUN_BUDGET_ERROR_LIST } from '../src/runner/run-budget-errors';

describe('task defaults (#399)', () => {
  const schema = readFileSync(join(__dirname, '../prisma/schema/app.tasks.prisma'), 'utf8');
  const column = (name: string) => new RegExp(`^\\s*${name}\\s+Int\\s+@default\\((\\d+)\\)`, 'm').exec(schema)?.[1];

  it('the Prisma column defaults equal TASK_DEFAULTS', () => {
    expect(Number(column('maxSteps'))).toBe(TASK_DEFAULTS.maxSteps);
    expect(Number(column('maxMinutes'))).toBe(TASK_DEFAULTS.maxMinutes);
  });

  it('the API schema defaults equal TASK_DEFAULTS', () => {
    const t = createTaskSchema.parse({ name: 'x', goal: 'y' });
    expect(t.maxSteps).toBe(TASK_DEFAULTS.maxSteps);
    expect(t.maxMinutes).toBe(TASK_DEFAULTS.maxMinutes);
  });

  it('the runner takes its limits from the policy snapshot (no literal budget numbers left in it, #401)', () => {
    const src = readFileSync(join(__dirname, '../src/runner/goal-runner.service.ts'), 'utf8');
    expect(src).toContain('budget.maxActions ??');
    expect(src).toContain('budget.maxActiveMinutes');
    expect(src).not.toMatch(/maxSteps \?\? \d|maxMinutes \?\? \d|maxActions \?\? \d/);
  });

  it('the budget error texts the alerts match are the ones the runner writes', () => {
    expect(RUN_BUDGET_ERROR_LIST).toEqual([RUN_BUDGET_ERRORS.steps, RUN_BUDGET_ERRORS.time]);
  });
});
