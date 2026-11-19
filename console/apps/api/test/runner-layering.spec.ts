// What is left of the goal runner's layering in the app (E38.5, E38.9). The harness and the browser toolset are packages now
// (`@marinoscar/hexactra-agent`, `@marinoscar/hexactra-browser-agent`) with their own import-scan tests; what stays in `src/runner/` is the host: the
// bindings, and the app's own tool families (saved logins, identity details, cards, memories) that reach console services. Two rules remain here:
//
//   - a tool file of the host imports no loop code and no other tool (a composer lists the tools of a family and may import them);
//   - production code under src/runner imports no test kit (`.../testing`).
//
// The rule is a function over (file, source) pairs, so this spec also proves that it FIRES on a violation.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';

const RUNNER = join(__dirname, '../src/runner');

/** Files that list the tools of a family: they may import the tool files they list. */
const COMPOSERS = new Set(['host/tools/saved-card-tools.ts']);
/** Modules under a tools/ folder that are shared support, not tools. */
const TOOL_SUPPORT = new Set(['host/tools/secrets-support.ts', 'host/tools/saved-card-helpers.ts']);
/** The loop: what no tool may import. */
const LOOP_SPECIFIERS = ['@marinoscar/hexactra-agent/engine'];
const LOOP_FILES = ['goal-runner.service'];

export function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:from|import\(|require\()\s*'([^']+)'/g)) out.push(m[1]!);
  return out;
}

const posix = (p: string) => p.split(sep).join('/');
/** Where a relative specifier of `file` points, inside src/runner (no extension), or null when it is not relative. */
function resolveRelative(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  return posix(normalize(join(dirname(file), spec)));
}
const isToolFile = (file: string) => /^host\/tools\//.test(file) && !COMPOSERS.has(file) && !TOOL_SUPPORT.has(file);

/** Every violation in one file: `file imports spec: why`. */
export function violations(file: string, source: string): string[] {
  const out: string[] = [];
  for (const spec of importsOf(source)) {
    const target = resolveRelative(file, spec);
    const fail = (why: string) => out.push(`${file} imports '${spec}': ${why}`);
    if (/(^|\/)testing(\/|$)/.test(spec) && !/^(\.\.\/)*test\//.test(spec)) fail('production code does not import a test kit');
    if (!isToolFile(file)) continue;
    if (target === null) {
      if (LOOP_SPECIFIERS.includes(spec)) fail('a tool does not import the loop');
    } else {
      if (LOOP_FILES.some((l) => target === l || target.startsWith(`${l}/`))) fail('a tool does not import the loop');
      if (/^host\/tools\//.test(target) && !TOOL_SUPPORT.has(`${target}.ts`)) fail('a tool does not import another tool');
    }
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('the goal runner host layer (E38.9)', () => {
  it('holds in every file of src/runner', () => {
    const found = walk(RUNNER).flatMap((p) => violations(posix(relative(RUNNER, p)), readFileSync(p, 'utf8')));
    expect(found).toEqual([]);
  });

  it('fails when a tool imports the loop or another tool', () => {
    expect(violations('host/tools/saved-logins.ts', "import { runLoop } from '@marinoscar/hexactra-agent/engine';")).toHaveLength(1);
    expect(violations('host/tools/saved-logins.ts', "import { GoalRunnerService } from '../../goal-runner.service';")).toHaveLength(1);
    expect(violations('host/tools/saved-identity.ts', "import { savedLoginTools } from './saved-logins';")).toHaveLength(1);
    // Shared support is not a tool; the composer lists the tools of a family.
    expect(violations('host/tools/saved-logins.ts', "import { sl } from './secrets-support';")).toEqual([]);
    expect(violations('host/tools/saved-card-tools.ts', "import { payWithSavedCard } from './saved-card-pay';")).toEqual([]);
    expect(violations('host/tools/saved-logins.ts', "import { defineRunnerTool } from '@marinoscar/hexactra-agent';")).toEqual([]);
  });

  it('fails when production code imports a test kit', () => {
    expect(violations('host/build-context.ts', "import { fakeRun } from '@marinoscar/hexactra-agent/testing';")).toHaveLength(1);
    expect(violations('host/fabric-browser.ts', "import { FakeBrowser } from '@marinoscar/hexactra-browser-agent/testing';")).toHaveLength(1);
  });
});
