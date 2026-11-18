#!/usr/bin/env node
// Writes the generated "Steps" section of docs/hosted-clients.md from the one
// source the in-app "Connect an AI app" guide reads
// (apps/web/src/content/connect-ai-apps.ts, renderGuidesMarkdown), between
// the connect-guides markers (#468). `--check` only compares and exits 1 when
// the document is stale; apps/web/src/__tests__/hostedClientsDoc.test.ts runs
// the same comparison in `npm test`.
//
//   node scripts/hosted-clients-doc.mjs [--check]     (Node 24: loads the .ts file with type stripping)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = join(root, 'docs', 'hosted-clients.md');
const START = '<!-- connect-guides:start (generated from apps/web/src/content/connect-ai-apps.ts by `npm run docs:hosted-clients`; do not edit) -->';
const END = '<!-- connect-guides:end -->';

const { renderGuidesMarkdown } = await import(pathToFileURL(join(root, 'apps', 'web', 'src', 'content', 'connect-ai-apps.ts')).href);
const doc = readFileSync(docPath, 'utf8');
const a = doc.indexOf(START);
const b = doc.indexOf(END);
if (a < 0 || b < a) {
  console.error(`docs/hosted-clients.md: the markers are missing:\n${START}\n${END}`);
  process.exit(1);
}
const next = `${doc.slice(0, a + START.length)}\n\n${renderGuidesMarkdown()}\n${doc.slice(b)}`;
if (process.argv.includes('--check')) {
  if (next !== doc) {
    console.error('docs/hosted-clients.md is stale: run `npm run docs:hosted-clients`.');
    process.exit(1);
  }
  console.log('ok   docs/hosted-clients.md matches apps/web/src/content/connect-ai-apps.ts');
} else {
  writeFileSync(docPath, next);
  console.log(next === doc ? 'docs/hosted-clients.md was up to date' : 'wrote docs/hosted-clients.md');
}
