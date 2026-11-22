// docs/mcp.md's example runs as written (E46.22): the ```ts example block is transpiled and run with the package's own sources standing in for
// `@marinoscar/hexactra-kgraph/*`, so the documented way to expose the tools stays true.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const DOC = join(__dirname, '..', 'docs', 'mcp.md');

const MODULES: Record<string, () => unknown> = {
  zod: () => require('zod'),
  '@marinoscar/hexactra-kgraph/mcp': () => require('../src/mcp'),
  '@marinoscar/hexactra-kgraph/testing': () => require('../src/testing'),
};

it('the example of docs/mcp.md exposes the three tools and starts a run against the fakes', async () => {
  const doc = readFileSync(DOC, 'utf8');
  const block = /```ts example\n([\s\S]*?)```/.exec(doc)?.[1];
  expect(block).toBeDefined();
  // Top-level await: wrap the module body in an async function after transpiling to CommonJS.
  const js = ts.transpileModule(`export {};\n${block}`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const req = (id: string) => {
    const m = MODULES[id];
    if (!m) throw new Error(`the example imports ${id}, which the doc does not cover`);
    return m();
  };
  const exports: Record<string, unknown> = {};
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<void>;
  await new AsyncFunction('require', 'exports', js)(req, exports);
  expect(exports.result).toEqual({
    listed: ['procedures_list', 'procedure_get', 'procedure_run'],
    run: { run_id: 'run-1', status: 'queued', procedure_id: 'proc1', task_id: 'task1', follow: 'run_wait with run_id run-1' },
  });
  expect(doc).toContain("{ run_id: 'run-1', status: 'queued', procedure_id: 'proc1', task_id: 'task1', follow: 'run_wait with run_id run-1' }");
});
