// The web toolset imports the harness and nothing else a host owns (E50.4, as the browser toolset, E38.9): no NestJS, no Prisma, no provider
// SDK, no HTTP client, no console path, and not the browser toolset. The scan reads the BUILT output and the sources; the rule is proved to
// fire. Run `npm run build` first: the scan fails, rather than passes, when there is no dist.
// Two more rules: a tool imports no other tool and no loop code (`@marinoscar/hexactra-agent/engine`); a gate imports no loop code.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const PACKAGE = join(__dirname, '..');
const HARNESS = '@marinoscar/hexactra-agent';
const ALLOWED_BARE = (spec: string) => spec === 'zod' || spec.startsWith('node:') || spec === HARNESS || spec.startsWith(`${HARNESS}/`);
/** What a tool or a gate may not import: the loop and everything that drives it. */
const LOOP = `${HARNESS}/engine`;

export function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g)) out.push(m[2]!);
  return out;
}

/** Every violation in one file (`rel` is its path inside src or dist, with forward slashes): `file imports spec: why`. */
export function violations(file: string, source: string, root: string): string[] {
  const out: string[] = [];
  const rel = relative(root, file).split('\\').join('/');
  const isTool = /^tools\/(?!index)/.test(rel);
  const isGate = /^gates\/(?!index)/.test(rel);
  for (const spec of importsOf(source)) {
    const fail = (why: string) => out.push(`${file} imports '${spec}': ${why}`);
    if (spec.startsWith('.')) {
      const target = relative(root, normalize(join(dirname(file), spec))).split('\\').join('/');
      if (target.startsWith('..')) fail('a relative import leaves the package');
      if (isTool && /^tools\/(?!index)/.test(target) && target !== rel.replace(/\.(js|d\.ts|ts)$/, '')) fail('a tool does not import another tool');
    } else if (!ALLOWED_BARE(spec)) {
      fail('the web toolset imports only @marinoscar/hexactra-agent, zod and node: built-ins');
    }
    if ((isTool || isGate) && (spec === LOOP || spec === `${HARNESS}/testing`)) fail('a tool or a gate does not import the loop');
  }
  return out;
}

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p, ext) : ext.test(name) ? [p] : [];
  });
}

// `testing/` is the one folder that imports the harness's `testing` export: it is not shipped to a production host's loop.
const inTesting = (root: string, f: string) => relative(root, f).split('\\').join('/').startsWith('testing/');

describe('what the web toolset imports', () => {
  it('holds in the sources', () => {
    const root = join(PACKAGE, 'src');
    const files = walk(root, /\.ts$/);
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => !inTesting(root, f)).flatMap((f) => violations(f, readFileSync(f, 'utf8'), root))).toEqual([]);
  });

  it('holds in the built output (run `npm run build` first)', () => {
    const root = join(PACKAGE, 'dist');
    if (!existsSync(root)) throw new Error('no dist: run `npm run build` in the package (or `npm run build:packages` in console/) before the tests');
    const files = walk(root, /\.(js|d\.ts)$/);
    expect(files.length).toBeGreaterThan(20);
    expect(files.flatMap((f) => violations(f, readFileSync(f, 'utf8'), root))).toEqual([]);
  });

  it('fails when a file imports a framework, a database client, an HTTP client, the browser toolset or a console path', () => {
    const root = join(PACKAGE, 'src');
    const f = join(root, 'results.ts');
    for (const spec of ['@nestjs/common', '@prisma/client', '@marinoscar/platform-api/ai', 'openai', 'undici', '@marinoscar/hexactra-browser-agent', '../../apps/api/src/web-search/registry']) {
      expect(violations(f, `import { x } from '${spec}';`, root)).toHaveLength(1);
      expect(violations(f, `const x = require('${spec}');`, root)).toHaveLength(1);
    }
    expect(violations(f, `import { x } from '${HARNESS}';\nimport { z } from 'zod';\nimport { h } from 'node:crypto';\nimport { p } from './ports';`, root)).toEqual([]);
  });

  it('fails when a tool imports the loop or another tool, or a gate imports the loop', () => {
    const root = join(PACKAGE, 'src');
    expect(violations(join(root, 'tools/web-search.ts'), `import { runLoop } from '${LOOP}';`, root)).toHaveLength(1);
    expect(violations(join(root, 'tools/web-search.ts'), `import { webFetch } from './web-fetch';`, root)).toHaveLength(1);
    expect(violations(join(root, 'gates/web-site-gate.ts'), `import { executeTool } from '${LOOP}';`, root)).toHaveLength(1);
    expect(violations(join(root, 'tools/web-search.ts'), `import { a } from '../results';\nimport { b } from '${HARNESS}';`, root)).toEqual([]);
    expect(violations(join(root, 'tools/index.ts'), `import { webSearch } from './web-search';`, root)).toEqual([]);
  });
});
