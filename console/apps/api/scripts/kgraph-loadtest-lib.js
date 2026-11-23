'use strict';
// The Knowledge Graph storage load test (E46.4, #778): the synthetic dataset and the five measured queries. Shared by
// scripts/kgraph-loadtest.mjs (the full run, 200 owners) and test/kgraph-loadtest.db.spec.ts (the db-tier smoke, 2 owners), so the
// queries and the indexes they rely on cannot rot. CommonJS so both an ES module script and a ts-jest spec can load it.
//
// The representation is the one the store will use (console docs/decisions/knowledge-graph.md):
//   kg_procedures (one per task, active_version_id) -> kg_procedure_versions (graph JSON) -> kg_evidence (one row per version, one per step)
//   kg_nodes: Site, Screen, Element (the surface graph), Task, Step (the active version's steps)
//   kg_edges: Screen -on-> Site, Element -on-> Screen, Step -on-> Element, Task -uses-> Site, Task -uses-> Step
// Every synthetic row is reachable from a synthetic user (`<prefix>-<n>@load.test`); deleting those users deletes everything (cascade).

/** The sizing assumption per owner (#778): 100 tasks x 30 steps x 10 versions, 50 sites x 30 screens x 20 elements. */
const NORMAL_SHAPE = Object.freeze({ tasks: 100, steps: 30, versions: 10, sites: 50, screens: 30, elements: 20 });

/** A heavier owner: `factor` times the tasks and the sites (so ten times the rows at factor 10). */
function scaledShape(shape, factor) {
  return { ...shape, tasks: shape.tasks * factor, sites: shape.sites * factor };
}

const int = (n, name) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
};

/** Sites a task uses: up to three, distinct. */
const sitesPerTask = (shape) => Math.min(3, shape.sites);

/**
 * The INSERT statements that build owners [$2, $3) of `shape` under prefix $1 (parameters: prefix text, lo int, hi int). Numbers of the
 * shape are inlined (validated integers); the prefix is a parameter. Run them in order.
 */
