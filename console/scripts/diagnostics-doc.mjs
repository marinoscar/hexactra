#!/usr/bin/env node
// Writes the generated table of diagnostic codes and their remedies in docs/web-search.md from the one source the API, the web
// app and the CLI read (packages/shared/diagnostics.json), between the diagnostics-codes markers (E50.16, #986), so the table
// cannot drift from the remedy table. `--check` only compares and exits 1 when the document is stale (run in CI by
// .github/workflows/console.yml).
//
//   node scripts/diagnostics-doc.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = join(root, 'docs', 'web-search.md');
const sourcePath = join(root, 'packages', 'shared', 'diagnostics.json');
const START = '<!-- diagnostics-codes:start (generated from packages/shared/diagnostics.json by `npm run docs:diagnostics`; do not edit) -->';
const END = '<!-- diagnostics-codes:end -->';

const WHO = { owner: 'You (the owner)', admin: 'Your administrator' };
const WHERE = {
  settings: 'Connections and tools',
  admin: 'Administration',
  provider_console: "The provider's own console",
  web_search: 'Connections and tools, Web search',
};

/** One table cell: no line break, and a `|` escaped so it cannot end the cell. */
const cell = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

export function renderCodesMarkdown(table) {
  const codes = Object.entries(table.codes ?? {});
  const rows = codes.map(([code, e]) => `| \`${code}\` | ${cell(e.title)} | ${cell(e.remedy)} | ${cell(WHO[e.who] ?? e.who)} | ${cell(e.link ? (WHERE[e.link] ?? e.link) : '')} |`);
  return [
    `${codes.length} codes. A report names the code; the web app's diagnostics panel and the CLI print these words.`,
    '',
    '| Code | Title | What to do | Who can fix it | Where |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

const table = JSON.parse(readFileSync(sourcePath, 'utf8'));
const doc = readFileSync(docPath, 'utf8');
const a = doc.indexOf(START);
const b = doc.indexOf(END);
if (a < 0 || b < a) {
  console.error(`docs/web-search.md: the markers are missing:\n${START}\n${END}`);
  process.exit(1);
}
const next = `${doc.slice(0, a + START.length)}\n\n${renderCodesMarkdown(table)}\n${doc.slice(b)}`;
if (process.argv.includes('--check')) {
  if (next !== doc) {
    console.error('docs/web-search.md is stale: run `npm run docs:diagnostics` (from console/).');
    process.exit(1);
  }
  console.log('ok   docs/web-search.md matches packages/shared/diagnostics.json');
} else {
  writeFileSync(docPath, next);
  console.log(next === doc ? 'docs/web-search.md was up to date' : 'wrote docs/web-search.md');
}
