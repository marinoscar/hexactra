// E46.34 (#856), phase 5 acceptance: reuse across goals. A saved task learns a procedure the real way (a learn run, the compiler, a
// verification run), and then an everyday chat run with the same kind of goal is offered it and runs it through `run_procedure`: fewer
// model calls than the same goal with the everyday switch off, and the same browser actions. The chat's input reads, in its stable part,
// the memories, then "About these sites", then the saved procedures block. Scripted model, fake fabric, real database.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { KgraphCompileService } from '../../../src/kgraph/kgraph-compile.service';
import { PrismaProcedureStore } from '../../../src/kgraph/prisma-procedure-store';
import { MemoriesService } from '../../../src/memories/memories.service';
import type { PrismaService } from '../../../src/prisma/prisma.service';
import { chatRun, fabricAt, login, ownerFact, PROCEDURES_BLOCK, runnerOf, scriptedAi, SITE_FACTS_BLOCK, startApp, switches, taskRun, type Call, type Session } from './kit';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  ({ app, prisma } = await startApp());
});
afterAll(async () => {
  await app?.close();
});

const STEPS: Call[] = [
  ['navigate', { url: 'https://shop.example.test/pens', reason: 'open' }],
  ['type_text', { selector: '#q', text: 'blue pens', submit: false }],
  ['navigate', { url: 'https://shop.example.test/pens/blue', reason: 'open' }],
];
const FINISH: Call = ['finish', { success: true, result: 'Found.' }];
const browserActions = (actions: Record<string, unknown>[]) => actions.filter((a) => ['navigate', 'type'].includes(String(a.type))).map((a) => [a.type, a.url ?? a.selector ?? null]);

describe('phase 5 acceptance: an everyday chat reuses another task\'s procedure (E46.34)', () => {
  let admin: Session;
  let owner: Session;
  beforeAll(async () => {
    admin = await login(app, `kgp5-reuse-admin-${stamp}@example.test`, 'admin');
    owner = await login(app, `kgp5-reuse-owner-${stamp}@example.test`);
  });
  afterAll(async () => {
    await switches(app, admin, owner, false, false, false);
  });

  it('learned by a saved task, offered to a chat, run through run_procedure: fewer model calls, the same actions; facts before procedures', async () => {
    await switches(app, admin, owner, true, true, false);
    const store = app.get(PrismaProcedureStore);

    // 1. The saved task learns: a learn run done by the model, then the compiler (the job's work, called directly).
    const learn = await taskRun(prisma, owner, 'learn', 'Search the shop for blue pens', ['shop.example.test'], 'Search pens');
    expect(await runnerOf(app, fabricAt(), scriptedAi([[...STEPS, FINISH]]).ai).advance(learn.runId, owner.userId, null)).toBe('succeeded');
    expect(await app.get(KgraphCompileService).compileRun(owner.userId, learn.runId)).toBe('compiled');
    const procedure = (await store.findProcedureForTask(owner.userId, learn.taskId))!;
    expect((await store.listVersions(owner.userId, procedure.id)).map((v) => v.state)).toEqual(['candidate']);

    // 2. The owner switches the task to reuse; its next run verifies the candidate by replaying it, with no model call.
    await prisma.kgTaskSettings.update({ where: { taskId: learn.taskId }, data: { mode: 'reuse' } });
    const verify = await prisma.forUser({ userId: owner.userId }).run.create({ data: { userId: owner.userId, taskId: learn.taskId, goal: 'Search the shop for blue pens' } });
    const verifyModel = scriptedAi([]);
    expect(await runnerOf(app, fabricAt(), verifyModel.ai).advance(verify.id, owner.userId, null)).toBe('succeeded');
    expect(verifyModel.runTools).not.toHaveBeenCalled();
    expect((await store.listVersions(owner.userId, procedure.id)).map((v) => v.state)).toEqual(['active']);

    // What the chat will also read: a memory, and a fact the owner typed about the site.
    await app.get(MemoriesService).create(owner.userId, { kind: 'person', label: 'My assistant', aliases: ['assistant'], attributes: { name: 'Ann Example' } });
    await ownerFact(app, owner, 'example.test', 'navigation', 'The search box is at the top of every page');
    const GOAL = 'Find blue pens on shop.example.test for my assistant';

    // 3. The same kind of goal in a chat with everyday off: the model does every step itself.
    const offChat = await chatRun(prisma, owner, GOAL, ['shop.example.test']);
    const offModel = scriptedAi([[...STEPS, FINISH]]);
    const offFabric = fabricAt();
    expect(await runnerOf(app, offFabric, offModel.ai).advance(offChat.runId, owner.userId, null)).toBe('succeeded');
    expect(offModel.rounds[0]!.input).not.toContain(PROCEDURES_BLOCK);
    expect(offModel.rounds[0]!.input).not.toContain(SITE_FACTS_BLOCK);

    // 4. Everyday on: the chat is offered the task's procedure and the model runs it with one call.
    await switches(app, admin, owner, true, true, true);
    const onChat = await chatRun(prisma, owner, GOAL, ['shop.example.test']);
    const onModel = scriptedAi([[['run_procedure', { procedure_id: procedure.id, parameters: null }], FINISH]]);
    const onFabric = fabricAt();
    expect(await runnerOf(app, onFabric, onModel.ai).advance(onChat.runId, owner.userId, null)).toBe('succeeded');
    const round = onModel.rounds[0]!;
    expect(round.input).toContain(procedure.id);
    expect(round.outputs[0]).toContain('The saved procedure finished (3 step(s))');
    expect(browserActions(onFabric.actions)).toEqual(browserActions(offFabric.actions));
    expect(browserActions(onFabric.actions)).toHaveLength(3);

    const [off, on] = await Promise.all([offChat.runId, onChat.runId].map((id) => prisma.run.findUniqueOrThrow({ where: { id } })));
    expect(on!.modelCalls).toBeLessThan(off!.modelCalls);
    process.stdout.write(`kgraph phase 5: everyday off ${off!.modelCalls} model calls, everyday on ${on!.modelCalls} (run_procedure + finish); same actions\n`);
    expect([off!.modelCalls, on!.modelCalls]).toEqual([4, 2]);
    expect(await prisma.kgRun.findUniqueOrThrow({ where: { runId: onChat.runId } })).toMatchObject({ mode: 'everyday', outcome: 'procedure_done', stepsReplayed: 3 });

    // 5. The order of the stable part: the goal, the memories, "About these sites", the saved procedures, then the allowed sites.
    const at = (s: string) => round.input.indexOf(s);
    expect(at('Goal: ')).toBeGreaterThanOrEqual(0);
    expect(at('About the owner')).toBeGreaterThan(at('Goal: '));
    expect(at(SITE_FACTS_BLOCK)).toBeGreaterThan(at('About the owner'));
    expect(at(PROCEDURES_BLOCK)).toBeGreaterThan(at(SITE_FACTS_BLOCK));
    expect(at('Allowed sites:')).toBeGreaterThan(at(PROCEDURES_BLOCK));
    expect(round.input).toContain('The search box is at the top of every page');
    // The tools: those of the everyday-off chat, then the procedure tools, then the site fact tools, last.
    expect(round.tools.map((t) => t.name)).toEqual([...offModel.rounds[0]!.tools.map((t) => t.name), 'procedures_list', 'run_procedure', 'propose_site_fact', 'site_facts']);
  });
});
