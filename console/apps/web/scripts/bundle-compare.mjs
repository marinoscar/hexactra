#!/usr/bin/env node
// Builds the web app and compares every entry, lazy and shared chunk (and every stylesheet) against a baseline, raw and gzip
// (#894). The baseline is `bundle-baseline.json` (committed; the pre-epic build of E46) or a build of any git ref.
//
//   npm run bundle:compare --workspace=web                       compare with bundle-baseline.json
//   npm run bundle:compare --workspace=web -- --ref <git ref>    compare with a build of that ref (a temporary worktree)
//   npm run bundle:compare --workspace=web -- --write-baseline [--ref <git ref>]   write bundle-baseline.json
//   --json <file>   also write the current build's chunk list
//
// A chunk is named by what it is, not by its hash: an entry or lazy chunk by its facade module, a shared chunk by its name and
// its largest module. Each chunk records the bytes every module renders into it, so the report can also say which modules moved.
//
// The check (exit 1 when it fails):
// - no chunk outside the Map's own lazy chunks holds more bytes of the Map's libraries (React Flow and what it brings, dagre)
//   or of `src/kgraph/map/` than the baseline did;
// - every chunk outside the Map that the Map loads is one the baseline had, at the same size (a module the Map shares with
//   another page is not split out of that page, and keeps no export only the Map uses; build-config/map-bundle.ts).
//
// The baseline is built with today's installed packages. After a dependency upgrade that changes the shared chunks, rewrite
// it from the same commit: `npm run bundle:compare --workspace=web -- --write-baseline --ref <the sha in bundle-baseline.json>`.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE = resolve(WEB, '..', '..');
const BASELINE_PATH = join(WEB, 'bundle-baseline.json');

/** The Map's own lazy chunks: everything loaded through `lazy(() => import('../kgraph/map/MapTab'))`. */
const MAP_FACADE = /^src\/kgraph\/map\//;
/** Modules that only the Map should bring: its libraries and its own code. */
const MAP_MODULE =
  /^(node_modules\/(@xyflow|@dagrejs|zustand|classcat|d3-(zoom|drag|selection|transition|dispatch|ease|interpolate|color|timer))\/|node_modules\/use-sync-external-store\/|src\/kgraph\/map\/)/;

