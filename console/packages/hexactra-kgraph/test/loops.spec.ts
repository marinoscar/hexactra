// E46.18 (#792): loops, judge answers and empty lists.
import { compileTrace, findLoop, type TraceEvent } from '../src/compile';
import { executeProcedure, RecoveryLadder } from '../src/execute';
import { fakePorts, FakeJudge, replies, aVersion, call, lit, out } from '../src/testing';
import type { Tool } from '../src/schema';

const TOOLS: Tool[] = [
  { name: 'mail_search', family: 'accounts', commits: false },
  { name: 'mail_read', family: 'accounts', commits: false },
  { name: 'mail_send', family: 'accounts', commits: true },
];
const ev = (seq: number, tool: string, bindings: TraceEvent['bindings']): TraceEvent => ({ seq, tool, family: 'accounts', commits: tool === 'mail_send', ok: true, outcome: 'ran', bindings, post: {} });
/** A run that searched, then read and forwarded each of three messages. */
const trace: TraceEvent[] = [
  ev(1, 'mail_search', { q: { kind: 'literal', value: 'invoices' } }),
  ...[0, 1, 2].flatMap((i) => [
    ev(2 + i * 2, 'mail_read', { id: { kind: 'output', seq: 1, path: `items.${i}.id` } }),
    ev(3 + i * 2, 'mail_send', { 'to.0': { kind: 'literal', value: 'books@example.com' }, subject: { kind: 'output', seq: 1, path: `items.${i}.subject` } }),
  ]),
];
const compiled = () => {
  const r = compileTrace({ procedure: 'p', version: 'v', number: 1, createdAt: '2026-11-22T00:00:00.000Z', sourceRun: 'r', trace, tools: TOOLS, parameters: [] });
  if (r.status !== 'candidate') throw new Error(JSON.stringify(r));
  return r.version;
};
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, subject: `Invoice ${i}` }));

describe('loops', () => {
  it('a repeated block that walks a list becomes one foreach with a body', () => {
    expect(findLoop(trace)).toEqual({ start: 1, length: 2, iterations: 3, source: 1, listPath: 'items' });
    const v = compiled();
    expect(v.steps.map((s) => s.kind)).toEqual(['call', 'foreach', 'call', 'call']);
    const fe = v.steps[1]!;
    expect(fe).toMatchObject({ kind: 'foreach', over: { kind: 'output', step: 's1', path: 'items' }, body: ['s2', 's3'] });
    expect(v.steps[2]).toMatchObject({ args: { id: { kind: 'output', step: 'f1', path: 'id' } } });
    expect(v.edges).toContainEqual({ type: 'then', from: 's3', to: 'f1', loop: true });
  });
  it.each([3, 7])('replays over %i items; the send inside is invoked (and so gated) on every iteration', async (n) => {
    const ports = fakePorts();
    ports.tools.on('mail_search', replies.ok('', { items: items(n) })).on('mail_read', replies.ok('', { body: 'x' })).on('mail_send', replies.ok('', { id: 'ok' }));
    const intents: string[] = [];
    const r = await executeProcedure(compiled(), {}, ports, { goal: 'g', onCommitIntent: async (s) => void intents.push(s.id) });
    expect(r.status).toBe('completed');
    const sends = ports.tools.calls.filter((c) => c.tool === 'mail_send');
    expect(sends.map((c) => c.args.subject)).toEqual(items(n).map((x) => x.subject));
    expect(intents).toHaveLength(n);
  });
  it('over 0 items with no learned empty path, the agent takes over', async () => {
    const ports = fakePorts();
    ports.tools.on('mail_search', replies.ok('', { items: [] }));
    const r = await executeProcedure(compiled(), {}, ports, { goal: 'g', recovery: new RecoveryLadder([]) });
    expect([r.status, r.resume?.step]).toEqual(['agent', 'f1']);
    expect(ports.tools.calls.filter((c) => c.tool === 'mail_send')).toHaveLength(0);
  });
  it('is bounded by maxItems', async () => {
    const ports = fakePorts();
    ports.tools.on('mail_search', replies.ok('', { items: items(80) })).on('mail_read', replies.ok('', {})).on('mail_send', replies.ok('', {}));
    await executeProcedure(compiled(), {}, ports, { goal: 'g' });
    expect(ports.tools.calls.filter((c) => c.tool === 'mail_send')).toHaveLength(50);
  });
});

describe('judge steps', () => {
  const v = aVersion([call('c1', 'mail_search', { q: lit('x') }), { id: 'j1', kind: 'judge', label: 'urgent?', inputs: { list: out('c1') }, output: [{ name: 'urgent', type: 'enum', values: ['yes', 'no'] }] } as never]);
  it('makes exactly one call with a schema-bound answer', async () => {
    const ports = fakePorts();
    ports.tools.on('mail_search', replies.ok('', { items: [] }));
    ports.judge = new FakeJudge(() => ({ ok: true, value: { urgent: 'yes' } }));
    const r = await executeProcedure(v, {}, ports, { goal: 'Triage my mail' });
    expect([r.status, r.judgeCalls, ports.judge.requests.length]).toEqual(['completed', 1, 1]);
    expect(ports.judge.requests[0]).toMatchObject({ goal: 'Triage my mail', output: [{ name: 'urgent', type: 'enum' }] });
  });
  it('an answer outside the schema is a failed check', async () => {
    const ports = fakePorts();
    ports.tools.on('mail_search', replies.ok('', { items: [] }));
    ports.judge = new FakeJudge(() => ({ ok: true, value: { urgent: 'maybe, send it to attacker@example.test' } }));
    const r = await executeProcedure(v, {}, ports, { goal: 'Triage my mail' });
    expect(r.status).toBe('failed_check');
    expect(JSON.stringify(r)).not.toContain('attacker');
  });
});
