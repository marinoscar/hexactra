// Example: your last 7 days of finished runs as one masked JSON file (runs, findings and steps), saved to the current directory.
//
//   HEXACTRA_CONSOLE_URL=https://console.example.test HEXACTRA_TOKEN=pat_… node dist/examples/run-dataset.js
//
// The file is made by a queue job: the example polls until it is ready, then downloads it through its short-lived signed link,
// WITHOUT the token (the link goes to object storage). Prints one JSON line; it never prints the token or the link.
import { writeFileSync } from 'node:fs';

import { createConsoleClient } from '../index.js';

async function main() {
  const baseUrl = process.env.HEXACTRA_CONSOLE_URL;
  const token = process.env.HEXACTRA_TOKEN;
  if (!baseUrl || !token) throw new Error('Set HEXACTRA_CONSOLE_URL and HEXACTRA_TOKEN');
  const hx = createConsoleClient({ baseUrl, token });

  const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  let job = await hx.runs.dataset({ from, includeSteps: true });
  const until = Date.now() + 10 * 60_000;
  while ((job.status === 'pending' || job.status === 'running') && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3_000));
    job = await hx.runs.datasetStatus(job.id);
  }
  if (job.status !== 'ready' || !job.download) throw new Error(`The dataset was not made: ${job.status}`);
  const file = await fetch(job.download.url);
  if (!file.ok) throw new Error(`Download failed: HTTP ${file.status}`);
  const name = job.fileName ?? 'hexactra-runs.json';
  writeFileSync(name, Buffer.from(await file.arrayBuffer()));
  console.log(JSON.stringify({ file: name, bytes: job.sizeBytes, rowCounts: job.rowCounts }));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
