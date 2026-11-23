#!/usr/bin/env node
// The Knowledge Graph storage load test (E46.4, #778). Builds dataset A (`--owners` owners at the sizing assumption) with dataset B inside it
// (the first `--heavy` owners at `--heavy-factor` times the size), then measures the five queries cold and warm, `--iterations` times each,
// and writes p50/p95/p99, EXPLAIN (ANALYZE, BUFFERS) of every statement and the row counts to a JSON file.
//
//   npm run kgraph:loadtest --workspace=api -- --owners 200 --heavy 1 --database hexactra_kgraph_load
//
// Only for a THROWAWAY database: it inserts millions of rows (owners `<prefix>-<n>@load.test`) and creates a scratch table and the
// pg_prewarm extension there. The database name must contain "load" (or pass --allow-any-database). Connection: POSTGRES_HOST, _PORT,
// _USER, _PASSWORD, _DB, _SSL (as the API reads them); `--database` replaces POSTGRES_DB.
//
// Cold: the OS page cache is dropped (when the process may write /proc/sys/vm/drop_caches) and shared_buffers is overwritten with a scratch
// table (pg_prewarm), then each iteration reads a key no earlier iteration of the phase read. Warm: a small set of keys, read once
// unmeasured, then read in turn. Times are client-side wall time of the Prisma calls (what the host sees), in milliseconds.
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const lib = require('./kgraph-loadtest-lib.js');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { buildDatabaseUrl, registerUserOwnedModels, userScopeExtension } = require('@marinoscar/platform-api/core');
const pg = require('pg');

const { values: args } = parseArgs({
  options: {
    owners: { type: 'string', default: '200' },
    heavy: { type: 'string', default: '1' },
    'heavy-factor': { type: 'string', default: '10' },
    iterations: { type: 'string', default: '1000' },
    'heavy-iterations': { type: 'string' },
    'heavy-cold-samples': { type: 'string', default: '5' },
    'warm-keys': { type: 'string', default: '20' },
    database: { type: 'string' },
    prefix: { type: 'string', default: 'kgload' },
    chunk: { type: 'string', default: '10' },
    queries: { type: 'string', default: '1,2,3,4,5' },
    'q4-variants': { type: 'string', default: 'all' },
    seed: { type: 'string', default: '778' },
    out: { type: 'string' },
    'skip-load': { type: 'boolean', default: false },
    reset: { type: 'boolean', default: false },
    'allow-any-database': { type: 'boolean', default: false },
  },
});

