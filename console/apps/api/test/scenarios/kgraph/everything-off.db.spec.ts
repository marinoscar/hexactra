// E46.34 (#856), phase 5 acceptance: everything off is identical. The owner has an active procedure and an active site fact for the site
// of every run below, so there is something to leak. Compared with a runner that has no Knowledge Graph bound at all (instructions, every
// offered tool's schema, the round input with the run's own ids taken out, the fabric actions, and no `kg_runs` row):
//   - the deployment and user switches on with everyday off (never set, then false): a chat run is identical;
//   - the feature off at the deployment: a chat run and a saved task's run (in learn mode) are identical;
//   - facts absent: a learn run on a site with no facts reads no site block, and an everyday chat of an owner with nothing learned reads no
//     block either. Compared with phase 4's learn run and with an everyday-off chat, the only difference is the tools those modes add, last,
//     and their family names in the instructions' and the input's tool lists.
// runner-characterisation.db.spec.ts stays the canonical proof for the whole runner; this scenario covers the phase 5 switches.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { procedureVersionSchema } from '@marinoscar/hexactra-kgraph';

import { PrismaProcedureStore } from '../../../src/kgraph/prisma-procedure-store';
import type { PrismaService } from '../../../src/prisma/prisma.service';
import { chatRun, fabricAt, login, ownerFact, runnerOf, schemaOf, scriptedAi, startApp, switches, taskRun, withoutIds, type Call, type Round, type Session } from './kit';

let app: NestFastifyApplication;
let prisma: PrismaService;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  ({ app, prisma } = await startApp());
});
afterAll(async () => {
  await app?.close();
});

const GOAL = 'Find blue pens on shop.example.test';
const SCRIPT: Call[] = [['navigate', { url: 'https://shop.example.test/pens', reason: 'open' }], ['finish', { success: true, result: 'Done.' }]];

interface Observed {
  round: Round;
  ids: string[];
  actions: unknown[];
  kgRuns: number;
}

/** The same run, observed: what the model read and was offered, what the fabric did, and whether the Knowledge Graph wrote a row. */
async function observe(owner: Session, kind: 'chat' | 'task', bound: boolean, mode: 'off' | 'learn' = 'learn', unbind: 'siteFacts' | null = null): Promise<Observed> {
  const made = kind === 'chat' ? await chatRun(prisma, owner, GOAL, ['shop.example.test']) : await taskRun(prisma, owner, mode, GOAL, ['shop.example.test'], 'Pens');
  const ids = kind === 'chat' ? [made.runId, (made as { chatId: string }).chatId] : [made.runId, (made as { taskId: string }).taskId];
  const model = scriptedAi([SCRIPT]);
  const fabric = fabricAt();
  const runner = runnerOf(app, fabric, model.ai, bound);
  if (unbind === 'siteFacts') runner.kgraphSiteFacts = undefined;
  expect(await runner.advance(made.runId, owner.userId, null)).toBe('succeeded');
  return { round: model.rounds[0]!, ids, actions: fabric.actions, kgRuns: await prisma.kgRun.count({ where: { runId: made.runId } }) };
}

/** Takes out the names of the two phase 5 tool families from the instructions' and the input's tool lists (what offering the tools adds). */
const FAMILIES = ["The owner's saved procedures", 'Notes about sites'];
const withoutFamilies = (text: string) =>
  FAMILIES.reduce((t, f) => t.split('\n').filter((l) => !l.startsWith(`- ${f}:`)).join('\n').split(`${f}, `).join(''), text);

function expectIdentical(a: Observed, b: Observed): void {
  expect(a.round.instructions).toBe(b.round.instructions);
  expect(a.round.tools.map(schemaOf)).toEqual(b.round.tools.map(schemaOf));
  expect(withoutIds(a.round.input, ...a.ids)).toBe(withoutIds(b.round.input, ...b.ids));
  expect(a.actions).toEqual(b.actions);
}

