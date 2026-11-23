// E46.4 (#778): the smoke of the Knowledge Graph storage load test. Two small owners built by the load test's own seed, then the five measured
// queries (scripts/kgraph-loadtest-lib.js, the same code `npm run kgraph:loadtest` times) must answer correctly, stay inside one owner, and
// be able to use the kg_ indexes they rely on, so neither the queries nor the indexes can rot. The full run and its numbers:
// docs/decisions/knowledge-graph.md, "Load test".
import { PrismaService } from '../src/prisma/prisma.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../scripts/kgraph-loadtest-lib.js');

const SHAPE = { tasks: 4, steps: 5, versions: 3, sites: 3, screens: 2, elements: 3 };
const PREFIX = `kgsmoke-${Date.now().toString(36)}`;
const A = 0;
const B = 1;

let prisma: PrismaService;
const owner = (o: number): string => lib.keys.owner(PREFIX, o);
const db = (userId: string) => prisma.forUser({ userId });

beforeAll(async () => {
  prisma = new PrismaService();
  await prisma.$connect();
  for (const s of lib.seedStatements(SHAPE) as { sql: string }[]) await prisma.$executeRawUnsafe(s.sql, PREFIX, 0, 2);
});
afterAll(async () => {
  // The users cascade to their tasks, runs, run_steps and every kg_ row.
  await prisma?.$executeRawUnsafe(`DELETE FROM users WHERE email LIKE $1`, `${PREFIX}-%@load.test`);
  await prisma?.$disconnect();
});

const taskNodeIds = (o: number, ts: number[]) => ts.map((t) => lib.keys.taskNode(PREFIX, o, t)).sort();
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('the Knowledge Graph load-test queries (#778)', () => {
  it('query 1 loads the active version of a task with the evidence of the version and of every step, for its owner only', async () => {
    const v = await lib.q1ActiveVersion(db, owner(A), lib.keys.task(PREFIX, A, 2));
    expect(v.id).toBe(lib.keys.version(PREFIX, A, 2, SHAPE.versions));
    expect(v.state).toBe('active');
    expect(v.evidence).toHaveLength(SHAPE.steps + 1);
    expect(await lib.q1ActiveVersion(db, owner(B), lib.keys.task(PREFIX, A, 2))).toBeNull();
  });

  it('query 2 writes the evidence of a step and a run_steps row in one transaction', async () => {
    const version = lib.keys.version(PREFIX, A, 1, SHAPE.versions);
    const before = await prisma.kgEvidence.findMany({ where: { versionId: version, stepId: { in: ['', 's3'] } }, orderBy: { stepId: 'asc' } });
    const run = { id: lib.keys.run(PREFIX, A), seq: 1 };
    await lib.q2WriteEvidence(prisma, owner(A), version, 's3', run);
    const after = await prisma.kgEvidence.findMany({ where: { versionId: version, stepId: { in: ['', 's3'] } }, orderBy: { stepId: 'asc' } });
    expect(after.map((e) => e.successes)).toEqual(before.map((e) => e.successes + 1));
    expect(await prisma.runStep.count({ where: { runId: run.id } })).toBe(1);
    // A rolled-back write leaves nothing behind; another owner's version is refused.
    await lib.q2WriteEvidence(prisma, owner(A), version, 's3', { id: run.id, seq: 2 }, { rollback: true });
    expect(await prisma.runStep.count({ where: { runId: run.id } })).toBe(1);
    await expect(lib.q2WriteEvidence(prisma, owner(B), version, 's3', { id: lib.keys.run(PREFIX, B), seq: 1 })).rejects.toThrow('version not found for this owner');
    expect(await prisma.runStep.count({ where: { runId: lib.keys.run(PREFIX, B) } })).toBe(0);
  });

  it('query 3 answers which tasks use a site, inside one owner', async () => {
    for (let s = 0; s < SHAPE.sites; s += 1) {
      const rows = await lib.q3TasksUsingSite(prisma, owner(A), lib.keys.siteNode(PREFIX, A, s));
      expect(ids(rows)).toEqual(taskNodeIds(A, lib.tasksUsingSite(SHAPE, s)));
    }
    expect(await lib.q3TasksUsingSite(prisma, owner(B), lib.keys.siteNode(PREFIX, A, 0))).toEqual([]);
  });

  it('query 4 loads the whole graph of one owner and nothing of another', async () => {
    const want = lib.rowsPerOwner(SHAPE);
    const g = await lib.q4OwnerGraph(db, owner(B));
    expect(g.nodes).toHaveLength(want.kg_nodes);
    expect(g.edges).toHaveLength(want.kg_edges);
    expect(new Set([...g.nodes, ...g.edges].map((r: { userId: string }) => r.userId))).toEqual(new Set([owner(B)]));
  });

  it('query 4 as the Map reads it (the columns it draws, the shape E46.19 must use) loads the same rows of one owner', async () => {
    const want = lib.rowsPerOwner(SHAPE);
    const g = await lib.q4OwnerGraphMap(db, owner(A));
    expect(g.nodes).toHaveLength(want.kg_nodes);
    expect(g.edges).toHaveLength(want.kg_edges);
    expect(Object.keys(g.nodes[0]).sort()).toEqual(['id', 'key', 'label', 'type']);
    expect(Object.keys(g.edges[0]).sort()).toEqual(['fromId', 'id', 'toId', 'type']);
    const full = await lib.q4OwnerGraph(db, owner(A));
    expect(g.nodes.map((n: { id: string }) => n.id).sort()).toEqual(full.nodes.map((n: { id: string }) => n.id).sort());
    expect(g.edges.map((e: { id: string }) => e.id).sort()).toEqual(full.edges.map((e: { id: string }) => e.id).sort());
  });

  it('query 5 walks site <- screens <- elements <- steps <- tasks, inside one owner', async () => {
    for (let s = 0; s < SHAPE.sites; s += 1) {
      const rows = await lib.q5SiteImpact(prisma, owner(B), lib.keys.siteNode(PREFIX, B, s));
      expect(ids(rows)).toEqual(taskNodeIds(B, lib.tasksImpactedBySite(SHAPE, s)));
    }
    expect(await lib.q5SiteImpact(prisma, owner(A), lib.keys.siteNode(PREFIX, B, 0))).toEqual([]);
  });

  it('the graph queries can use the owner-scoped kg_ indexes they rely on', async () => {
    const plan = (sql: string, ...params: unknown[]) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${sql}`, ...params);
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });
    const site = lib.keys.siteNode(PREFIX, A, 0);
    // With sequential scans priced out, a plan still holds a Seq Scan only when no index fits: every table must be reached by an owner index.
    for (const p of [await plan(lib.Q3_SQL, owner(A), site), await plan(lib.Q5_SQL, owner(A), site)]) {
      expect(p).not.toContain('Seq Scan');
      expect(p).toMatch(/kg_edges_user_id_(from|to)_id_type_idx/);
    }
    const nodes = await plan('SELECT * FROM kg_nodes WHERE user_id = $1::uuid', owner(A));
    expect(nodes).not.toContain('Seq Scan');
    expect(nodes).toContain('kg_nodes_user_id_type_key_key');
    const edges = await plan('SELECT * FROM kg_edges WHERE user_id = $1::uuid', owner(A));
    expect(edges).not.toContain('Seq Scan');
    expect(edges).toMatch(/kg_edges_user_id_(from|to)_id_type_idx/);
  });
});
