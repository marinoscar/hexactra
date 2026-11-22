// E46.14 (#788): the replay invoker paces browser steps only, waits for the element, and never sleeps outside the two waiting files.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { procedureVersionSchema, type ToolCallRequest, type ToolInvocation } from '@marinoscar/hexactra-kgraph';
import { FakeBrowser } from '@marinoscar/hexactra-browser-agent/testing';

import { surfaceInvoker } from '../src/runner/host/kgraph/surface';

const version = procedureVersionSchema.parse({
  id: 'v1', procedure: 'p1', number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: '2026-01-01T00:00:00.000Z', entry: 'a1',
  steps: [
    { id: 'a1', kind: 'call', label: 'mail', tool: 'mail_search', args: {} },
    { id: 'b1', kind: 'call', label: 'nav', tool: 'navigate', args: {} },
    { id: 'b2', kind: 'call', label: 'click', tool: 'click', element: 'el:1', args: { selector: { kind: 'literal', value: '#old' } } },
    { id: 'a2', kind: 'call', label: 'sheet', tool: 'sheet_append', args: {} },
  ],
  screens: [{ id: 'sc:1', site: 'site:example.com', label: 'x' }],
  elements: [{ id: 'el:1', screen: 'sc:1', role: 'button', label: 'Search', selectors: ['#old'] }],
});
const ok: ToolInvocation = { ok: true, text: '', digest: 'd', refused: false, stopped: false, paused: false };

function setup(pacing: 'human' | 'fast') {
  const browser = new FakeBrowser();
  browser.surface = [{ selector: '#new', selectors: ['#new'], role: 'button', name: 'Search', tag: null, inputType: null, anchor: null }];
  const sleeps: number[] = [];
  const calls: ToolCallRequest[] = [];
  const invoker = surfaceInvoker({ invoke: async (r) => (calls.push(r), ok) }, version, browser, async () => null, {
    familyOf: (t) => (t === 'mail_search' || t === 'sheet_append' ? 'accounts' : 'browser'),
    pacing,
    location: async () => null,
    random: () => 0.5,
    sleep: async (ms) => (sleeps.push(ms), true),
  });
  const run = async (step: string, tool: string) => invoker.invoke({ tool, args: {}, step, commitClass: false });
  return { run, sleeps, calls };
}

describe('the replay invoker (E46.14)', () => {
  it('human: a gap between browser actions only, none for account steps; the element is resolved first', async () => {
    const t = setup('human');
    await t.run('a1', 'mail_search');
    await t.run('b1', 'navigate');
    await t.run('b2', 'click');
    await t.run('a2', 'sheet_append');
    // One paced gap: before the click (after a navigation). The account steps and the first browser step get none.
    expect(t.sleeps).toEqual([2100]);
    expect(t.calls.find((c) => c.step === 'b2')!.args).toEqual({ selector: '#new' });
  });
  it('fast: no pacing at all', async () => {
    const t = setup('fast');
    await t.run('b1', 'navigate');
    await t.run('b2', 'click');
    expect(t.sleeps.every((ms) => ms === 0)).toBe(true);
  });
});

describe('no fixed sleeps in replay code', () => {
  const roots = [join(__dirname, '..', 'src', 'runner', 'host', 'kgraph'), join(__dirname, '..', 'src', 'kgraph'), join(__dirname, '..', '..', '..', 'packages', 'hexactra-kgraph', 'src'), join(__dirname, '..', '..', '..', 'packages', 'hexactra-browser-agent', 'src', 'surface')];
  const allowed = ['pacing.ts', 'conditions.ts'];
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
  it('only pacing.ts and conditions.ts wait', () => {
    const offenders = roots.flatMap(walk).filter((f) => !allowed.some((a) => f.endsWith(a)) && /\bsetTimeout\s*\(|\bsetInterval\s*\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
