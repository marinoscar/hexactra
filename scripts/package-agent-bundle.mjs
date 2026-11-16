#!/usr/bin/env node
// Package the browser-host agent bundle the `hexactra agent` CLI installs
// (#326): the agent and native-host release binaries plus the built Chrome
// extension, with a BUNDLE.json listing every file's sha256.
//
//   node scripts/package-agent-bundle.mjs [--target-dir target/release] [--out dist/agent]
//
// Writes <out>/hexactra-agent-linux-x86_64.tar.gz and its .sha256, then
// re-extracts the archive and verifies every file against BUNDLE.json.
// Run in CI and by the stack smoke; nothing here runs on a client machine.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const targetDir = resolve(root, arg('--target-dir', 'target/release'));
const outDir = resolve(root, arg('--out', 'dist/agent'));
const extensionDir = join(root, 'apps/chrome-extension/dist');
const NAME = 'hexactra-agent-linux-x86_64';

const fail = (msg) => {
  console.error(`package-agent-bundle: ${msg}`);
  process.exit(1);
};
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

for (const bin of ['hexactra-agent', 'hexactra-native-host']) {
  if (!existsSync(join(targetDir, bin))) fail(`missing ${join(targetDir, bin)} (cargo build --release -p hexactra-agent -p hexactra-native-host)`);
}
if (!existsSync(join(extensionDir, 'manifest.json'))) fail(`missing ${extensionDir}/manifest.json (pnpm --filter @hexactra/chrome-extension build)`);
const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
if (!manifest.key) fail('the extension manifest has no "key": its id would not match the native host');

const stage = mkdtempSync(join(tmpdir(), 'hexactra-agent-'));
const bundle = join(stage, NAME);
mkdirSync(join(bundle, 'bin'), { recursive: true });
for (const bin of ['hexactra-agent', 'hexactra-native-host']) {
  cpSync(join(targetDir, bin), join(bundle, 'bin', bin));
  chmodSync(join(bundle, 'bin', bin), 0o755);
}
cpSync(extensionDir, join(bundle, 'extension'), { recursive: true });

const version = execFileSync(join(bundle, 'bin', 'hexactra-agent'), ['--version'], { encoding: 'utf8' }).trim().split(/\s+/).pop();
const commit = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const files = Object.fromEntries(walk(bundle).map((f) => [relative(bundle, f), sha256(f)]).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(
  join(bundle, 'BUNDLE.json'),
  JSON.stringify({ name: NAME, version, commit, builtAt: new Date().toISOString(), platform: 'linux-x86_64', files }, null, 2) + '\n',
);

mkdirSync(outDir, { recursive: true });
const archive = join(outDir, `${NAME}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', stage, NAME]);
const digest = sha256(archive);
writeFileSync(`${archive}.sha256`, `${digest}  ${NAME}.tar.gz\n`);

// Verify what was written, the way the CLI will: extract and check every file.
const check = mkdtempSync(join(tmpdir(), 'hexactra-agent-check-'));
execFileSync('tar', ['-xzf', archive, '-C', check]);
const listed = JSON.parse(readFileSync(join(check, NAME, 'BUNDLE.json'), 'utf8')).files;
for (const [file, sum] of Object.entries(listed)) {
  const p = join(check, NAME, file);
  if (!existsSync(p) || sha256(p) !== sum) fail(`verification failed for ${file}`);
}
rmSync(check, { recursive: true, force: true });
rmSync(stage, { recursive: true, force: true });

console.log(JSON.stringify({ archive, sha256: digest, version, commit, files: Object.keys(listed).length }));
