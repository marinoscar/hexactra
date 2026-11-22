// E46.15–E46.16: the ladder's order and limits with scripted strategies, and the executor retrying a step it recovered.
import { executeProcedure, RecoveryLadder, type RecoveryStrategy, type Rung } from '../src/execute';
import { aVersion, call, fakePorts, lit, replies } from '../src/testing';

const strat = (rung: Rung, outcomes: ('recovered' | 'no')[], seen: string[]): RecoveryStrategy => ({ rung, attempt: async (f) => (seen.push(`${rung}:${f.step.id}`), outcomes.shift() ?? 'no') });
const step = (id: string, commitClass = false) => aVersion([call(id, 'click', {}, { commitClass })]).steps[0]!;

describe('RecoveryLadder', () => {
  it('tries the rungs in order, each once per step, and stops at the first that recovers', async () => {
    const seen: string[] = [];
    const ladder = new RecoveryLadder([strat('locate', ['recovered'], seen), strat('interrupts', ['no'], seen), strat('wait', ['no'], seen), strat('reresolve', ['recovered'], seen)]);
    expect(await ladder.recover({ step: step('s1'), kind: 'precondition' })).toEqual({ recovered: true, rung: 'reresolve' });
    expect(seen).toEqual(['wait:s1', 'interrupts:s1', 'reresolve:s1']);
    expect(await ladder.recover({ step: step('s1'), kind: 'precondition' })).toEqual({ recovered: true, rung: 'locate' });
    expect(await ladder.recover({ step: step('s1'), kind: 'precondition' })).toEqual({ recovered: false });
  });
  it('a commit-class step never uses the model rung, and is never retried after its call was sent', async () => {
    const seen: string[] = [];
    const ladder = new RecoveryLadder([strat('locate', ['recovered'], seen)]);
    expect(await ladder.recover({ step: step('pay', true), kind: 'precondition' })).toEqual({ recovered: false });
    expect(await new RecoveryLadder([strat('wait', ['recovered'], seen)]).recover({ step: step('pay', true), kind: 'failed_check' })).toEqual({ recovered: false });
    expect(seen).toEqual([]);
  });
  it('at most 3 model-located steps per run', async () => {
    const seen: string[] = [];
    const ladder = new RecoveryLadder([strat('locate', ['recovered', 'recovered', 'recovered', 'recovered'], seen)]);
    for (const id of ['a', 'b', 'c']) expect((await ladder.recover({ step: step(id), kind: 'precondition' })).recovered).toBe(true);
    expect((await ladder.recover({ step: step('d'), kind: 'precondition' })).recovered).toBe(false);
  });
  it('a strategy that throws is a no', async () => {
    const ladder = new RecoveryLadder([{ rung: 'wait', attempt: async () => { throw new Error('x'); } }]);
    expect(await ladder.recover({ step: step('s1'), kind: 'precondition' })).toEqual({ recovered: false });
  });
});

describe('the executor with a ladder', () => {
  it('retries a step after a rung recovers, and records which rung', async () => {
    const ports = fakePorts();
    ports.tools.on('click', { ok: false, text: 'not ready', digest: 'element:not_found' }, replies.ok());
    const seen: string[] = [];
    const r = await executeProcedure(aVersion([call('c1', 'click', { selector: lit('#go') })]), {}, ports, { goal: 'g', recovery: new RecoveryLadder([strat('interrupts', ['recovered'], seen)]) });
    expect(r.status).toBe('completed');
    expect(r.steps.at(-1)).toMatchObject({ step: 'c1', status: 'done', recoveredBy: 'interrupts' });
    expect(ports.tools.calls).toHaveLength(2);
  });
  it('stops when no rung recovers', async () => {
    const ports = fakePorts();
    ports.tools.on('click', { ok: false, text: 'not ready', digest: 'element:not_found' });
    const r = await executeProcedure(aVersion([call('c1', 'click', { selector: lit('#go') })]), {}, ports, { goal: 'g', recovery: new RecoveryLadder([]) });
    expect(r.status).toBe('failed_check');
  });
});