describe('phase 5 acceptance: everything off is identical (E46.34)', () => {
  let admin: Session;
  let owner: Session;
  beforeAll(async () => {
    admin = await login(app, `kgp5-off-admin-${stamp}@example.test`, 'admin');
    owner = await login(app, `kgp5-off-owner-${stamp}@example.test`);
    // Something to leak: another task's active procedure and an active fact, both for example.test.
    await switches(app, admin, owner, true, true, null);
    const taskId = (await prisma.forUser({ userId: owner.userId }).task.create({ data: { userId: owner.userId, name: 'Search pens', goal: 'Search the shop for blue pens' } })).id;
    const store = app.get(PrismaProcedureStore);
    const now = new Date().toISOString();
    const pid = `kgp-p5off-${taskId}`;
    await store.putProcedure({ id: pid, owner: owner.userId, task: taskId, name: 'Search pens', activeVersion: null, createdAt: now, updatedAt: now });
    await store.putVersion(owner.userId, procedureVersionSchema.parse({ id: `kgv-p5off-${taskId}`, procedure: pid, number: 1, state: 'active', changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: 's1', steps: [{ id: 's1', kind: 'call', label: 'navigate', tool: 'navigate', args: { url: { kind: 'literal', value: 'https://shop.example.test/pens' }, reason: { kind: 'literal', value: 'open' } }, sites: ['site:example.test'] }], edges: [], sites: [{ id: 'site:example.test', domain: 'example.test' }] }));
    await store.putProcedure({ id: pid, owner: owner.userId, task: taskId, name: 'Search pens', activeVersion: `kgv-p5off-${taskId}`, createdAt: now, updatedAt: now });
    await ownerFact(app, owner, 'example.test', 'navigation', 'The search box is at the top of every page');
  });
  afterAll(async () => {
    await switches(app, admin, owner, false, false, false);
  });

  it('everyday off (unset, then false): a chat run is identical to a runner with no Knowledge Graph', async () => {
    for (const everyday of [null, false] as const) {
      await switches(app, admin, owner, true, true, everyday);
      const baseline = await observe(owner, 'chat', false);
      const off = await observe(owner, 'chat', true);
      expectIdentical(off, baseline);
      expect(off.kgRuns).toBe(0);
    }
  });

  it('the feature off at the deployment: a chat run and a learn-mode task run are identical to a runner with no Knowledge Graph', async () => {
    await switches(app, admin, owner, false, true, true);
    for (const kind of ['chat', 'task'] as const) {
      const baseline = await observe(owner, kind, false);
      const off = await observe(owner, kind, true);
      expectIdentical(off, baseline);
      expect([baseline.kgRuns, off.kgRuns]).toEqual([0, 0]);
      expect(off.round.input).not.toMatch(/About these sites|Saved procedures/);
    }
  });

  it('facts absent: a learn run with no facts for its site, and an everyday chat with nothing learned, read exactly what they read without phase 5', async () => {
    // A fresh owner: no procedure and no fact anywhere.
    const fresh = await login(app, `kgp5-off-fresh-${stamp}@example.test`);
    await switches(app, admin, fresh, true, true, false);
    const phase4 = await observe(fresh, 'task', true, 'learn', 'siteFacts');
    const learn = await observe(fresh, 'task', true, 'learn');
    expect(learn.round.input).not.toContain('About these sites');
    expect(withoutFamilies(withoutIds(learn.round.input, ...learn.ids))).toBe(withoutIds(phase4.round.input, ...phase4.ids));
    expect(withoutFamilies(learn.round.instructions)).toBe(phase4.round.instructions);
    expect(learn.round.tools.map((t) => t.name)).toEqual([...phase4.round.tools.map((t) => t.name), 'propose_site_fact', 'site_facts']);
    expect(learn.round.tools.slice(0, -2).map(schemaOf)).toEqual(phase4.round.tools.map(schemaOf));

    const everydayOff = await observe(fresh, 'chat', true);
    await switches(app, admin, fresh, true, true, true);
    const everydayOn = await observe(fresh, 'chat', true);
    expect(everydayOn.round.input).not.toMatch(/About these sites|Saved procedures/);
    expect(withoutFamilies(everydayOn.round.instructions)).toBe(everydayOff.round.instructions);
    expect(withoutFamilies(withoutIds(everydayOn.round.input, ...everydayOn.ids))).toBe(withoutIds(everydayOff.round.input, ...everydayOff.ids));
    expect(everydayOn.round.tools.map((t) => t.name)).toEqual([...everydayOff.round.tools.map((t) => t.name), 'procedures_list', 'run_procedure', 'propose_site_fact', 'site_facts']);
    expect(everydayOn.round.tools.slice(0, -4).map(schemaOf)).toEqual(everydayOff.round.tools.map(schemaOf));
    expect(everydayOn.actions).toEqual(everydayOff.actions);
  });
});