const num = (k) => {
  const n = Number(args[k]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${k} must be a non-negative integer`);
  return n;
};
const OWNERS = num('owners');
const HEAVY = num('heavy');
const FACTOR = num('heavy-factor');
const ITER = num('iterations');
const HEAVY_ITER = args['heavy-iterations'] === undefined ? ITER : num('heavy-iterations');
const HEAVY_COLD = num('heavy-cold-samples');
const WARM_KEYS = num('warm-keys');
const CHUNK = Math.max(1, num('chunk'));
const PREFIX = args.prefix;
if (!/^[a-z0-9-]{1,20}$/.test(PREFIX)) throw new Error('--prefix: lowercase letters, digits and - only');
if (HEAVY > OWNERS) throw new Error('--heavy cannot exceed --owners (the heavy owners are inside dataset A)');
const QUERIES = new Set(args.queries.split(',').map((s) => s.trim()));

const env = { ...process.env, ...(args.database ? { POSTGRES_DB: args.database } : {}) };
const DB = env.POSTGRES_DB;
if (!DB) throw new Error('POSTGRES_DB (or --database) is required');
if (!/load/i.test(DB) && !args['allow-any-database']) throw new Error(`refusing to load into "${DB}": the name must contain "load" (a throwaway database) or pass --allow-any-database`);

const NORMAL = lib.NORMAL_SHAPE;
const HEAVY_SHAPE = lib.scaledShape(NORMAL, FACTOR);
const shapeOf = (o) => (o < HEAVY ? HEAVY_SHAPE : NORMAL);
const log = (...m) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${m.join(' ')}\n`);

// ---------------------------------------------------------------- clients
const url = buildDatabaseUrl(env);
const sql = new pg.Client({ connectionString: url });
await sql.connect();
const prisma = new PrismaClient({ adapter: new PrismaPg(url), log: [{ level: 'query', emit: 'event' }] });
let capture = null;
prisma.$on('query', (e) => {
  if (capture) capture.push({ query: e.query, params: e.params });
});
registerUserOwnedModels(lib.KG_USER_OWNED_MODELS);
// As PrismaService.forUser: a fresh scoped client per call, exactly as the store builds one.
const db = (owner) => prisma.$extends(userScopeExtension({ userId: owner }));
await prisma.$connect();

// ---------------------------------------------------------------- the dataset
async function loadedOwners() {
  const r = await sql.query(`SELECT count(*)::int AS n FROM users WHERE email LIKE $1`, [`${PREFIX}-%@load.test`]);
  return r.rows[0].n;
}

async function load() {
  if (args.reset) {
    log('reset: deleting the synthetic owners (cascade)');
    await sql.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%@load.test`]);
  }
  const have = await loadedOwners();
  if (have === OWNERS) {
    log(`dataset present: ${have} owners under prefix ${PREFIX}`);
    return { loaded: false, seconds: 0 };
  }
  if (have !== 0) throw new Error(`${have} owners under prefix ${PREFIX} exist, ${OWNERS} wanted: pass --reset`);
  await sql.query('SET synchronous_commit = off');
  const t0 = performance.now();
  const ranges = [];
  for (let o = 0; o < HEAVY; o += 1) ranges.push([o, o + 1, HEAVY_SHAPE]);
  for (let o = HEAVY; o < OWNERS; o += CHUNK) ranges.push([o, Math.min(OWNERS, o + CHUNK), NORMAL]);
  for (const [lo, hi, shape] of ranges) {
    const t = performance.now();
    await sql.query('BEGIN');
    for (const s of lib.seedStatements(shape)) await sql.query(s.sql, [PREFIX, lo, hi]);
    await sql.query('COMMIT');
    log(`owners ${lo}..${hi - 1} loaded in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  }
  const seconds = (performance.now() - t0) / 1000;
  log(`VACUUM (ANALYZE) of the loaded tables`);
  for (const t of ['users', 'tasks', 'runs', 'kg_procedures', 'kg_procedure_versions', 'kg_evidence', 'kg_nodes', 'kg_edges']) await sql.query(`VACUUM (ANALYZE) ${t}`);
  return { loaded: true, seconds };
}

const TABLES = ['users', 'tasks', 'runs', 'run_steps', 'kg_procedures', 'kg_procedure_versions', 'kg_evidence', 'kg_nodes', 'kg_edges'];
async function rowCounts() {
  const out = {};
  for (const t of TABLES) {
    const c = await sql.query(`SELECT count(*)::bigint AS n, pg_total_relation_size($1::regclass) AS bytes FROM ${t}`, [t]);
    out[t] = { rows: Number(c.rows[0].n), totalBytes: Number(c.rows[0].bytes) };
  }
  const h = lib.keys.owner(PREFIX, 0);
  const heavy = {};
  for (const t of ['kg_procedures', 'kg_procedure_versions', 'kg_evidence', 'kg_nodes', 'kg_edges']) heavy[t] = Number((await sql.query(`SELECT count(*)::bigint AS n FROM ${t} WHERE user_id = $1`, [h])).rows[0].n);
  return { tables: out, heavyOwner: heavy, expectedPerNormalOwner: lib.rowsPerOwner(NORMAL), expectedPerHeavyOwner: lib.rowsPerOwner(HEAVY_SHAPE) };
}

// ---------------------------------------------------------------- cold: drop caches
let coldMethod = null;
async function prepareCold() {
  const method = [];
  try {
    await sql.query('CREATE EXTENSION IF NOT EXISTS pg_prewarm');
    await sql.query(`CREATE TABLE IF NOT EXISTS kgload_flush (id int, pad text)`);
    const sb = (await sql.query(`SELECT setting::bigint * 8192 AS bytes FROM pg_settings WHERE name = 'shared_buffers'`)).rows[0].bytes;
    const rows = Math.ceil((Number(sb) * 2) / 1100);
    const have = Number((await sql.query('SELECT count(*) AS n FROM kgload_flush')).rows[0].n);
    if (have < rows) {
      await sql.query('TRUNCATE kgload_flush');
      await sql.query(`INSERT INTO kgload_flush SELECT g, repeat(md5(g::text), 32) FROM generate_series(1, ${rows}) g`);
    }
    method.push(`shared_buffers (${Math.round(Number(sb) / 1048576)} MB) overwritten with a ${Math.round((rows * 1100) / 1048576)} MB scratch table through pg_prewarm`);
  } catch (e) {
    method.push(`shared_buffers NOT flushed (${e.message})`);
  }
  try {
    writeFileSync('/proc/sys/vm/drop_caches', '3');
    method.push('OS page cache dropped (sync; echo 3 > /proc/sys/vm/drop_caches)');
  } catch (e) {
    method.push(`OS page cache NOT dropped (${e.code ?? e.message})`);
  }
  coldMethod = method;
}
async function flush() {
  if (coldMethod?.[0]?.startsWith('shared_buffers (')) await sql.query(`SELECT pg_prewarm('kgload_flush', 'buffer')`);
  try {
    require('node:child_process').execFileSync('sync');
    writeFileSync('/proc/sys/vm/drop_caches', '3');
  } catch {
    /* recorded in coldMethod */
  }
}

// ---------------------------------------------------------------- measuring
let rand = (() => {
  let a = Number(args.seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
const pick = (n) => Math.floor(rand() * n);

function stats(samples) {
  const s = [...samples].sort((x, y) => x - y);
  const at = (q) => s[Math.max(0, Math.ceil(q * s.length) - 1)];
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), mean: s.reduce((a, b) => a + b, 0) / s.length, min: s[0], max: s[s.length - 1] };
}

async function timeIt(fn) {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

/** The SQL statements one call issues, captured from Prisma's query events (transaction control left out). */
async function statementsOf(fn) {
  capture = [];
  try {
    await fn();
  } finally {
    var got = capture;
    capture = null;
  }
  return got.filter((s) => !/^\s*(BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE)/i.test(s.query));
}

/** EXPLAIN (ANALYZE, BUFFERS) of each statement with its own parameters, inside a transaction that is rolled back. */
async function explain(statements) {
  const out = [];
  await sql.query('BEGIN');
  try {
    for (const s of statements) {
      const params = typeof s.params === 'string' ? JSON.parse(s.params) : s.params;
      const r = await sql.query(`EXPLAIN (ANALYZE, BUFFERS) ${s.query}`, params);
      out.push({ sql: s.query, plan: r.rows.map((x) => x['QUERY PLAN']).join('\n') });
    }
  } finally {
    await sql.query('ROLLBACK');
  }
  return out;
}

// The keys.
const normalOwners = [];
for (let o = HEAVY; o < OWNERS; o += 1) normalOwners.push(o);
const owner = (o) => lib.keys.owner(PREFIX, o);
const shuffled = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = pick(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
/** `n` distinct (owner, index) keys over every owner, `size(owner)` indexes per owner. */
function distinctKeys(n, size) {
  const seen = new Set();
  const out = [];
  let guard = 0;
  while (out.length < n && guard < n * 50) {
    guard += 1;
    const o = pick(OWNERS);
    const i = pick(size(shapeOf(o)));
    const k = `${o}:${i}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ o, i });
  }
  return out;
}

const seqs = new Map();
async function runOf(o) {
  if (!seqs.has(o)) {
    const id = lib.keys.run(PREFIX, o);
    const r = await sql.query('SELECT COALESCE(max(seq), 0)::int AS m FROM run_steps WHERE run_id = $1', [id]);
    seqs.set(o, { id, next: r.rows[0].m + 1 });
  }
  const r = seqs.get(o);
  return { id: r.id, get seq() {
    return r.next++;
  } };
}

// Each query: how to build a key, how to run it on a key.
const QUERY_DEFS = {
  1: {
    name: 'Load one task\'s active procedure version (with its evidence)',
    bar: { warmP95Ms: 50 },
    size: (s) => s.tasks,
    run: async ({ o, i }) => {
      const v = await lib.q1ActiveVersion(db, owner(o), lib.keys.task(PREFIX, o, i));
      if (!v || v.evidence.length !== shapeOf(o).steps + 1) throw new Error('q1: wrong result');
    },
  },
  2: {
    name: 'Write evidence for one step (in a transaction with a run_steps insert)',
    bar: { warmP95Ms: 50 },
    size: (s) => s.tasks * s.steps,
    run: async ({ o, i }, opts) => {
      const s = shapeOf(o);
      const t = Math.floor(i / s.steps);
      const step = `s${(i % s.steps) + 1}`;
      const run = await runOf(o);
      const r = await lib.q2WriteEvidence(prisma, owner(o), lib.keys.version(PREFIX, o, t, s.versions), step, opts?.rollback ? { id: run.id, seq: 2147480000 } : run, opts);
      if (!opts?.rollback && (!r || r.successes < 1)) throw new Error('q2: wrong result');
    },
  },
  3: {
    name: 'Which tasks use this site (one join)',
    bar: { warmP95Ms: 50 },
    size: (s) => s.sites,
    run: async ({ o, i }) => {
      const rows = await lib.q3TasksUsingSite(prisma, owner(o), lib.keys.siteNode(PREFIX, o, i));
      if (rows.length !== lib.tasksUsingSite(shapeOf(o), i).length) throw new Error(`q3: ${rows.length} rows`);
    },
  },
  5: {
    name: 'Impact of a site: site <- screens <- elements <- steps <- tasks',
    bar: { warmP95Ms: 50 },
    size: (s) => s.sites,
    run: async ({ o, i }) => {
      const rows = await lib.q5SiteImpact(prisma, owner(o), lib.keys.siteNode(PREFIX, o, i));
      if (rows.length !== lib.tasksImpactedBySite(shapeOf(o), i).length) throw new Error(`q5: ${rows.length} rows`);
    },
  },
};
let q4fn = lib.q4OwnerGraph;
const q4run = async (o) => {
  const g = await q4fn(db, owner(o));
  const want = lib.rowsPerOwner(shapeOf(o));
  if (g.nodes.length !== want.kg_nodes || g.edges.length !== want.kg_edges) throw new Error(`q4: ${g.nodes.length} nodes, ${g.edges.length} edges`);
};

async function measurePerKey(def) {
  // Plans first (they warm what they touch; the cold phase flushes after).
  const planKey = distinctKeys(1, def.size)[0];
  const stmts = await statementsOf(() => def.run(planKey, { rollback: true }));
  await flush();
  const coldPlan = await explain(stmts);
  // Cold.
  const coldKeys = distinctKeys(ITER, def.size);
  await flush();
  const cold = [];
  for (const k of coldKeys) cold.push(await timeIt(() => def.run(k)));
  // Warm.
  const warmKeys = distinctKeys(WARM_KEYS, def.size);
  for (let pass = 0; pass < 2; pass += 1) for (const k of warmKeys) await def.run(k);
  const warm = [];
  for (let n = 0; n < ITER; n += 1) warm.push(await timeIt(() => def.run(warmKeys[n % warmKeys.length])));
  const warmStmts = await statementsOf(() => def.run(warmKeys[0], { rollback: true }));
  const warmPlan = await explain(warmStmts);
  return { cold: stats(cold), warm: stats(warm), plans: { cold: coldPlan, warm: warmPlan } };
}

async function measureQ4() {
  const res = {};
  // Normal owner.
  {
    const o = normalOwners[0];
    const stmts = await statementsOf(() => q4run(o));
    await flush();
    const coldPlan = await explain(stmts);
    const coldOwners = shuffled(normalOwners).slice(0, Math.min(ITER, normalOwners.length));
    await flush();
    const cold = [];
    for (const c of coldOwners) cold.push(await timeIt(() => q4run(c)));
    const warmOwners = shuffled(normalOwners).slice(0, Math.min(5, normalOwners.length));
    for (const w of warmOwners) await q4run(w);
    const warm = [];
    for (let n = 0; n < ITER; n += 1) warm.push(await timeIt(() => q4run(warmOwners[n % warmOwners.length])));
    const warmPlan = await explain(await statementsOf(() => q4run(warmOwners[0])));
    res.normal = { bar: { warmP95Ms: 500 }, cold: stats(cold), warm: stats(warm), plans: { cold: coldPlan, warm: warmPlan } };
    log(`q4 normal: cold p95 ${res.normal.cold.p95.toFixed(1)} ms, warm p95 ${res.normal.warm.p95.toFixed(1)} ms`);
  }
  if (HEAVY > 0) {
    const stmts = await statementsOf(() => q4run(0));
    await flush();
    const coldPlan = await explain(stmts);
    const cold = [];
    for (let n = 0; n < HEAVY_COLD; n += 1) {
      await flush();
      cold.push(await timeIt(() => q4run(n % HEAVY)));
    }
    await q4run(0);
    const warm = [];
    for (let n = 0; n < HEAVY_ITER; n += 1) {
      warm.push(await timeIt(() => q4run(n % HEAVY)));
      if (n % 100 === 99) log(`q4 heavy warm: ${n + 1}/${HEAVY_ITER}`);
    }
    const warmPlan = await explain(await statementsOf(() => q4run(0)));
    // Diagnostic: the same statements through node-postgres (no Prisma), warm, to show how much of the time is the database and the wire.
    const direct = [];
    for (let n = 0; n < Math.min(100, HEAVY_ITER); n += 1) {
      direct.push(
        await timeIt(async () => {
          for (const st of stmts) await sql.query(st.query, typeof st.params === 'string' ? JSON.parse(st.params) : st.params);
        }),
      );
    }
    res.heavyNodePostgres = { note: 'diagnostic: the same SQL through node-postgres, one statement after the other, warm', warm: stats(direct) };
    res.heavy = { bar: { warmP95Ms: 2000 }, cold: stats(cold), warm: stats(warm), plans: { cold: coldPlan, warm: warmPlan } };
    log(`q4 heavy: cold p95 ${res.heavy.cold.p95.toFixed(1)} ms, warm p95 ${res.heavy.warm.p95.toFixed(1)} ms`);
  }
  return res;
}

/** The evidence statements of the store's own recordEvidence (through the scoped client) against the transaction's: they must be the same SQL. */
async function q2Fidelity() {
  const o = HEAVY < OWNERS ? HEAVY : 0;
  const s = shapeOf(o);
  const version = lib.keys.version(PREFIX, o, 0, s.versions);
  const scoped = db(owner(o));
  const store = await statementsOf(async () => {
    const when = new Date();
    const v = await scoped.kgProcedureVersion.findFirst({ where: { id: version, userId: owner(o) }, select: { id: true } });
    if (!v) throw new Error('version');
    for (const stepId of ['', 's1']) await scoped.kgEvidence.upsert({ where: { versionId_stepId: { versionId: version, stepId } }, create: { userId: owner(o), versionId: version, stepId, successes: 1, failures: 0, repairs: 0, lastSuccessAt: when, lastFailureAt: null }, update: { successes: { increment: 1 }, lastSuccessAt: when } });
  });
  const tx = await statementsOf(() => QUERY_DEFS[2].run({ o, i: 0 }, { rollback: true }));
  const a = store.map((x) => x.query);
  const b = tx.map((x) => x.query).filter((q) => !/"run_steps"/.test(q));
  return { same: JSON.stringify(a) === JSON.stringify(b), store: a, transaction: b };
}

// ---------------------------------------------------------------- main
const started = new Date();
const build = await load();
const counts = await rowCounts();
log(`rows: ${Object.entries(counts.tables).map(([t, c]) => `${t}=${c.rows}`).join(' ')}`);
await prepareCold();
log(`cold method: ${coldMethod.join('; ')}`);
const pgVersion = (await sql.query('SELECT version() AS v')).rows[0].v;
const settings = Object.fromEntries((await sql.query(`SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','effective_cache_size','random_page_cost','max_connections','jit')`)).rows.map((r) => [r.name, r.unit ? `${r.setting} x ${r.unit}` : r.setting]));
let memTotalKb = null;
try {
  memTotalKb = Number(/MemTotal:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))[1]);
} catch {
  memTotalKb = Math.round(totalmem() / 1024);
}

const results = {};
const fidelity = QUERIES.has('2') ? await q2Fidelity() : null;
if (fidelity) log(`q2 fidelity (store statements = transaction statements): ${fidelity.same}`);
for (const q of ['1', '2', '3', '4', '5']) {
  if (!QUERIES.has(q)) continue;
  log(`query ${q}...`);
  if (q === '4') {
    const variants = args['q4-variants'];
    if (variants === 'all' || variants === 'full') {
      q4fn = lib.q4OwnerGraph;
      results[q] = { name: 'Load the whole graph of one owner for the Map (nodes and edges, every column)', ...(await measureQ4()) };
    }
    // The same rows with only the columns the Map draws: a second shape of the same query, reported beside it (it does not replace it).
    if (variants === 'all' || variants === 'map') {
      q4fn = lib.q4OwnerGraphMap;
      results['4m'] = { name: 'Load the whole graph of one owner, Map columns only (node id, type, key, label; edge id, type, from, to)', ...(await measureQ4()) };
    }
    q4fn = lib.q4OwnerGraph;
  }
  else {
    const def = QUERY_DEFS[q];
    results[q] = { name: def.name, bar: def.bar, ...(await measurePerKey(def)) };
    log(`q${q}: cold p95 ${results[q].cold.p95.toFixed(2)} ms, warm p95 ${results[q].warm.p95.toFixed(2)} ms`);
  }
}

// Verdicts: the bar is on the warm p95, compared unrounded.
const verdicts = [];
const verdict = (label, r) => verdicts.push({ query: label, bar: `warm p95 <= ${r.bar.warmP95Ms} ms`, warmP95Ms: r.warm.p95, coldP95Ms: r.cold.p95, met: r.warm.p95 <= r.bar.warmP95Ms, coldWithinBar: r.cold.p95 <= r.bar.warmP95Ms });
for (const q of ['1', '2', '3', '5']) if (results[q]) verdict(`q${q}`, results[q]);
if (results['4']?.normal) verdict('q4 normal owner', results['4'].normal);
if (results['4']?.heavy) verdict('q4 heavy owner', results['4'].heavy);
if (results['4m']?.normal) verdict('q4 normal owner, Map columns', results['4m'].normal);
if (results['4m']?.heavy) verdict('q4 heavy owner, Map columns', results['4m'].heavy);

const out = {
  issue: 'E46.4 (#778)',
  startedAt: started.toISOString(),
  finishedAt: new Date().toISOString(),
  command: `node scripts/kgraph-loadtest.mjs ${process.argv.slice(2).join(' ')}`,
  postgres: { version: pgVersion, settings },
  machine: { cpu: cpus()[0]?.model, cpus: cpus().length, memTotalKb, node: process.version },
  dataset: { owners: OWNERS, heavyOwners: HEAVY, heavyFactor: FACTOR, normalShape: NORMAL, heavyShape: HEAVY_SHAPE, build, counts },
  method: { iterations: ITER, heavyIterations: HEAVY_ITER, heavyColdSamples: HEAVY_COLD, warmKeys: WARM_KEYS, cold: coldMethod, timing: 'client wall time of the Prisma calls, ms', percentiles: 'nearest rank' },
  q2Fidelity: fidelity,
  results,
  verdicts,
  allMet: verdicts.every((v) => v.met),
};
const file = args.out ?? `kgraph-loadtest-${started.toISOString().slice(0, 10)}.json`;
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
const f = (x) => x.toFixed(2);
console.log('| Query | Cold p50 | Cold p95 | Cold p99 | Warm p50 | Warm p95 | Warm p99 | Bar | Verdict |');
console.log('|---|---|---|---|---|---|---|---|---|');
const row = (label, r) => console.log(`| ${label} | ${f(r.cold.p50)} | ${f(r.cold.p95)} | ${f(r.cold.p99)} | ${f(r.warm.p50)} | ${f(r.warm.p95)} | ${f(r.warm.p99)} | warm p95 <= ${r.bar.warmP95Ms} ms | ${r.warm.p95 <= r.bar.warmP95Ms ? 'met' : 'MISSED'} |`);
for (const q of ['1', '2', '3']) if (results[q]) row(`q${q}`, results[q]);
if (results['4']?.normal) row('q4 normal', results['4'].normal);
if (results['4']?.heavy) row('q4 heavy', results['4'].heavy);
if (results['4m']?.normal) row('q4 normal, Map columns', results['4m'].normal);
if (results['4m']?.heavy) row('q4 heavy, Map columns', results['4m'].heavy);
if (results['5']) row('q5', results['5']);
log(`written ${file}; all bars met: ${out.allMet}`);
await prisma.$disconnect();
await sql.end();
process.exit(out.allMet ? 0 : 2);
