// E46.34 (#856), phase 5 acceptance: a lookalike domain gets no procedure and no facts. The owner has an active procedure and an active
// fact for example.test. An everyday chat about a lookalike (`shop.example.test.evil.io`, `shop-example.test`, `examp1e.test`), on a page
// of that lookalike, reads no saved procedures block and no "About these sites" block, and `site_facts` reads nothing. The owner's library
// stays listable on the model's request (`procedures_list` with a query matches by words, as `procedures_list` without one lists every
// usable procedure, E46.22), so a `run_procedure` the model calls anyway is the case that matters: its step goes through the run's own
// executeTool and site gate, which refuses example.test. The exact domain, as a control, gets both blocks. Scripted model, fake fabric, real database.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { procedureVersionSchema } from '@marinoscar/hexactra-kgraph';

import { PrismaProcedureStore } from '../../../src/kgraph/prisma-procedure-store';
import type { PrismaService } from '../../../src/prisma/prisma.service';
import { chatRun, fabricAt, login, ownerFact, PROCEDURES_BLOCK, runnerOf, scriptedAi, SITE_FACTS_BLOCK, startApp, switches, type Call, type Session } from './kit';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  ({ app, prisma } = await startApp());
});
afterAll(async () => {
  await app?.close();
});

const FACT = 'The search box is at the top of every page';

describe('phase 5 acceptance: a lookalike domain gets no procedure and no facts (E46.34)', () => {
  let admin: Session;
  let owner: Session;
  let pid: string;
  beforeAll(async () => {
    admin = await login(app, `kgp5-look-admin-${stamp}@example.test`, 'admin');
    owner = await login(app, `kgp5-look-owner-${stamp}@example.test`);
    await switches(app, admin, owner, true, true, true);
    // Another task's active procedure on example.test, and a fact the owner typed about example.test.
    const db = prisma.forUser({ userId: owner.userId });
    const taskId = (await db.task.create({ data: { userId: owner.userId, name: 'Search pens', goal: 'Search the shop for blue pens' } })).id;
    const store = app.get(PrismaProcedureStore);
    const now = new Date().toISOString();
    pid = `kgp-p5look-${taskId}`;
    const vid = `kgv-p5look-${taskId}`;
    await store.putProcedure({ id: pid, owner: owner.userId, task: taskId, name: 'Search pens', activeVersion: null, createdAt: now, updatedAt: now });
    await store.putVersion(owner.userId, procedureVersionSchema.parse({
      id: vid, procedure: pid, number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: 's1',
      steps: [{ id: 's1', kind: 'call', label: 'navigate', tool: 'navigate', args: { url: { kind: 'literal', value: 'https://shop.example.test/pens' }, reason: { kind: 'literal', value: 'open' } }, sites: ['site:example.test'] }],
      edges: [], sites: [{ id: 'site:example.test', domain: 'example.test' }],
    }));
    await store.putProcedure({ id: pid, owner: owner.userId, task: taskId, name: 'Search pens', activeVersion: vid, createdAt: now, updatedAt: now });
    await ownerFact(app, owner, 'example.test', 'navigation', FACT);
  });
  afterAll(async () => {
    await switches(app, admin, owner, false, false, false);
  });

  const script = (): Call[] => [['procedures_list', { query: 'blue pens' }], ['site_facts', {}], ['run_procedure', { procedure_id: pid, parameters: null }], ['finish', { success: true, result: 'Done.' }]];

  it.each(['shop.example.test.evil.io', 'shop-example.test', 'examp1e.test'])('%s: no procedure block, no fact, and run_procedure is refused by the site gate', async (host) => {
    const { runId } = await chatRun(prisma, owner, `Find blue pens on ${host}`, [host]);
    const fabric = fabricAt(`https://${host}/start`);
    const model = scriptedAi([script()]);
    await runnerOf(app, fabric, model.ai).advance(runId, owner.userId, null);
    const round = model.rounds[0]!;
    expect(round.input).not.toContain(PROCEDURES_BLOCK);
    expect(round.input).not.toContain(SITE_FACTS_BLOCK);
    expect(round.input).not.toContain(pid);
    expect(round.input).not.toContain(FACT);
    const [listed, facts, ran] = round.outputs;
    // Asked by words, the listing names the owner's procedure; nothing about the lookalike's site offered it.
    expect(listed).toContain(pid);
    expect(facts).not.toContain(FACT);
    // The procedure's step goes through the run's own executeTool: the site gate reads the run's allowed sites and refuses example.test.
    expect(ran).not.toContain('The saved procedure finished');
    expect(fabric.actions.filter((a) => a.type === 'navigate')).toEqual([]);
    const nav = await prisma.runStep.findFirst({ where: { runId, action: 'navigate' } });
    expect(nav).toMatchObject({ ok: false, summary: 'refused by policy: site not allowed' });
    // No fact was offered or used, and the site facts tool named the lookalike's own site, read from the browser.
    const kg = await prisma.kgRun.findUnique({ where: { runId } });
    expect(kg?.offeredFactIds ?? []).toEqual([]);
    expect(kg?.factIds ?? []).toEqual([]);
    const step = await prisma.runStep.findFirstOrThrow({ where: { runId, action: 'site_facts' } });
    expect((step.args as { site: string; count: number }).count).toBe(0);
  });

  it('control: the exact domain gets the procedure block and the fact', async () => {
    const { runId } = await chatRun(prisma, owner, 'Find blue pens on shop.example.test', ['shop.example.test']);
    const fabric = fabricAt('https://shop.example.test/start');
    const model = scriptedAi([script()]);
    await runnerOf(app, fabric, model.ai).advance(runId, owner.userId, null);
    const round = model.rounds[0]!;
    expect(round.input).toContain(PROCEDURES_BLOCK);
    expect(round.input).toContain(pid);
    expect(round.input).toContain(FACT);
    const [listed, facts, ran] = round.outputs;
    expect(listed).toContain(pid);
    expect(facts).toContain(FACT);
    expect(ran).toContain('The saved procedure finished (1 step(s))');
    expect(fabric.actions.filter((a) => a.type === 'navigate').map((a) => a.url)).toEqual(['https://shop.example.test/pens']);
  });
});
