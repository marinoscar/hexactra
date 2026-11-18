// The bundle rules (scripts/check-bundle.mjs): the checker itself, and the
// built file when there is one (`npm run build` runs the same check in CI).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error: a plain ES module script without types
import { ALLOWED_TOOLS as SCRIPT_TOOLS, BUDGET_BYTES, checkHtml } from '../scripts/check-bundle.mjs';
import { ALLOWED_TOOLS } from '../src/model';

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

  it('allows the same tools as the card', () => {
    expect([...SCRIPT_TOOLS].sort()).toEqual([...ALLOWED_TOOLS].sort());
  });

  const built = join(__dirname, '..', 'dist', 'run-card.html');
  it.runIf(existsSync(built))('the built run card is one file within budget, with no external URL and only allowed tool names', () => {
    const r = checkHtml(readFileSync(built, 'utf8'));
    expect(r.problems).toEqual([]);
    expect(r.size).toBeLessThanOrEqual(300 * 1024);
  });
});
