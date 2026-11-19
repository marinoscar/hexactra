// The layering of the goal runner (E38.5, #586). Three layers under src/runner/, with a hard line between them, so that extracting the agent
// harness into packages (#614) is a move and not a second refactor:
//
//   harness/  the generic agent harness. Imports only itself, zod, @opentelemetry/api and node: built-ins: no NestJS, no Prisma, no platform
//             package, no fabric client, no console module.
//   browser/  the browser toolset. Imports only harness/ and itself (and zod, node:).
//   host/     the bindings to the console's services. Unrestricted.
//
// And, in every layer: a tool file imports no loop code and no other tool.
//
// The rule is a function over (file, source) pairs, so this spec also proves that it FIRES on a violation.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';

const RUNNER = join(__dirname, '../src/runner');

/** Files that list the tools of a family: they may import the tool files they list. */
const COMPOSERS = new Set(['browser/tools/index.ts', 'host/tools/saved-card-tools.ts']);
/** Modules under a tools/ folder that are shared support, not tools. */
const TOOL_SUPPORT = new Set(['host/tools/secrets-support.ts', 'host/tools/saved-card-helpers.ts']);
/** The loop: what no tool or gate may import. */
const LOOP_FILES = ['harness/engine', 'harness/run-loop', 'harness/outcomes', 'harness/create-context', 'harness/execute-tool', 'harness/model-call', 'goal-runner.service'];

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
const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
const isToolFile = (file: string) => /^(browser|host)\/tools\//.test(file) && !COMPOSERS.has(file) && !TOOL_SUPPORT.has(file);

/** Every violation in one file: `file imports spec: why`. */
export function violations(file: string, source: string): string[] {
  const out: string[] = [];
  for (const spec of importsOf(source)) {
    const target = resolveRelative(file, spec);
    const bare = target === null;
    const fail = (why: string) => out.push(`${file} imports '${spec}': ${why}`);
    if (inside(file, 'harness')) {
      if (bare && !(spec === 'zod' || spec === '@opentelemetry/api' || spec.startsWith('node:'))) fail('the harness imports only zod, @opentelemetry/api and node: built-ins');
      if (!bare && !inside(target!, 'harness')) fail('the harness imports nothing outside harness/');
    }
    if (inside(file, 'browser')) {
      if (bare && !(spec === 'zod' || spec.startsWith('node:'))) fail('the browser layer imports only zod and node: built-ins');
      if (!bare && !inside(target!, 'harness') && !inside(target!, 'browser')) fail('the browser layer imports only harness/ and browser/');
    }
    if (isToolFile(file) && !bare) {
      if (LOOP_FILES.some((l) => target === l || target!.startsWith(`${l}/`))) fail('a tool does not import the loop');
      if (/^(browser|host)\/tools\//.test(target!) && !TOOL_SUPPORT.has(`${target}.ts`)) fail('a tool does not import another tool');
    }
    // Gates are not loop code either: they decide, and the engine calls them.
    if (/^browser\/gates\//.test(file) && !bare && LOOP_FILES.some((l) => target === l || target!.startsWith(`${l}/`))) fail('a gate does not import the loop');
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('the goal runner layers (E38.5)', () => {
  it('holds in every file of src/runner', () => {
    const found = walk(RUNNER).flatMap((p) => violations(posix(relative(RUNNER, p)), readFileSync(p, 'utf8')));
    expect(found).toEqual([]);
  });

  it('fails when a file of the harness imports NestJS, Prisma, a platform package or a console module', () => {
    expect(violations('harness/steps.ts', "import { Injectable } from '@nestjs/common';")).toHaveLength(1);
    expect(violations('harness/steps.ts', "import { Prisma } from '@prisma/client';")).toHaveLength(1);
    expect(violations('harness/steps.ts', "import { AiService } from '@marinoscar/platform-api/ai';")).toHaveLength(1);
    expect(violations('harness/steps.ts', "import { FabricClient } from '../../fabric/fabric.client';")).toHaveLength(1);
    expect(violations('harness/steps.ts', "import { x } from '../browser/policy';")).toHaveLength(1);
    expect(violations('harness/steps.ts', "import { x } from '../tasks/redact';")).toHaveLength(1);
    expect(violations('harness/steps.ts', "import { z } from 'zod';\nimport { trace } from '@opentelemetry/api';\nimport { a } from './types';\nimport { createHash } from 'node:crypto';")).toEqual([]);
  });

  it('fails when a file of the browser layer imports anything outside harness/ and browser/', () => {
    expect(violations('browser/act.ts', "import { FabricClient } from '../../fabric/fabric.client';")).toHaveLength(1);
    expect(violations('browser/act.ts', "import { PrismaService } from '../../prisma/prisma.service';")).toHaveLength(1);
    expect(violations('browser/act.ts', "import { x } from '../host/deps';")).toHaveLength(1);
    expect(violations('browser/act.ts', "import { x } from '@nestjs/common';")).toHaveLength(1);
    expect(violations('browser/tools/click.ts', "import { x } from '../../harness';\nimport { y } from '../act';\nimport { z } from 'zod';")).toEqual([]);
  });

  it('fails when a tool imports the loop or another tool', () => {
    expect(violations('browser/tools/click.ts', "import { runLoop } from '../../harness/run-loop';")).toHaveLength(1);
    expect(violations('browser/tools/click.ts', "import { executeTool } from '../../harness/engine';")).toHaveLength(1);
    expect(violations('browser/tools/click.ts', "import { navigate } from './navigate';")).toHaveLength(1);
    expect(violations('host/tools/saved-logins.ts', "import { GoalRunnerService } from '../../goal-runner.service';")).toHaveLength(1);
    expect(violations('host/tools/saved-identity.ts', "import { savedLoginTools } from './saved-logins';")).toHaveLength(1);
    // Shared support is not a tool; the composers list the tools of a family.
    expect(violations('host/tools/saved-logins.ts', "import { sl } from './secrets-support';")).toEqual([]);
    expect(violations('browser/tools/index.ts', "import { click } from './click';")).toEqual([]);
  });

  it('fails when a gate imports the loop', () => {
    expect(violations('browser/gates/risk-gate.ts', "import { cancelRun } from '../../harness/outcomes';")).toHaveLength(1);
  });
});
