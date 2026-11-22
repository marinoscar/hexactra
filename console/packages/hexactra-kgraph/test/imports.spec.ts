// The package imports nothing a host owns: only itself, zod, @opentelemetry/api and node: built-ins. Only src/harness/** (and its built output)
// may import @marinoscar/hexactra-agent. The scan reads the BUILT output (what a host loads) and the sources, and the rule is proved to fire.
// Run `npm run build` first: the scan fails, rather than passes, when there is no dist.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';

const PACKAGE = join(__dirname, '..');
const ALLOWED_BARE = (spec: string) => spec === 'zod' || spec === '@opentelemetry/api' || spec.startsWith('node:');
const HARNESS = '@marinoscar/hexactra-agent';

export function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g)) out.push(m[2]!);
  return out;
}

/** Every violation in one file. `root` is the folder the file must stay inside (src or dist). */
export function violations(file: string, source: string, root: string): string[] {
  const out: string[] = [];
  const inHarness = relative(root, file).split(sep)[0] === 'harness';
  for (const spec of importsOf(source)) {
    if (spec.startsWith('.')) {
      const target = normalize(join(dirname(file), spec));
      const rel = relative(root, target);
      if (rel.startsWith('..')) out.push(`${file} imports '${spec}': a relative import leaves the package`);
      else if (!inHarness && rel.split(sep)[0] === 'harness') out.push(`${file} imports '${spec}': only the harness bridge may reach src/harness`);
    } else if (spec === HARNESS || spec.startsWith(`${HARNESS}/`)) {
      if (!inHarness) out.push(`${file} imports '${spec}': only src/harness/ may import the agent harness`);
    } else if (!ALLOWED_BARE(spec)) {
      out.push(`${file} imports '${spec}': the package imports only zod, @opentelemetry/api and node: built-ins`);
    }
  }
  return out;
}

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p, ext) : ext.test(name) ? [p] : [];
  });
}

describe('what the Knowledge Graph package imports', () => {
  it('holds in the sources', () => {
    const root = join(PACKAGE, 'src');
    const files = walk(root, /\.ts$/);
    expect(files.length).toBeGreaterThan(10);
    expect(files.flatMap((f) => violations(f, readFileSync(f, 'utf8'), root))).toEqual([]);
  });

  it('holds in the built output (run `npm run build` first)', () => {
    const root = join(PACKAGE, 'dist');
    if (!existsSync(root)) throw new Error('no dist: run `npm run build` in the package (or `npm run build:packages` in console/) before the tests');
    const files = walk(root, /\.(js|d\.ts)$/);
    expect(files.length).toBeGreaterThan(20);
    expect(files.flatMap((f) => violations(f, readFileSync(f, 'utf8'), root))).toEqual([]);
  });

  it('fails on a framework, a database client, a provider SDK, a platform package, a console path, or the harness outside src/harness', () => {
    const root = join(PACKAGE, 'dist');
    const f = join(root, 'validate', 'validate.js');
    for (const spec of ['@nestjs/common', '@prisma/client', 'openai', '@marinoscar/platform-api', 'pg', '../../../apps/api/src/tasks/redact', HARNESS, `${HARNESS}/ports`, '../harness']) {
      expect(violations(f, `const x = require('${spec}');`, root)).toHaveLength(1);
      expect(violations(f, `import { x } from '${spec}';`, root)).toHaveLength(1);
    }
    expect(violations(f, `import { z } from 'zod';\nimport { trace } from '@opentelemetry/api';\nimport { a } from '../schema';\nconst c = require('node:crypto');`, root)).toEqual([]);
  });

  it('lets src/harness import the harness and nothing else a host owns', () => {
    const root = join(PACKAGE, 'src');
    const f = join(root, 'harness', 'index.ts');
    expect(violations(f, `import { executeTool } from '${HARNESS}';\nimport type { Ports } from '${HARNESS}/ports';`, root)).toEqual([]);
    expect(violations(f, `import { PrismaClient } from '@prisma/client';`, root)).toHaveLength(1);
  });
});