function seedStatements(shape) {
  const T = int(shape.tasks, 'tasks');
  const S = int(shape.steps, 'steps');
  const V = int(shape.versions, 'versions');
  const NS = int(shape.sites, 'sites');
  const C = int(shape.screens, 'screens');
  const E = int(shape.elements, 'elements');
  const NSP = sitesPerTask(shape);
  const owners = 'generate_series($2::int, $3::int - 1) o';
  const tasks = `generate_series(0, ${T - 1}) t`;
  const uid = `md5($1 || '-u-' || o)::uuid`;
  const tid = `md5($1 || '-t-' || o || '-' || t)::uuid`;
  // The site, screen and element step j of task t (version v) acts on.
  const stepSite = (j) => `((t + ((${j} - 1) % ${NSP})) % ${NS})`;
  const stepScreen = (j) => `((${j} * 7 + t) % ${C})`;
  const stepElement = (j, v) => `((${j} * 13 + t + ${v}) % ${E})`;
  const node = (o, rest) => `$1 || '-n-' || ${o} || ${rest}`;
  const siteNode = (s) => node('o', `'-site-' || ${s}`);
  const screenNode = (s, c) => node('o', `'-scr-' || ${s} || '-' || ${c}`);
  const elementNode = (s, c, e) => node('o', `'-el-' || ${s} || '-' || ${c} || '-' || ${e}`);
  const stepNode = (t, j) => node('o', `'-step-' || ${t} || '-' || ${j}`);
  const taskNode = (t) => node('o', `'-task-' || ${t}`);
  const versionId = (v) => `$1 || '-v-' || o || '-' || t || '-' || ${v}`;
  const procedureId = `$1 || '-p-' || o || '-' || t`;
  const graph = `jsonb_build_object(
      'entry', 's1',
      'steps', (SELECT jsonb_agg(jsonb_build_object(
          'id', 's' || j, 'label', 'Step ' || j || ' of task ' || t, 'kind', 'call', 'tool', 'browser_click',
          'args', jsonb_build_object('selector', jsonb_build_object('kind', 'literal', 'value', '[data-test="el-' || ${stepElement('j', 'v')} || '"]')),
          'sites', jsonb_build_array('site-' || ${stepSite('j')}), 'commitClass', false, 'segment', 'g' || ((j - 1) / 10),
          'checks', jsonb_build_array(jsonb_build_object('kind', 'location', 'host', 'site-' || ${stepSite('j')} || '.example.test', 'pathPattern', '/screen-' || ${stepScreen('j')} || '/**', 'tolerance', 0)),
          'screen', 'scr-' || ${stepSite('j')} || '-' || ${stepScreen('j')},
          'element', 'el-' || ${stepSite('j')} || '-' || ${stepScreen('j')} || '-' || ${stepElement('j', 'v')}) ORDER BY j)
        FROM generate_series(1, ${S}) j),
      'edges', COALESCE((SELECT jsonb_agg(jsonb_build_object('type', 'then', 'from', 's' || j, 'to', 's' || (j + 1)) ORDER BY j) FROM generate_series(1, ${S - 1}) j), '[]'::jsonb),
      'sites', (SELECT jsonb_agg(jsonb_build_object('id', 'site-' || ((t + k) % ${NS}), 'domain', 'site-' || ((t + k) % ${NS}) || '.example.test') ORDER BY k) FROM generate_series(0, ${NSP - 1}) k),
      'accounts', '[]'::jsonb, 'secretRefs', '[]'::jsonb, 'parameters', '[]'::jsonb, 'outputs', '[]'::jsonb, 'screens', '[]'::jsonb, 'elements', '[]'::jsonb)`;
  return [
    { table: 'users', sql: `INSERT INTO users (id, email, updated_at) SELECT ${uid}, $1 || '-' || o || '@load.test', now() FROM ${owners}` },
    {
      table: 'tasks',
      sql: `INSERT INTO tasks (id, user_id, name, goal, updated_at) SELECT ${tid}, ${uid}, 'Load task ' || t, 'Synthetic load-test goal number ' || t, now() FROM ${owners}, ${tasks}`,
    },
    { table: 'runs', sql: `INSERT INTO runs (id, user_id, task_id, goal) SELECT md5($1 || '-r-' || o)::uuid, ${uid}, md5($1 || '-t-' || o || '-0')::uuid, 'Synthetic load-test run' FROM ${owners}` },
    {
      table: 'kg_procedures',
      sql: `INSERT INTO kg_procedures (id, user_id, task_id, name, active_version_id, updated_at)
            SELECT ${procedureId}, ${uid}, ${tid}, 'Procedure of task ' || t, ${versionId(V)}, now() FROM ${owners}, ${tasks}`,
    },
    {
      table: 'kg_procedure_versions',
      sql: `INSERT INTO kg_procedure_versions (id, user_id, procedure_id, seq, state, graph, change_class, source_run_id, parent_version_id, created_at, updated_at)
            SELECT ${versionId('v')}, ${uid}, ${procedureId}, v, CASE WHEN v = ${V} THEN 'active' ELSE 'retired' END, ${graph},
                   CASE WHEN v = 1 THEN 'initial' ELSE 'structural' END, NULL, CASE WHEN v > 1 THEN ${versionId('(v - 1)')} END,
                   now() - make_interval(days => ${V} - v), now()
            FROM ${owners}, ${tasks}, generate_series(1, ${V}) v`,
    },
    {
      table: 'kg_evidence',
      sql: `INSERT INTO kg_evidence (id, user_id, version_id, step_id, successes, failures, repairs, last_success_at, last_failure_at)
            SELECT gen_random_uuid(), ${uid}, ${versionId('v')}, CASE WHEN j = 0 THEN '' ELSE 's' || j END, (o + t + v + j) % 50, (o + t + j) % 3, (v + j) % 2,
                   now(), CASE WHEN (o + t + j) % 3 > 0 THEN now() END
            FROM ${owners}, ${tasks}, generate_series(1, ${V}) v, generate_series(0, ${S}) j`,
    },
    {
      table: 'kg_nodes (Site)',
      sql: `INSERT INTO kg_nodes (id, user_id, type, key, label, props, updated_at)
            SELECT ${siteNode('s')}, ${uid}, 'Site', 'site-' || s || '.example.test', 'Site ' || s, jsonb_build_object('domain', 'site-' || s || '.example.test'), now()
            FROM ${owners}, generate_series(0, ${NS - 1}) s`,
    },
    {
      table: 'kg_nodes (Screen)',
      sql: `INSERT INTO kg_nodes (id, user_id, type, key, label, props, updated_at)
            SELECT ${screenNode('s', 'c')}, ${uid}, 'Screen', 'site-' || s || '.example.test/screen-' || c, 'Screen ' || c || ' of site ' || s,
                   jsonb_build_object('pathPattern', '/screen-' || c || '/**'), now()
            FROM ${owners}, generate_series(0, ${NS - 1}) s, generate_series(0, ${C - 1}) c`,
    },
    {
      table: 'kg_nodes (Element)',
      sql: `INSERT INTO kg_nodes (id, user_id, type, key, label, props, updated_at)
            SELECT ${elementNode('s', 'c', 'e')}, ${uid}, 'Element', 'site-' || s || '.example.test/screen-' || c || '#el-' || e, 'Button ' || e,
                   jsonb_build_object('role', 'button', 'selectors', jsonb_build_array('[data-test="el-' || e || '"]', 'main button:nth-of-type(' || (e + 1) || ')')), now()
            FROM ${owners}, generate_series(0, ${NS - 1}) s, generate_series(0, ${C - 1}) c, generate_series(0, ${E - 1}) e`,
    },
    {
      table: 'kg_nodes (Task)',
      sql: `INSERT INTO kg_nodes (id, user_id, type, key, label, props, updated_at)
            SELECT ${taskNode('t')}, ${uid}, 'Task', ${tid}::text, 'Load task ' || t, '{}'::jsonb, now() FROM ${owners}, ${tasks}`,
    },
    {
      table: 'kg_nodes (Step)',
      sql: `INSERT INTO kg_nodes (id, user_id, type, key, label, props, updated_at)
            SELECT ${stepNode('t', 'j')}, ${uid}, 'Step', ${procedureId} || '/s' || j, 'Step ' || j || ' of task ' || t, jsonb_build_object('kind', 'call', 'tool', 'browser_click'), now()
            FROM ${owners}, ${tasks}, generate_series(1, ${S}) j`,
    },
    {
      table: 'kg_edges (Screen on Site)',
      sql: `INSERT INTO kg_edges (id, user_id, type, from_id, to_id)
            SELECT $1 || '-e-' || o || '-scr-' || s || '-' || c, ${uid}, 'on', ${screenNode('s', 'c')}, ${siteNode('s')}
            FROM ${owners}, generate_series(0, ${NS - 1}) s, generate_series(0, ${C - 1}) c`,
    },
    {
      table: 'kg_edges (Element on Screen)',
      sql: `INSERT INTO kg_edges (id, user_id, type, from_id, to_id)
            SELECT $1 || '-e-' || o || '-el-' || s || '-' || c || '-' || e, ${uid}, 'on', ${elementNode('s', 'c', 'e')}, ${screenNode('s', 'c')}
            FROM ${owners}, generate_series(0, ${NS - 1}) s, generate_series(0, ${C - 1}) c, generate_series(0, ${E - 1}) e`,
    },
    {
      table: 'kg_edges (Step on Element)',
      sql: `INSERT INTO kg_edges (id, user_id, type, from_id, to_id)
            SELECT $1 || '-e-' || o || '-step-' || t || '-' || j, ${uid}, 'on', ${stepNode('t', 'j')}, ${elementNode(stepSite('j'), stepScreen('j'), stepElement('j', V))}
            FROM ${owners}, ${tasks}, generate_series(1, ${S}) j`,
    },
    {
      table: 'kg_edges (Task uses Site)',
      sql: `INSERT INTO kg_edges (id, user_id, type, from_id, to_id)
            SELECT $1 || '-e-' || o || '-tus-' || t || '-' || k, ${uid}, 'uses', ${taskNode('t')}, ${siteNode(`((t + k) % ${NS})`)}
            FROM ${owners}, ${tasks}, generate_series(0, ${NSP - 1}) k`,
    },
    {
      table: 'kg_edges (Task uses Step)',
      sql: `INSERT INTO kg_edges (id, user_id, type, from_id, to_id)
            SELECT $1 || '-e-' || o || '-tst-' || t || '-' || j, ${uid}, 'uses', ${taskNode('t')}, ${stepNode('t', 'j')}
            FROM ${owners}, ${tasks}, generate_series(1, ${S}) j`,
    },
  ];
}