function parseArgs(argv) {
  const args = { ref: null, writeBaseline: false, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--ref') args.ref = argv[(i += 1)];
    else if (a === '--write-baseline') args.writeBaseline = true;
    else if (a === '--json') args.json = argv[(i += 1)];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/** A module id that is the same in every checkout: `node_modules/<pkg>/...` or a path relative to the web app. */
function moduleKey(id, webRoot) {
  const clean = id.replace(/^\0/, '').replace(/\?.*$/, (q) => (q.startsWith('?commonjs') ? '' : q));
  const nm = clean.lastIndexOf('/node_modules/');
  if (nm >= 0) return clean.slice(nm + 1);
  if (clean.startsWith('/')) {
    const rel = relative(webRoot, clean);
    return rel.startsWith('..') ? `console/${relative(resolve(webRoot, '..', '..'), clean)}` : rel;
  }
  return clean;
}

/** Builds the web app at `webRoot` (with that checkout's own Vite config) and returns its chunks and stylesheets. */
async function buildAt(webRoot) {
  const { build } = await import('vite');
  const outDir = mkdtempSync(join(tmpdir(), 'bundle-compare-out-'));
  let bundle = null;
  const collector = { name: 'bundle-compare-collector', enforce: 'post', generateBundle(_options, output) { bundle = output; } };
  const cwd = process.cwd();
  try {
    // From the app's own directory, so module ids and region comments do not depend on where the checkout is.
    process.chdir(webRoot);
    await build({ root: webRoot, configFile: join(webRoot, 'vite.config.ts'), logLevel: 'warn', plugins: [collector], build: { outDir, emptyOutDir: true, write: true } });
    if (bundle === null) throw new Error('the build produced no bundle');
    const items = Object.values(bundle);
    const sizes = (fileName) => {
      const buf = readFileSync(join(outDir, fileName));
      return { raw: buf.length, gzip: gzipSync(buf).length };
    };
    const chunks = [];
    for (const item of items) {
      if (item.type !== 'chunk') continue;
      const modules = {};
      for (const [id, info] of Object.entries(item.modules)) {
        // The module's own code, without the bundler's leading `// <path>` comment (its path depends on the checkout).
        const length = typeof info.code === 'string' ? info.code.replace(/^\/\/ [^\n]*\n/, '').length : info.renderedLength;
        if (length > 0) modules[moduleKey(id, webRoot)] = (modules[moduleKey(id, webRoot)] ?? 0) + length;
      }
      const facade = item.facadeModuleId ? moduleKey(item.facadeModuleId, webRoot) : null;
      const largest = Object.entries(modules).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? '(empty)';
      const kind = item.isEntry ? 'entry' : item.isDynamicEntry ? 'lazy' : 'shared';
      chunks.push({
        key: kind === 'shared' || facade === null ? `${kind}:${item.name}@${largest}` : `${kind}:${facade}`,
        kind,
        file: item.fileName,
        facade,
        ...sizes(item.fileName),
        imports: item.imports,
        dynamicImports: item.dynamicImports,
        css: [...(item.viteMetadata?.importedCss ?? [])],
        modules,
      });
    }
    // A stylesheet is named by the chunk that imports it.
    const cssOwner = new Map();
    for (const c of chunks) for (const f of c.css) cssOwner.set(f, c.key);
    for (const item of items) {
      if (item.type !== 'asset' || !item.fileName.endsWith('.css')) continue;
      chunks.push({ key: `css:${cssOwner.get(item.fileName) ?? item.names?.[0] ?? item.name}`, kind: 'css', file: item.fileName, facade: null, ...sizes(item.fileName), imports: [], dynamicImports: [], css: [], modules: {} });
    }
    // Two chunks that end up with one key keep their file's position, so the report stays readable.
    const seen = new Map();
    for (const c of chunks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.file < b.file ? -1 : 1))) {
      const n = seen.get(c.key) ?? 0;
      seen.set(c.key, n + 1);
      if (n > 0) c.key = `${c.key}#${n + 1}`;
    }
    markMapChunks(chunks);
    return chunks;
  } finally {
    process.chdir(cwd);
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Marks the Map's chunks: its lazy entries and every chunk only they import. */
function markMapChunks(chunks) {
  const map = new Set(chunks.filter((c) => c.facade && MAP_FACADE.test(c.facade)).map((c) => c.file));
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of chunks) {
      if (map.has(c.file) || c.kind === 'entry') continue;
      const importers = chunks.filter((o) => o.imports.includes(c.file) || o.dynamicImports.includes(c.file) || o.css.includes(c.file));
      if (importers.length > 0 && importers.every((o) => map.has(o.file))) {
        map.add(c.file);
        changed = true;
      }
    }
  }
  for (const c of chunks) c.map = map.has(c.file);
  for (const c of chunks) if (c.kind === 'css') c.map = chunks.some((o) => o.css.includes(c.file) && o.map) && !chunks.some((o) => o.css.includes(c.file) && !o.map);
}

/** A node_modules overlay for a checkout of another ref: the same installed packages, its own workspace packages. */
function linkNodeModules(fromConsole, toConsole) {
  const src = join(fromConsole, 'node_modules');
  const dst = join(toConsole, 'node_modules');
  mkdirSync(dst, { recursive: true });
  const linkEntry = (from, to) => {
    const st = lstatSync(from);
    if (st.isSymbolicLink() && readlinkSync(from).startsWith('../')) symlinkSync(readlinkSync(from), to);
    else if (existsSync(from)) symlinkSync(realpathSync(from), to);
  };
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    if (name.startsWith('@') && lstatSync(from).isDirectory()) {
      mkdirSync(join(dst, name));
      for (const sub of readdirSync(from)) linkEntry(join(from, sub), join(dst, name, sub));
    } else linkEntry(from, join(dst, name));
  }
  const webNm = join(fromConsole, 'apps', 'web', 'node_modules');
  if (existsSync(webNm) && !existsSync(join(toConsole, 'apps', 'web', 'node_modules'))) symlinkSync(realpathSync(webNm), join(toConsole, 'apps', 'web', 'node_modules'));
}

