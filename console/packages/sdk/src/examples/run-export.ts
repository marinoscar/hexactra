// Example: export a run as its masked JSON trace file, for your records or to
// hand to a developer when something went wrong.
//
//   HEXACTRA_CONSOLE_URL=https://console.example.test HEXACTRA_TOKEN=pat_… [HEXACTRA_RUN_ID=<run id>] node dist/examples/run-export.js
//
// Without HEXACTRA_RUN_ID it starts a run and exports it at once (a live run
// exports with `partial: true`). It writes `hexactra-run-<id>-<yyyymmdd>.json`
// to the current directory and prints one JSON line; it never prints the token.
import { writeFileSync } from 'node:fs';

import { ConsoleApiError, createConsoleClient } from '../index.js';

async function main() {
  const baseUrl = process.env.HEXACTRA_CONSOLE_URL;
  const token = process.env.HEXACTRA_TOKEN;
  if (!baseUrl || !token) throw new Error('Set HEXACTRA_CONSOLE_URL and HEXACTRA_TOKEN');
  const hx = createConsoleClient({ baseUrl, token });

  const runId = process.env.HEXACTRA_RUN_ID ?? (await hx.runs.start({ goal: 'Find a fare to Lisbon' })).id;

  // Screenshots are embedded by default (base64 in steps[].screenshot.data); 'none' keeps the file small.
  let trace;
  try {
    trace = await hx.runs.export(runId);
  } catch (e) {
    // Over 50 MB with its pictures: export it without them.
    if (e instanceof ConsoleApiError && e.code === 'EXPORT_TOO_LARGE') trace = await hx.runs.export(runId, { screenshots: 'none' });
    else throw e;
  }
  const file = `hexactra-run-${runId.slice(0, 8)}-${trace.exportedAt.slice(0, 10).replace(/-/g, '')}.json`;
  writeFileSync(file, `${JSON.stringify(trace, null, 2)}\n`);

  process.stdout.write(
    `${JSON.stringify({
      runId,
      file,
      type: trace.type,
      formatVersion: trace.formatVersion,
      partial: trace.partial,
      steps: trace.steps.length,
      // What the masking replaced, by pattern: the file never holds the values themselves.
      masked: trace.masking.hits,
    })}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
  process.exit(1);
});