/** The ids of owner `o`'s synthetic rows, computed the way the seed computes them (md5 of the same text, as a uuid). */
const md5Uuid = (text) => {
  const h = require('node:crypto').createHash('md5').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const keys = {
  owner: (prefix, o) => md5Uuid(`${prefix}-u-${o}`),
  task: (prefix, o, t) => md5Uuid(`${prefix}-t-${o}-${t}`),
  run: (prefix, o) => md5Uuid(`${prefix}-r-${o}`),
  version: (prefix, o, t, v) => `${prefix}-v-${o}-${t}-${v}`,
  siteNode: (prefix, o, s) => `${prefix}-n-${o}-site-${s}`,
  taskNode: (prefix, o, t) => `${prefix}-n-${o}-task-${t}`,
};

/** The rows one owner of `shape` has, per table (what the seed writes). */
function rowsPerOwner(shape) {
  const { tasks: T, steps: S, versions: V, sites: NS, screens: C, elements: E } = shape;
  const NSP = sitesPerTask(shape);
  return {
    kg_procedures: T,
    kg_procedure_versions: T * V,
    kg_evidence: T * V * (S + 1),
    kg_nodes: NS + NS * C + NS * C * E + T + T * S,
    kg_edges: NS * C + NS * C * E + T * S + T * NSP + T * S,
  };
}

/** The tasks query 3 must return for site `s` of an owner of `shape` (task indexes). */
function tasksUsingSite(shape, s) {
  const out = [];
  for (let t = 0; t < shape.tasks; t += 1) for (let k = 0; k < sitesPerTask(shape); k += 1) if ((t + k) % shape.sites === s) out.push(t);
  return [...new Set(out)];
}

/** The tasks query 5 must return for site `s`: tasks with a step on an element of a screen of the site. */
function tasksImpactedBySite(shape, s) {
  const NSP = sitesPerTask(shape);
  const out = new Set();
  for (let t = 0; t < shape.tasks; t += 1) for (let j = 1; j <= shape.steps; j += 1) if ((t + ((j - 1) % NSP)) % shape.sites === s) out.add(t);
  return [...out];
}

// ---------------------------------------------------------------- the five queries
// `db(owner)` is the scoped client (`PrismaService.forUser({ userId: owner })`); `prisma` is the base client.

/** Query 1: one task's active procedure version with its evidence, as PrismaProcedureStore.findProcedureForTask then getVersion issue it. */
async function q1ActiveVersion(db, owner, taskId) {
  const p = await db(owner).kgProcedure.findFirst({ where: { taskId, userId: owner } });
  if (!p || !p.activeVersionId) return null;
  return db(owner).kgProcedureVersion.findFirst({ where: { id: p.activeVersionId, userId: owner }, include: { evidence: true } });
}

const ROLLBACK = Symbol('kgraph-loadtest-rollback');

/**
 * Query 2: write the evidence of one step inside one transaction with a run_steps row of the size the runner writes. The evidence
 * statements are PrismaProcedureStore.recordEvidence's, with the owner condition added exactly as the scoped client (`forUser`) adds it
 * (`where: { AND: [where, { userId }] }` on a filter, `AND: [{ userId }]` on a unique where): the scoped client refuses the unscoped
 * run_steps model, so a transaction that spans both goes through the base client. `rollback: true` runs it and rolls it back.
 */
async function q2WriteEvidence(prisma, owner, versionId, stepId, run, opts = {}) {
  const when = new Date();
  const scope = { userId: owner };
  const work = async (tx) => {
    await tx.runStep.create({
      data: {
        runId: run.id,
        seq: run.seq,
        kind: 'action',
        action: 'click',
        args: { selector: '[data-test="el-7"]', element: 'el-3-12-7', button: 'left' },
        ok: true,
        summary: 'Clicked the "Continue" button on the checkout screen of site-3.example.test; the page moved to the shipping step.',
        reasoning: 'The form is filled and the Continue button is enabled, so the next step is to submit this screen and check that the shipping step loads.',
        phase: 'done',
        durationMs: 412,
      },
    });
    const v = await tx.kgProcedureVersion.findFirst({ where: { AND: [{ id: versionId, userId: owner }, scope] }, select: { id: true } });
    if (!v) throw new Error('version not found for this owner');
    let versionEvidence;
    for (const sid of ['', stepId]) {
      const row = await tx.kgEvidence.upsert({
        where: { versionId_stepId: { versionId, stepId: sid }, AND: [scope] },
        create: { userId: owner, versionId, stepId: sid, successes: 1, failures: 0, repairs: 0, lastSuccessAt: when, lastFailureAt: null },
        update: { successes: { increment: 1 }, lastSuccessAt: when },
      });
      if (sid === '') versionEvidence = row;
    }
    if (opts.rollback) throw ROLLBACK;
    return versionEvidence;
  };
  try {
    return await prisma.$transaction(work);
  } catch (e) {
    if (e === ROLLBACK) return null;
    throw e;
  }
}

/** Query 3 SQL: which tasks use this site (one join). Every table is filtered by the owner. */
const Q3_SQL = `SELECT t.id, t.key, t.label
FROM kg_edges e
JOIN kg_nodes t ON t.id = e.from_id AND t.user_id = e.user_id AND t.type = 'Task'
WHERE e.user_id = $1::uuid AND e.to_id = $2 AND e.type = 'uses'`;

/** Query 5 SQL: the impact of a site: site <- screens <- elements <- steps <- tasks (every hop an edge lookup on the owner's index). */
const Q5_SQL = `SELECT DISTINCT t.id, t.key, t.label
FROM kg_edges sc
JOIN kg_edges el ON el.user_id = sc.user_id AND el.to_id = sc.from_id AND el.type = 'on'
JOIN kg_edges st ON st.user_id = sc.user_id AND st.to_id = el.from_id AND st.type = 'on'
JOIN kg_edges tk ON tk.user_id = sc.user_id AND tk.to_id = st.from_id AND tk.type = 'uses'
JOIN kg_nodes t ON t.id = tk.from_id AND t.user_id = sc.user_id AND t.type = 'Task'
WHERE sc.user_id = $1::uuid AND sc.to_id = $2 AND sc.type = 'on'`;

/** Query 3. Raw SQL goes through the base client: the scoped client refuses raw SQL, so the store states the owner in the SQL itself. */
async function q3TasksUsingSite(prisma, owner, siteNodeId) {
  return prisma.$queryRawUnsafe(Q3_SQL, owner, siteNodeId);
}

/** Query 4: the whole graph of one owner for the Map: every node and every edge, read through the scoped client. */
async function q4OwnerGraph(db, owner) {
  const [nodes, edges] = await Promise.all([db(owner).kgNode.findMany({ where: { userId: owner } }), db(owner).kgEdge.findMany({ where: { userId: owner } })]);
  return { nodes, edges };
}

/** Query 4, Map columns only: what the Map draws (a node's id, type, key and label; an edge's id, type and ends), without props or times. */
async function q4OwnerGraphMap(db, owner) {
  const [nodes, edges] = await Promise.all([
    db(owner).kgNode.findMany({ where: { userId: owner }, select: { id: true, type: true, key: true, label: true } }),
    db(owner).kgEdge.findMany({ where: { userId: owner }, select: { id: true, type: true, fromId: true, toId: true } }),
  ]);
  return { nodes, edges };
}

/** Query 5. */
async function q5SiteImpact(prisma, owner, siteNodeId) {
  return prisma.$queryRawUnsafe(Q5_SQL, owner, siteNodeId);
}

/** The definitions the console registers for the kg_ models (src/kgraph/kgraph.ownership.ts), for a host without the app's registry. */
const KG_USER_OWNED_MODELS = ['KgTaskSettings', 'KgRun', 'KgNode', 'KgEdge', 'KgProcedure', 'KgProcedureVersion', 'KgEvidence', 'KgReview'].map((model) => ({
  model,
  ownerField: 'userId',
  purge: 'delete',
  export: 'include',
  rationale: 'Knowledge Graph load test: the same registration as src/kgraph/kgraph.ownership.ts.',
}));

module.exports = {
  NORMAL_SHAPE,
  scaledShape,
  seedStatements,
  rowsPerOwner,
  tasksUsingSite,
  tasksImpactedBySite,
  keys,
  q1ActiveVersion,
  q2WriteEvidence,
  q3TasksUsingSite,
  q4OwnerGraph,
  q4OwnerGraphMap,
  q5SiteImpact,
  Q3_SQL,
  Q5_SQL,
  KG_USER_OWNED_MODELS,
};
