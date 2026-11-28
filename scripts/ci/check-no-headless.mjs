#!/usr/bin/env node
// Hexactra never runs a headless browser (AGENTS.md, "MANDATORY: Never a headless browser", #1091): not in the product, a node, a
// test, a script, CI or a benchmark. This guard fails when tracked code launches one:
//   - a `--headless` argument (`--headless`, `--headless=new`, ...);
//   - `headless: true`, `headless: 'new'`, `headless=True` (Playwright, Puppeteer, Selenium options);
//   - a headless-shell binary (`chrome-headless-shell`, `chromium_headless_shell`, `--only-shell`);
//   - a Playwright or Puppeteer `launch(...)` / `launchPersistentContext(...)` without `headless: false` (both default to headless).
// Documentation (*.md) is not scanned: it states the rule. The allowlist below names each file that may mention the word, and why.
//
// Usage: node scripts/ci/check-no-headless.mjs [root]   (exit 1 with the offending lines)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Files that name a headless flag on purpose, to refuse or exclude it, never to use it. A file with `only` is allowed those lines only. */
export const ALLOW = new Map([
  ['scripts/ci/check-no-headless.mjs', 'this guard'],
  ['scripts/ci/check-no-headless.test.mjs', 'the guard’s test plants violations'],
  ['crates/hexactra-agent/src/launcher.rs', 'refuse_headless and its tests'],
  ['crates/hexactra-worker/src/driver.rs', 'the capability that says headless is never supported'],
  ['console/apps/cli/src/agent/unattended.test.ts', 'asserts the node’s Chrome unit has no --headless'],
  ['console/apps/cli/Dockerfile', { why: '`node start --headless` is the platform worker without a terminal UI, not a browser', only: /node start --headless|"start", "--headless"/ }],
  ['.github/workflows/ci.yml', { why: 'excludes the headless-shell binary', only: /grep -v headless/ }],
]);

const SKIP = [/\.md$/i, /(^|\/)node_modules\//, /(^|\/)(package-lock\.json|pnpm-lock\.yaml|Cargo\.lock)$/, /bundle-baseline\.json$/, /\/fixtures\/preferences\//, /\.(png|jpe?g|gif|ico|webp|woff2?|pdf|zip|gz|crx)$/i];

const FLAG = [
  { re: /--headless\b/i, why: 'a --headless argument' },
  { re: /\bheadless\s*[:=]\s*(true|True|['"`](new|old|shell|chrome)['"`])/, why: 'a headless launch option' },
  { re: /(chrome|chromium)[-_]headless[-_]shell|--only-shell\b/i, why: 'a headless-shell browser' },
];
const LAUNCH = /\b(chromium|firefox|webkit|puppeteer|browserType)\s*\.\s*(launch|launchPersistentContext)\s*\(/g;

/** The violations in one file's text: `{ line, why, text }`. */
export function violations(text, file = '') {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((t, i) => {
    for (const f of FLAG) if (f.re.test(t)) out.push({ line: i + 1, why: f.why, text: t.trim() });
  });
  if (/\.(m?[jt]sx?|cjs)$/.test(file)) {
    for (const m of text.matchAll(LAUNCH)) {
      // The call's arguments: up to the matching parenthesis.
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < text.length; end++) {
        if (text[end] === '(') depth++;
        else if (text[end] === ')' && --depth === 0) break;
      }
      const call = text.slice(m.index, end + 1);
      if (!/\bheadless\s*:\s*false\b/.test(call)) {
        const line = text.slice(0, m.index).split('\n').length;
        out.push({ line, why: 'a browser launch without `headless: false` (Playwright and Puppeteer default to headless)', text: lines[line - 1].trim() });
      }
    }
  }
  return out;
}

export function check(root = process.cwd()) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const found = [];
  for (const file of files) {
    const allow = ALLOW.get(file);
    if ((allow && !allow.only) || SKIP.some((r) => r.test(file))) continue;
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    if (!/headless|\.launch(PersistentContext)?\s*\(/i.test(text)) continue;
    for (const v of violations(text, file)) if (!allow?.only?.test(v.text)) found.push({ file, ...v });
  }
  return found;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const found = check(process.argv[2] ?? process.cwd());
  if (found.length) {
    console.error('Hexactra never runs a headless browser (AGENTS.md, "MANDATORY: Never a headless browser"):');
    for (const f of found) console.error(`  ${f.file}:${f.line}: ${f.why}\n      ${f.text}`);
    console.error('Run the browser headful (on a desktop, or under `xvfb-run -a`). If a file only names the word, add it to ALLOW with a reason.');
    process.exit(1);
  }
  console.log('No headless browser: ok.');
}
