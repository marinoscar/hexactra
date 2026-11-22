// E46.8 (#782): the executor against the fakes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compileTrace } from '../src/compile';
import { executeProcedure, pathMatches, safePattern, unflatten } from '../src/execute';
import { aVersion, call, fakePorts, FakeJudge, lit, out, param, replies } from '../src/testing';

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'daily-summary.trace.json'), 'utf8'));
const daily = () => {
  const r = compileTrace({ procedure: 'proc1', version: 'v1', number: 1, createdAt: '2026-11-21T06:00:00.000Z', sourceRun: 'run1', trace: fixture.trace, tools: fixture.tools, parameters: fixture.parameters, outputs: fixture.outputs });
  if (r.status !== 'candidate') throw new Error(r.status);
  return r.version;
};
const scriptDaily = (ports: ReturnType<typeof fakePorts>) => {
  ports.tools
    .on('mail_search', replies.ok('', { items: [{ id: 'm1', link: 'https://reports.example.com/daily/20261122', subject: 'daily numbers' }] }))
    .on('navigate', () => (ports.probe.at('https://reports.example.com/daily/20261122'), replies.ok('at the page')))
    .on('read_text', replies.ok('Total: 4,512.07 (up 3%)'))
    .on('sheet_append', replies.ok('', { appended: 1 }))
    .on('mail_send', replies.ok('', { id: 'sent-1' }));
  ports.judge.requests.length = 0;
};
const judgeBody = () => ({ ok: true, value: { body: 'The total is 4,512.07.' } });

