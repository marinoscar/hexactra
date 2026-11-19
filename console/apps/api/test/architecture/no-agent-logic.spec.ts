// The app holds no agent logic (E38.9, after Vault's `no-domain-logic.spec.ts`). The loop, the gates and the browser and desktop tools live in the
// packages `@marinoscar/hexactra-agent` and `@marinoscar/hexactra-browser-agent`; the app binds their ports. A tool, a gate or loop code that comes back
// into `src/` fails here, with the file named. The rule is a function over (file, source) pairs, so this spec also proves that it FIRES.
//
// What is allowed in the app, each with its reason:
//   - `defineRunnerTool(` in `src/runner/host/tools/`: the app's own tool families reach console services (providers, memories), which a package
//     may not import. Moving them needs a port (follow-up); until then they are the only tools in the app.
//   - `GatePipeline` and `createRunLoop` in `src/runner/host/build-context.ts`: the one place that plugs the toolset's gates into the harness.
//   - the engine entry (`@marinoscar/hexactra-agent/engine`) in three host files that start, end and pause a run.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';

const SRC = join(__dirname, '../../src');

const posix = (p: string) => p.split(sep).join('/');
const TOOL_HOME = /^runner\/host\/tools\//;
const WIRING_FILES = new Set(['runner/host/build-context.ts']);
const ENGINE_IMPORTERS = new Set(['runner/host/build-context.ts', 'runner/host/before-loop.ts', 'runner/goal-runner.service.ts']);

/** Every violation in one file (`rel` is its path under src/, forward slashes). */
export function violations(rel: string, source: string): string[] {
  const out: string[] = [];
  const fail = (why: string) => out.push(`${rel}: ${why}`);
  if (/^runner\/(harness|browser)\//.test(rel)) fail('the loop and the browser toolset are packages now (`@marinoscar/hexactra-agent`, `@marinoscar/hexactra-browser-agent`); this folder does not come back');
  if (/\bdefineRunnerTool\s*\(/.test(source) && !TOOL_HOME.test(rel)) fail('a tool is defined in a package (or, for a console service, in runner/host/tools/), not here');
  if (/\bimplements\s+Gate\b|:\s*Gate<|\bGate<[A-Za-z]+>\s*=/.test(source)) fail('a gate is defined in a package, not in the app');
  if (/\bnew\s+GatePipeline\b/.test(source) && !WIRING_FILES.has(rel)) fail('the gate pipeline is built in runner/host/build-context.ts only');
  if (/\b(runLoop|executeTool|createRunContext|createRunLoop)\s*\(/.test(source) && !WIRING_FILES.has(rel) && !ENGINE_IMPORTERS.has(rel)) fail('loop code is in the harness package; the app binds ports and calls the loop from the goal runner only');
  if (/from '@marinoscar\/hexactra-agent\/engine'/.test(source) && !ENGINE_IMPORTERS.has(rel)) fail('only the files that start, pause and end a run import the engine');
  for (const m of source.matchAll(/from\s+'(\.[^']*)'/g)) {
    const target = posix(normalize(join(dirname(rel), m[1]!)));
    if (/^runner\/(harness|browser)(\/|$)/.test(target)) fail(`imports ${m[1]}: a runner/harness or runner/browser path that no longer exists`);
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('no agent logic in the app (E38.9)', () => {
  it('the harness and browser folders are gone from src/runner', () => {
    expect(existsSync(join(SRC, 'runner/harness'))).toBe(false);
    expect(existsSync(join(SRC, 'runner/browser'))).toBe(false);
  });

  it('holds in every file of src/', () => {
    const found = walk(SRC).flatMap((p) => violations(posix(relative(SRC, p)), readFileSync(p, 'utf8')));
    expect(found).toEqual([]);
  });

  it('fails when a tool, a gate or loop code comes back into the app', () => {
    expect(violations('runner/tools/click.ts', "export const click = defineRunnerTool({ name: 'click' });")).toHaveLength(1);
    expect(violations('runner/host/tools/saved-logins.ts', "export const t = defineRunnerTool({ name: 'x' });")).toEqual([]);
    expect(violations('runner/gates/risk-gate.ts', 'export const riskGate: Gate<Ctx> = { name: "risk", check: async () => ({ kind: "allow" }) };')).toHaveLength(1);
    expect(violations('runner/gates/x.ts', 'export class X implements Gate<Ctx> {}')).toHaveLength(1);
    expect(violations('runner/my-loop.ts', 'const outcome = await runLoop(ctx, profile);')).toHaveLength(1);
    expect(violations('chat/chat-turn.service.ts', "import { executeTool } from '@marinoscar/hexactra-agent/engine';\nawait executeTool(ctx, t, a, p);")).toHaveLength(2);
    expect(violations('runner/harness/steps.ts', 'export const x = 1;')).toHaveLength(1);
    expect(violations('runner/browser/act.ts', 'export const x = 1;')).toHaveLength(1);
    expect(violations('runner/host/build-context.ts', "const loop = createRunLoop(ports, o);\nconst p = new GatePipeline([siteGate]);")).toEqual([]);
    expect(violations('runner/host/start.ts', "import { x } from '../browser/policy';")).toHaveLength(1);
  });
});
