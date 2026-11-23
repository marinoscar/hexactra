// Every code block marked runnable in README.md and docs/*.md runs as written (E46.25, #799). A block is runnable when its fence is
// ```ts runnable. Each block is transpiled to CommonJS and run with top-level await against the BUILT package (`@marinoscar/hexactra-kgraph/*`
// resolves through the workspace link to dist/, exactly what a host loads), so run `npm run build` first. A block proves itself with
// `node:assert`; a block that throws or rejects fails its test. A block may `export const result`, which a dedicated test can check.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const PACKAGE = join(__dirname, '..');
const FENCE = /```ts runnable\n([\s\S]*?)```/g;
const ALLOWED = (id: string) => id === 'zod' || id === '@marinoscar/hexactra-kgraph' || id.startsWith('@marinoscar/hexactra-kgraph/') || id.startsWith('node:');

export interface RunnableBlock {
  file: string;
  index: number;
  code: string;
}

/** The runnable blocks of the README and docs/, in file order. */
export function runnableBlocks(): RunnableBlock[] {
  const files = ['README.md', ...readdirSync(join(PACKAGE, 'docs')).filter((f) => f.endsWith('.md')).sort().map((f) => `docs/${f}`)];
  return files.flatMap((file) => [...readFileSync(join(PACKAGE, file), 'utf8').matchAll(FENCE)].map((m, index) => ({ file, index, code: m[1]! })));
}

/** Transpile and run one block; resolves to its exports. */
export async function runBlock(code: string): Promise<Record<string, unknown>> {
  const js = ts.transpileModule(`export {};\n${code}`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const req = (id: string) => {
    if (!ALLOWED(id)) throw new Error(`a runnable example imports ${id}: only the package itself, zod and node: built-ins are allowed`);
    return require(id);
  };
  const exports: Record<string, unknown> = {};
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<void>;
  await new AsyncFunction('require', 'exports', js)(req, exports);
  return exports;
}

describe('runnable examples in README.md and docs/', () => {
  it('the package is built (the examples run against dist/)', () => {
    expect(existsSync(join(PACKAGE, 'dist', 'index.js'))).toBe(true);
  });

  it('there are runnable examples: the README quick start among them', () => {
    const blocks = runnableBlocks();
    expect(blocks.filter((b) => b.file === 'README.md').length).toBeGreaterThanOrEqual(1);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it('every ts block in README.md and docs/ is either runnable or plainly not code to run', () => {
    // A ```ts block that is not marked runnable must say why on its fence (```ts signature, ```ts sketch); a bare ```ts is not allowed, so
    // no example silently escapes this test.
    const files = ['README.md', ...readdirSync(join(PACKAGE, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
    for (const file of files) expect({ file, bare: (readFileSync(join(PACKAGE, file), 'utf8').match(/^```ts\s*$/gm) ?? []).length }).toEqual({ file, bare: 0 });
  });

  for (const block of runnableBlocks()) {
    it(`${block.file} example ${block.index + 1} runs as written`, async () => {
      await expect(runBlock(block.code)).resolves.toBeDefined();
    });
  }

  it("the README quick start's result: compiled, replayed, broken, repaired as a structural change", async () => {
    const quick = runnableBlocks().find((b) => b.file === 'README.md')!;
    const { result } = await runBlock(quick.code);
    expect(result).toEqual({
      compiled: ['call:navigate', 'call:click', 'call:read_text'],
      firstRun: { status: 'completed', outputs: { total: '4,512.07' } },
      secondRun: { status: 'failed_check', step: 's2' },
      repair: { changes: ['unchanged', 'relocated', 'unchanged'], changeClass: 'structural' },
    });
  });
});
