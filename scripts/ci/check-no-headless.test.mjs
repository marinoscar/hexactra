// The no-headless guard (#1091): it finds every way to launch a headless browser, lets a headful launch through, and the tree is clean.
// Run: node --test scripts/ci/check-no-headless.test.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { check, violations } from './check-no-headless.mjs';

test('finds a headless argument, option and shell', () => {
  for (const [text, file] of [
    ['google-chrome --headless=new about:blank', 'run.sh'],
    ['args.push("--headless".into());', 'x.rs'],
    ['const b = await puppeteer.launch({ headless: "new" });', 'a.js'],
    ['opts = { headless: true }', 'a.ts'],
    ['options.headless = True', 'a.py'],
    ['npx playwright install chromium --only-shell', 'ci.yml'],
    ['BROWSER=/opt/chrome-headless-shell/chrome-headless-shell', 'x.env'],
  ]) {
    assert.ok(violations(text, file).length > 0, `${file}: ${text}`);
  }
});

test('finds a Playwright launch that defaults to headless, also over several lines', () => {
  assert.equal(violations('const b = await chromium.launch();', 'a.mjs').length, 1);
  assert.equal(violations('const b = await chromium.launch({\n  args: ["--x"],\n});', 'a.mjs').length, 1);
  assert.equal(violations('const c = await chromium.launchPersistentContext(dir, { viewport: null });', 'a.ts').length, 1);
});

test('lets a headful launch through', () => {
  assert.deepEqual(violations('const b = await chromium.launch({ headless: false });', 'a.mjs'), []);
  assert.deepEqual(violations('const b = await chromium.launch({\n  headless: false,\n  args: ["--x"],\n});', 'a.mjs'), []);
  assert.deepEqual(violations('// a headless run refuses OAuth', 'a.ts'), []);
});

test('the tree is clean', () => {
  assert.deepEqual(check(), []);
});

test('a planted violation in a repository fails the check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-headless-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'e2e.js'), "require('child_process').execSync('google-chrome --headless=new');\n");
  writeFileSync(join(dir, 'README.md'), 'Never use --headless.\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  const found = check(dir);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'e2e.js');
});
