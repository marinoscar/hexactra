// `hexactra dev scenario-from-trace <trace.json>` (E38.6, #587): turns a run trace exported with `hexactra runs export` into the skeleton of a
// scripted replay scenario (apps/api/test/scenarios, docs/runner.md "Testing a change to the agent"). The conversion is
// packages/shared/scenario-from-trace.js; this file only reads the file, writes the result and lists what a person still has to finish.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';
import { scenarioFromTrace, type ScenarioSkeleton } from '@app/shared/scenario-from-trace';

/** Reads a run trace file and converts it. A file that is not JSON or not a run trace is an error that says so. */
export function skeletonFromFile(path: string): ScenarioSkeleton {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return scenarioFromTrace(parsed);
}

/** The default file name: `<trace name>.scenario.json` beside the working directory. */
export const defaultScenarioName = (trace: string): string => `${basename(trace).replace(/\.json$/i, '').replace(/[^\w.-]+/g, '-')}.scenario.json`;

export const devCommand: CliCommandRegistration = (program: Command) => {
  const dev = program.command('dev').description('Developer tools: the replay suite for changes to the agent');
  dev
    .command('scenario-from-trace <trace>')
    .description('Turn a run trace (hexactra runs export) into the skeleton of a scripted replay scenario')
    .option('--out <file>', 'where to write it (default: <trace name>.scenario.json; "-" prints it)')
    .option('--force', 'replace the file if it exists')
    .action((trace: string, o: { out?: string; force?: boolean }) => {
      const { scenario, todo } = skeletonFromFile(trace);
      const text = `${JSON.stringify(scenario, null, 2)}\n`;
      const out = o.out ?? defaultScenarioName(trace);
      if (out === '-') process.stdout.write(text);
      else {
        if (existsSync(out) && !o.force) throw new Error(`${out} exists: pass --force to replace it`);
        writeFileSync(out, text);
        process.stdout.write(`Wrote ${out}\n`);
      }
      process.stderr.write(`A skeleton, not a recording: finish it before it joins apps/api/test/scenarios.\n${todo.map((t) => `  TODO ${t}`).join('\n')}\n`);
    });
};
