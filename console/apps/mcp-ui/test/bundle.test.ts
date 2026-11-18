// The bundle rules (scripts/check-bundle.mjs): the checker itself, and the
// built file when there is one (`npm run build` runs the same check in CI).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error: a plain ES module script without types
import { ALLOWED_TOOLS as SCRIPT_TOOLS, BUDGET_BYTES, WIDGETS, checkHtml } from '../scripts/check-bundle.mjs';
import { ALLOWED_TOOLS } from '../src/model';
import { QUESTION_CARD_TOOLS } from '../src/question-model';
import { TASKS_CARD_TOOLS } from '../src/tasks-model';

const names = ['run_goal', 'run_status', 'run_wait', 'run_cancel', 'task_run', 'run_card_poll', 'browser_evaluate', 'policy_update'];
const ok = '<!doctype html><html><head><style>a{}</style></head><body><script type="module">callServerTool({name:"run_card_poll"})</script></body></html>';

describe('check-bundle', () => {
  it('passes a small inline page that names only allowed tools', () => {
    expect(checkHtml(ok, { names }).problems).toEqual([]);
  });

  it('refuses external scripts, styles and URLs, other tools, and an oversized file', () => {
    expect(checkHtml(ok.replace('<script type="module">', '<script src="https://cdn.example.test/x.js">'), { names }).problems.join()).toMatch(/script src.*external URLs/s);
    expect(checkHtml(ok.replace('<style>', '<link rel="stylesheet" href="s.css"><style>'), { names }).problems.join()).toMatch(/link href/);
    expect(checkHtml(ok.replace('run_card_poll', 'browser_evaluate'), { names }).problems.join()).toMatch(/browser_evaluate/);
    expect(checkHtml(ok.replace('run_card_poll', 'policy_update'), { names }).problems.join()).toMatch(/policy_update/);
    expect(checkHtml(ok + ' '.repeat(BUDGET_BYTES), { names }).problems.join()).toMatch(/budget/);
  });

  it('allows each widget the same tools as its source', () => {
    expect([...SCRIPT_TOOLS].sort()).toEqual([...ALLOWED_TOOLS].sort());
    expect([...WIDGETS['question-card.html'].tools].sort()).toEqual([...QUESTION_CARD_TOOLS].sort());
    expect([...WIDGETS['tasks-card.html'].tools].sort()).toEqual([...TASKS_CARD_TOOLS].sort());
  });

  it('checks each widget against its own list and budget (#467: 250 KB for the question and tasks cards)', () => {
    const page = '<!doctype html><html><body><script type="module">callServerTool({name:"task_pause"})</script></body></html>';
    expect(checkHtml(page, { names: [...names, 'task_pause'], file: 'tasks-card.html' }).problems).toEqual([]);
    expect(checkHtml(page, { names: [...names, 'task_pause'], file: 'question-card.html' }).problems.join()).toMatch(/task_pause/);
    expect(checkHtml(page + ' '.repeat(250 * 1024), { names, file: 'tasks-card.html' }).problems.join()).toMatch(/budget/);
    expect(checkHtml(page, { names, file: 'other.html' }).problems.join()).toMatch(/not a known widget/);
  });

  for (const [file, w] of Object.entries(WIDGETS) as [string, { budget: number }][]) {
    const built = join(__dirname, '..', 'dist', file);
    it.runIf(existsSync(built))(`the built ${file} is one file within ${w.budget / 1024} KB, with no external URL and only its allowed tool names`, () => {
      const r = checkHtml(readFileSync(built, 'utf8'), { file });
      expect(r.problems).toEqual([]);
      expect(r.size).toBeLessThanOrEqual(w.budget);
    });
  }
});
