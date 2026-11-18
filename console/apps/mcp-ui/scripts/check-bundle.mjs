// The widgets' bundle rules (#466, #467), run after every build (and so in
// CI's `npm run build`), for each widget in WIDGETS:
// 1. one self-contained HTML file: no <script src>, no <link href>, no
//    import of another file;
// 2. within its budget (uncompressed): the run card 300 KB (it carries the
//    MCP Apps SDK), the question and tasks cards 250 KB each;
// 3. no external URL beyond the allowlist below (each with its reason);
// 4. no MCP tool name except the ones that widget may call (its `tools`,
//    the same list as its source's): every tool name the console has comes
//    from the API's pinned manifest (apps/api/test/__snapshots__/mcp-tools.json).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');
/** Each widget: its file, its budget and the only tools it may name (src/model.ts, src/question-model.ts, src/tasks-model.ts). */
export const WIDGETS = {
  'run-card.html': { budget: 300 * 1024, tools: ['run_card_poll', 'run_wait', 'run_status', 'run_cancel', 'task_run', 'question_card_answer'] },
  'question-card.html': { budget: 250 * 1024, tools: ['inbox_list', 'question_card_answer', 'question_status'] },
  'tasks-card.html': { budget: 250 * 1024, tools: ['tasks_list', 'task_run', 'task_pause', 'task_resume'] },
};
/** The run card's budget (the largest). */
export const BUDGET_BYTES = WIDGETS['run-card.html'].budget;

/** Strings that look like URLs but are never fetched (the CSP allows no origin anyway). */
export const URL_ALLOWLIST = [
  // XML namespaces Preact uses to create SVG elements (an identifier, not a request).
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1998/Math/MathML',
  // JSON Schema dialect identifiers zod writes into schemas it generates (the SDK's tool schemas); never fetched.
  'https://json-schema.org/draft/2020-12/schema',
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-04/schema#',
  'https://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft-04/schema',
  'https://json-schema.org/draft/2019-09/schema',
  'http://json-schema.org/draft/2019-09/schema',
  // The base URL the SDK's JSON Schema validator (@cfworker/json-schema) resolves relative $refs against when the page has no origin: parsed, never fetched.
  'https://github.com/cfworker',
  // zod's IPv6 check builds `http://[<address>]` to parse it with URL: never fetched.
  'http://[',
  // An example in the SDK's schema description of `resourceDomains` (documentation text).
  'https://*.example.com',
];

/** The run card's tools (kept for the run card's own test). */
export const ALLOWED_TOOLS = WIDGETS['run-card.html'].tools;

function toolNames() {
  const path = join(ROOT, '..', 'api', 'test', '__snapshots__', 'mcp-tools.json');
  return JSON.parse(readFileSync(path, 'utf8')).map((t) => t.name);
}

export function checkHtml(html, { names = toolNames(), file = 'run-card.html' } = {}) {
  const problems = [];
  const widget = WIDGETS[file];
  if (!widget) return { size: 0, problems: [`${file}: not a known widget (add it to WIDGETS)`] };
  const budget = widget.budget;
  const allowed = widget.tools;
  const size = Buffer.byteLength(html, 'utf8');
  if (size > budget) problems.push(`${file}: ${size} bytes, over the ${budget}-byte budget`);
  if (/<script[^>]*\ssrc\s*=/i.test(html)) problems.push(`${file}: a <script src> (everything must be inline)`);
  if (/<link[^>]*\shref\s*=/i.test(html)) problems.push(`${file}: a <link href> (everything must be inline)`);
  if (/\bimport\s*\(\s*["'`]/.test(html) || /\bfrom\s*["'`]\.{0,2}\//.test(html)) problems.push(`${file}: imports another file`);
  const urls = new Set(html.match(/https?:\/\/[^\s"'`<>)\\]+/g) ?? []);
  const external = [...urls].filter((u) => !URL_ALLOWLIST.some((a) => u === a || u.startsWith(a)));
  if (external.length) problems.push(`${file}: external URLs ${external.join(', ')}`);
  const called = names.filter((n) => !allowed.includes(n) && new RegExp(`(^|[^A-Za-z0-9_])${n}([^A-Za-z0-9_]|$)`).test(html));
  if (called.length) problems.push(`${file}: names tools it must never call: ${called.join(', ')}`);
  if (/["'`]browser_[a-z_]+["'`]/.test(html)) problems.push(`${file}: names a browser_* tool`);
  return { size, problems };
}

function main() {
  const files = readdirSync(DIST).filter((f) => f.endsWith('.html'));
  const extra = readdirSync(DIST).filter((f) => !f.endsWith('.html') && statSync(join(DIST, f)).isFile());
  const problems = [];
  for (const w of Object.keys(WIDGETS)) if (!files.includes(w)) problems.push(`dist/${w} is missing`);
  if (extra.length) problems.push(`dist holds files besides the widgets: ${extra.join(', ')}`);
  for (const f of files) {
    const r = checkHtml(readFileSync(join(DIST, f), 'utf8'), { file: f });
    if (WIDGETS[f]) console.log(`${f}: ${r.size} bytes (${(r.size / 1024).toFixed(1)} KB of ${WIDGETS[f].budget / 1024} KB)`);
    problems.push(...r.problems);
  }
  if (problems.length) {
    console.error(problems.map((p) => `bundle check: ${p}`).join('\n'));
    process.exit(1);
  }
  console.log('bundle check: ok (single file, within budget, no external URL, only allowed tool names)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