async function buildRef(ref) {
  const git = (...a) => execFileSync('git', ['-C', CONSOLE, ...a], { encoding: 'utf8' }).trim();
  const sha = git('rev-parse', '--verify', `${ref}^{commit}`);
  const dir = mkdtempSync(join(tmpdir(), 'bundle-compare-ref-'));
  git('worktree', 'add', '--detach', dir, sha);
  try {
    const top = git('rev-parse', '--show-toplevel');
    const refConsole = join(dir, relative(top, CONSOLE));
    linkNodeModules(CONSOLE, refConsole);
    return { ref, sha, chunks: await buildAt(join(refConsole, 'apps', 'web')) };
  } finally {
    git('worktree', 'remove', '--force', dir);
  }
}

const fmt = (n) => (n > 0 ? `+${n}` : `${n}`);
const pad = (s, n) => String(s).padStart(n);

function compare(base, cur) {
  const baseByKey = new Map(base.chunks.map((c) => [c.key, c]));
  const curByKey = new Map(cur.chunks.map((c) => [c.key, c]));
  const keys = [...new Set([...baseByKey.keys(), ...curByKey.keys()])].sort();
  const rows = [];
  for (const key of keys) {
    const b = baseByKey.get(key);
    const c = curByKey.get(key);
    rows.push({ key, map: c?.map ?? b?.map ?? false, base: b ?? null, cur: c ?? null, raw: (c?.raw ?? 0) - (b?.raw ?? 0), gzip: (c?.gzip ?? 0) - (b?.gzip ?? 0) });
  }
  console.log(`Baseline: ${base.ref ?? 'bundle-baseline.json'}${base.sha ? ` (${base.sha.slice(0, 12)})` : ''}. Gzip is zlib's default level.`);
  console.log('');
  console.log(`${'chunk'.padEnd(78)} ${pad('base raw', 10)} ${pad('now raw', 10)} ${pad('Δ raw', 9)} ${pad('Δ gzip', 8)}  note`);
  let changed = 0;
  for (const r of rows) {
    if (r.base && r.cur && r.raw === 0 && r.gzip === 0) continue;
    const note = !r.base ? 'new' : !r.cur ? 'gone' : r.raw === 0 ? 'same size: only the hashed names of the chunks it imports changed' : '';
    changed += 1;
    const label = `${r.map ? '[map] ' : ''}${r.key}`;
    console.log(`${label.length > 78 ? `…${label.slice(-77)}` : label.padEnd(78)} ${pad(r.base?.raw ?? '-', 10)} ${pad(r.cur?.raw ?? '-', 10)} ${pad(fmt(r.raw), 9)} ${pad(fmt(r.gzip), 8)}  ${note}`);
    if (r.cur && r.base) {
      const moved = moduleDiff(r.base.modules, r.cur.modules).slice(0, 6);
      for (const [m, d] of moved) console.log(`    ${fmt(d).padStart(8)}  ${m}`);
    } else if (r.cur && r.cur.kind !== 'css') {
      for (const [m, d] of Object.entries(r.cur.modules).sort((a, b) => b[1] - a[1]).slice(0, 4)) console.log(`    ${fmt(d).padStart(8)}  ${m}`);
    }
  }
  const sum = (list, k) => list.reduce((n, c) => n + c[k], 0);
  const unchanged = rows.length - changed;
  console.log('');
  console.log(`${rows.length} chunks and stylesheets, ${changed} changed, ${unchanged} unchanged.`);
  console.log(`Total: ${sum(base.chunks, 'raw')} → ${sum(cur.chunks, 'raw')} bytes raw (${fmt(sum(cur.chunks, 'raw') - sum(base.chunks, 'raw'))}), ${sum(base.chunks, 'gzip')} → ${sum(cur.chunks, 'gzip')} gzip (${fmt(sum(cur.chunks, 'gzip') - sum(base.chunks, 'gzip'))}).`);
  const mapNow = cur.chunks.filter((c) => c.map);
  console.log(`The Map's own chunks: ${mapNow.map((c) => c.key).join(', ') || 'none'} (${sum(mapNow, 'raw')} bytes raw, ${sum(mapNow, 'gzip')} gzip).`);

  // The check: bytes of the Map's modules outside the Map's chunks, now against the baseline, module by module.
  const outside = (chunks) => {
    const total = {};
    for (const c of chunks) if (!c.map) for (const [m, n] of Object.entries(c.modules)) if (MAP_MODULE.test(m)) total[m] = (total[m] ?? 0) + n;
    return total;
  };
  const leaks = moduleDiff(outside(base.chunks), outside(cur.chunks)).filter(([, d]) => d > 0);
  // And every chunk outside the Map that the Map loads is one the baseline already had, at the same size: a module the Map
  // shares with another page must not be split out of that page, or keep exports only the Map uses, for the Map.
  const curByFile = new Map(cur.chunks.map((c) => [c.file, c]));
  const sharedWithMap = [...new Set(cur.chunks.filter((c) => c.map).flatMap((c) => [...c.imports, ...c.css]))]
    .map((f) => curByFile.get(f))
    .filter((c) => c && !c.map);
  const split = sharedWithMap.filter((c) => baseByKey.get(c.key)?.raw !== c.raw);
  console.log('');
  console.log(`The Map also loads ${sharedWithMap.length} chunks other pages load; ${sharedWithMap.length - split.length} of them are unchanged from the baseline.`);
  if (leaks.length === 0 && split.length === 0) {
    console.log('PASS: no chunk outside the Map holds more of the Map libraries or of src/kgraph/map/ than the baseline, and no chunk the Map shares with another page is new or changed.');
    return true;
  }
  if (leaks.length > 0) {
    console.log('FAIL: Map modules grew outside the Map chunks:');
    for (const [m, d] of leaks) console.log(`    ${fmt(d).padStart(8)}  ${m}`);
  }
  if (split.length > 0) {
    console.log('FAIL: chunks the Map shares with other pages are new or changed:');
    for (const c of split) console.log(`    ${c.key} (${baseByKey.get(c.key)?.raw ?? 'new'} → ${c.raw} bytes)`);
  }
  return false;
}

/** Per-module rendered-byte differences, largest first. */
function moduleDiff(before, after) {
  const out = [];
  for (const m of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[m] ?? 0) - (before[m] ?? 0);
    if (d !== 0) out.push([m, d]);
  }
  return out.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  if (args.writeBaseline) {
    const base = args.ref ? await buildRef(args.ref) : { ref: 'HEAD', sha: null, chunks: await buildAt(WEB) };
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ ref: base.ref, sha: base.sha, chunks: base.chunks.map(({ imports, dynamicImports, css, ...c }) => ({ ...c, imports, dynamicImports, css })) }, null, 1)}\n`);
    console.log(`Wrote ${relative(process.cwd(), BASELINE_PATH)} from ${base.ref}${base.sha ? ` (${base.sha.slice(0, 12)})` : ''}: ${base.chunks.length} chunks and stylesheets.`);
    return;
  }
  const base = args.ref ? await buildRef(args.ref) : JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const cur = { ref: 'working tree', chunks: await buildAt(WEB) };
  if (args.json) writeFileSync(args.json, `${JSON.stringify(cur, null, 1)}\n`);
  const ok = compare(base, cur);
  console.log(`(${Math.round((Date.now() - started) / 1000)} s)`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
