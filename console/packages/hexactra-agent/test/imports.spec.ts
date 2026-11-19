// The harness imports nothing a host owns (E38.9): no NestJS, no Prisma, no provider SDK, no platform package, no fabric client, no console
// path. The scan reads the BUILT output (what a host actually loads) and the sources, and the rule is proved to fire on a violation.
// Run `npm run build` first: the scan fails, rather than passes, when there is no dist.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const PACKAGE = join(__dirname, '..');
const ALLOWED_BARE = (spec: string) => spec === 'zod' || spec === '@opentelemetry/api' || spec.startsWith('node:');

export function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g)) out.push(m[2]!);
  return out;
}

/** Every violation in one file: `file imports spec: why`. `root` is the folder the file must stay inside (src or dist). */
export function violations(file: string, source: string, root: string): string[] {
  const out: string[] = [];
  for (const spec of importsOf(source)) {
    if (spec.startsWith('.')) {
      const target = normalize(join(dirname(file), spec));
      if (relative(root, target).startsWith('..')) out.push(`${file} imports '${spec}': a relative import leaves the package`);
    } else if (!ALLOWED_BARE(spec)) {
      out.push(`${file} imports '${spec}': the harness imports only zod, @opentelemetry/api and node: built-ins`);
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

describe('what the harness imports', () => {
  it('holds in the sources', () => {
    const root = join(PACKAGE, 'src');
    const files = walk(root, /\.ts$/);
    expect(files.length).toBeGreaterThan(20);
    expect(files.flatMap((f) => violations(f, readFileSync(f, 'utf8'), root))).toEqual([]);
  });

  it('holds in the built output (run `npm run build` first)', () => {
    const root = join(PACKAGE, 'dist');
    if (!existsSync(root)) throw new Error('no dist: run `npm run build` in the package (or `npm run build:packages` in console/) before the tests');
    const files = walk(root, /\.(js|d\.ts)$/);
    expect(files.length).toBeGreaterThan(40);
    expect(files.flatMap((f) => violations(f, readFileSync(f, 'utf8'), root))).toEqual([]);
  });

  it('fails when a file imports a framework, a database client, a provider SDK, the fabric, a platform package or a console path', () => {
    const root = join(PACKAGE, 'dist');
    const f = join(root, 'steps.js');
    for (const spec of ['@nestjs/common', '@prisma/client', 'openai', '@anthropic-ai/sdk', '@marinoscar/platform-api/ai', '@marinoscar/platform-api', 'pg', '../fabric/fabric.client', '../../apps/api/src/tasks/redact']) {
      expect(violations(f, `const x = require('${spec}');`, root)).toHaveLength(1);
      expect(violations(f, `import { x } from '${spec}';`, root)).toHaveLength(1);
    }
    expect(violations(f, `const x = await import('@nestjs/core');`, root)).toHaveLength(1);
    expect(violations(f, `import { z } from 'zod';\nimport { trace } from '@opentelemetry/api';\nimport { a } from './types';\nconst c = require('node:crypto');`, root)).toEqual([]);
  });
});