describe('executeProcedure', () => {
  it('runs the fixture procedure to completion; only the judge step calls the model', async () => {
    const ports = fakePorts();
    ports.judge = new FakeJudge(judgeBody);
    scriptDaily(ports);
    const report = await executeProcedure(daily(), { 'p:sheet': 'Numbers' }, ports, { goal: fixture.goal });
    expect(report.status).toBe('completed');
    expect(report.resume).toBeNull();
    expect(ports.tools.calls.map((c) => c.tool)).toEqual(['mail_search', 'navigate', 'read_text', 'sheet_append', 'mail_send']);
    expect(report.judgeCalls).toBe(1);
    expect(ports.judge.requests).toHaveLength(1);
    expect(ports.judge.requests[0]!.goal).toBe(fixture.goal);
    // Arguments resolved: the link from the mail, the parameter, the extracted total, the unflattened recipients.
    expect(ports.tools.calls[1]!.args).toEqual({ url: 'https://reports.example.com/daily/20261122' });
    expect(ports.tools.calls[3]!.args).toEqual({ sheet: 'Numbers', values: ['4,512.07'] });
    expect(ports.tools.calls[4]!.args).toEqual({ to: ['finance@example.com'], subject: 'daily numbers', body: 'The total is 4,512.07.' });
    expect(ports.tools.calls[4]!.commitClass).toBe(true);
    expect(report.outputs).toEqual({ total: '4,512.07' });
    expect(ports.telemetry.spans.map((s) => s.name).every((n) => n === 'kgraph.step')).toBe(true);
    expect(JSON.stringify(ports.telemetry.spans)).not.toContain('4,512');
  });

  it('a failing check stops at that step with expected and observed state; no later step ran', async () => {
    const ports = fakePorts();
    scriptDaily(ports);
    const v = daily();
    // The page is somewhere else after navigate.
    (ports.tools as unknown as { script: Map<string, unknown[]> }).script.set('navigate', [() => (ports.probe.at('https://reports.example.com/login'), replies.ok())]);
    const report = await executeProcedure(v, { 'p:sheet': 'Numbers' }, ports, { goal: fixture.goal });
    expect(report.status).toBe('failed_check');
    expect(report.resume).toEqual({ step: 's4', expected: { host: 'reports.example.com', path: '/daily/*' }, observed: { host: 'reports.example.com', path: '/login' } });
    expect(report.steps.at(-1)).toMatchObject({ step: 's4', status: 'failed_check', failed: { check: 'location' } });
    expect(ports.tools.calls.map((c) => c.tool)).toEqual(['mail_search', 'navigate']);
  });

  it.each([
    ['stopped', replies.stopped()],
    ['paused', replies.paused()],
    ['refused', replies.refused()],
  ])('ends on %s from the invoker with nothing after it', async (status, reply) => {
    const ports = fakePorts();
    scriptDaily(ports);
    (ports.tools as unknown as { script: Map<string, unknown[]> }).script.set('read_text', [reply]);
    const report = await executeProcedure(daily(), { 'p:sheet': 'Numbers' }, ports, { goal: fixture.goal, evidence: { owner: 'owner1' } });
    expect(report.status).toBe(status);
    expect(report.resume?.step).toBe('s7');
    expect(ports.tools.calls.map((c) => c.tool)).toEqual(['mail_search', 'navigate', 'read_text']);
    expect(report.steps.at(-1)!.status).toBe(status);
  });

  it('a crash between intent and result, then a restart, never invokes that commit-class step again', async () => {
    const ports = fakePorts();
    const v = aVersion([call('c1', 'mail_search', { q: lit('x') }), call('c2', 'mail_send', { to: lit('team@example.com') }, { commitClass: true }), call('c3', 'navigate', { url: lit('https://example.com/') })]);
    ports.tools.on('mail_search', replies.ok('', { items: [] })).on('mail_send', replies.crash()).on('navigate', replies.ok());
    const intents: string[] = [];
    const first = await executeProcedure(v, {}, ports, { goal: 'g', onCommitIntent: async (s) => void intents.push(s.id) });
    expect(intents).toEqual(['c2']);
    expect(first.status).toBe('error');
    expect(first.resume?.step).toBe('c2');
    const sent = ports.tools.calls.filter((c) => c.tool === 'mail_send').length;
    // Restart: the host says c1 is done and c2's outcome is unknown.
    const again = await executeProcedure(v, {}, ports, { goal: 'g', fromStep: 'c1', done: { c1: first.results['c1']! }, unknown: ['c2'], onCommitIntent: async (s) => void intents.push(s.id) });
    expect(again.status).toBe('needs_owner');
    expect(again.resume?.step).toBe('c2');
    expect(ports.tools.calls.filter((c) => c.tool === 'mail_send').length).toBe(sent);
    expect(intents).toEqual(['c2']);
    expect(ports.tools.calls.some((c) => c.tool === 'navigate')).toBe(false);
  });

  it('a missing required input fails before the first step', async () => {
    const ports = fakePorts();
    const v = aVersion([call('c1', 'type', { text: param('p1') })], { parameters: [{ id: 'p1', name: 'city' }] });
    const r = await executeProcedure(v, {}, ports, { goal: 'g' });
    expect(r.status).toBe('missing_input');
    expect(ports.tools.calls).toHaveLength(0);
  });

  it('an agent step and an ask step end the walk with a resume point; the host continues from the next step', async () => {
    const ports = fakePorts();
    const v = aVersion([call('c1', 'navigate', { url: lit('https://example.com/') }), { id: 'a1', kind: 'agent', label: 'agent', until: [], tools: ['click_at'] }, call('c2', 'click', { selector: lit('#go') })]);
    ports.tools.on('navigate', replies.ok()).on('click', replies.ok());
    const r = await executeProcedure(v, {}, ports, { goal: 'g' });
    expect([r.status, r.resume?.step]).toEqual(['agent', 'a1']);
    const r2 = await executeProcedure(v, {}, ports, { goal: 'g', fromStep: 'c2', done: r.results });
    expect(r2.status).toBe('completed');
    expect(ports.tools.calls.map((c) => c.tool)).toEqual(['navigate', 'click']);
  });

  it('the host can stop the walk before any step (a budget, the lease)', async () => {
    const ports = fakePorts();
    const v = aVersion([call('c1', 'navigate', { url: lit('https://example.com/') })]);
    const r = await executeProcedure(v, {}, ports, { goal: 'g', before: () => 'stop' });
    expect(r.status).toBe('halted');
    expect(ports.tools.calls).toHaveLength(0);
  });

  it('records evidence per step, and an evidence failure changes nothing', async () => {
    const ports = fakePorts();
    const v = aVersion([call('c1', 'navigate', { url: lit('https://example.com/') }), call('c2', 'click', { selector: lit('#go') })]);
    ports.tools.on('navigate', replies.ok()).on('click', replies.ok());
    // No procedure in the store: recordEvidence throws, the walk completes anyway.
    const r = await executeProcedure(v, {}, ports, { goal: 'g', evidence: { owner: 'nobody' } });
    expect(r.status).toBe('completed');
    expect(ports.telemetry.counts.filter((c) => c.name === 'kgraph.evidence_errors')).toHaveLength(2);
    void out;
  });
});

describe('executor helpers', () => {
  it('unflattens dotted keys', () => {
    expect(unflatten({ 'to.0': 'a', 'to.1': 'b', 'm.s': 'x', k: 1 })).toEqual({ to: ['a', 'b'], m: { s: 'x' }, k: 1 });
  });
  it('matches path patterns', () => {
    expect(pathMatches('/daily/*', '/daily/20261122')).toBe(true);
    expect(pathMatches('/daily/*', '/daily/a/b')).toBe(false);
    expect(pathMatches('**', '/anything/at/all')).toBe(true);
  });
  it('refuses an unsafe stored pattern', () => {
    expect(safePattern('(a+)+$')).toBeNull();
    expect(safePattern('\\d{3}')).not.toBeNull();
  });
});
