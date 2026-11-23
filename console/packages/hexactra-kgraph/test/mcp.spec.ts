// E46.22 (#796): the host-neutral procedure tools. Descriptors carry what an MCP host needs (no SDK); the handlers read only the caller's own
// procedures, mask labels, mark the step list untrusted, run only an active procedure and never accept a sensitive parameter.
import { z } from 'zod';

import { PROCEDURE_TOOL_DESCRIPTORS, procedureToolHandlers, type ProcedureRunPort } from '../src/mcp';
import { aProcedure, aVersion, call, InMemoryProcedureStore, lit, param } from '../src/testing';

async function seed() {
  const store = new InMemoryProcedureStore();
  await store.putProcedure(aProcedure({ id: 'proc1', owner: 'me', task: 'task1', name: 'Export the report' }));
  await store.putVersion(
    'me',
    aVersion([call('c1', 'navigate', { url: lit('https://example.com/') }), call('c2', 'type', { text: param('p:who') }, { label: 'Type 4111111111111111' })], {
      state: 'active',
      parameters: [
        { id: 'p:who', name: 'Customer', type: 'string', sensitive: false, required: true },
        { id: 'p:pin', name: 'PIN', type: 'string', sensitive: true, required: false },
      ],
    }),
  );
  await store.putProcedure(aProcedure({ id: 'proc1', owner: 'me', task: 'task1', name: 'Export the report', activeVersion: 'v1' }));
  await store.putProcedure(aProcedure({ id: 'proc2', owner: 'me', task: 'task2', name: 'Draft only' }));
  await store.putVersion('me', aVersion([call('c1', 'navigate', { url: lit('https://example.com/') })], { id: 'v2', procedure: 'proc2' }));
  await store.putProcedure(aProcedure({ id: 'other', owner: 'someone-else', task: 'task9', name: 'Not yours' }));
  const started: unknown[] = [];
  const runs: ProcedureRunPort = {
    start: async (owner, p, inputs) => {
      started.push({ owner, task: p.task, inputs });
      return { runId: 'run-42', status: 'queued' };
    },
  };
  return { tools: procedureToolHandlers({ store, runs, taskName: async (_o, t) => `Task ${t}` }), started };
}

describe('the procedure tool descriptors', () => {
  it('declare a name, a title, an input and output object schema, an effect and open world; nothing mixes reading and writing', () => {
    expect(PROCEDURE_TOOL_DESCRIPTORS.map((d) => [d.name, d.effect, d.openWorld, d.untrusted])).toEqual([
      ['procedures_list', 'read', false, false],
      ['procedure_get', 'read', false, true],
      ['procedure_run', 'write', true, false],
    ]);
    for (const d of PROCEDURE_TOOL_DESCRIPTORS) {
      expect(d.name.length).toBeLessThanOrEqual(64);
      expect(d.title.length).toBeLessThanOrEqual(40);
      expect(d.description.length).toBeLessThanOrEqual(1024);
      const input = z.toJSONSchema(d.input, { io: 'input' }) as { type: string; properties: Record<string, { description?: string }> };
      expect(input.type).toBe('object');
      expect(Object.entries(input.properties).filter(([, p]) => !p.description)).toEqual([]);
      expect((z.toJSONSchema(d.output, { io: 'input' }) as { type: string }).type).toBe('object');
    }
  });
});

describe('the procedure tool handlers', () => {
  it('procedures_list: only the caller\'s own, with parameters, outputs, state and health; filters by state', async () => {
    const { tools } = await seed();
    const all = await tools.procedures_list('me', {});
    expect(all.structured!.procedures.map((p) => p.id).sort()).toEqual(['proc1', 'proc2']);
    const p1 = all.structured!.procedures.find((p) => p.id === 'proc1')!;
    expect(p1).toMatchObject({ task_name: 'Task task1', state: 'active', health: 'unknown', parameters: [{ name: 'Customer', sensitive: false }, { name: 'PIN', sensitive: true }] });
    expect((await tools.procedures_list('me', { state: 'active' })).structured!.procedures.map((p) => p.id)).toEqual(['proc1']);
    expect((await tools.procedures_list('someone-else', {})).structured!.procedures.map((p) => p.id)).toEqual(['other']);
  });

  it('procedure_get: masked steps, marked untrusted; another owner\'s id is not found', async () => {
    const { tools } = await seed();
    const r = await tools.procedure_get('me', { procedure_id: 'proc1' });
    expect(r.untrusted).toBe(true);
    expect(r.structured!.steps.map((s) => s.id)).toEqual(['c1', 'c2']);
    expect(JSON.stringify(r)).not.toContain('4111111111111111');
    expect((await tools.procedure_get('me', { procedure_id: 'other' })).code).toBe('NOT_FOUND');
  });

  it('procedure_run: starts a run of an active procedure\'s task at once; refuses one not active, a sensitive input and another owner\'s', async () => {
    const { tools, started } = await seed();
    const r = await tools.procedure_run('me', { procedure_id: 'proc1', inputs: { Customer: 'ACME' } });
    expect(r).toMatchObject({ ok: true, structured: { run_id: 'run-42', status: 'queued', procedure_id: 'proc1', task_id: 'task1' } });
    expect(r.structured!.follow).toContain('run_wait');
    expect(started).toEqual([{ owner: 'me', task: 'task1', inputs: { Customer: 'ACME' } }]);
    expect((await tools.procedure_run('me', { procedure_id: 'proc2' })).code).toBe('NOT_ACTIVE');
    expect((await tools.procedure_run('me', { procedure_id: 'proc1', inputs: { pin: '1234' } })).code).toBe('SENSITIVE_INPUT');
    expect((await tools.procedure_run('me', { procedure_id: 'other' })).code).toBe('NOT_FOUND');
    expect(started).toHaveLength(1);
  });

  it('a refused start is a tool error, never a throw', async () => {
    const store = new InMemoryProcedureStore();
    await store.putProcedure(aProcedure({ id: 'p', owner: 'me', activeVersion: 'v1' }));
    await store.putVersion('me', aVersion([call('c1', 'navigate', { url: lit('https://example.com/') })], { procedure: 'p', state: 'active' }));
    const tools = procedureToolHandlers({ store, runs: { start: async () => Promise.reject(new Error('daily run limit reached')) } });
    expect(await tools.procedure_run('me', { procedure_id: 'p' })).toMatchObject({ ok: false, code: 'RUN_REFUSED', summary: expect.stringContaining('daily run limit') });
  });
});
