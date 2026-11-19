#!/usr/bin/env node
// =============================================================================
// Pack check for the @marinoscar/hexactra-* packages (E38.9)
// =============================================================================
//
// What ships is not what is in the folder: a package that builds and tests green can still publish broken (an `exports` target the build never
// emitted, a `files` entry that drops the README, tests or sources in the tarball). This asks npm what it WOULD publish
// (`npm pack --dry-run --json`, which runs `prepack`, so LICENSE is copied) and compares it with the manifest. Nothing is published, and no tarball
// is written. Run it after `npm run build:packages`.
//
// For each package under packages/hexactra-*:
//   manifest   name @marinoscar/<folder>; MIT; engines.node >=24; not private; publishConfig access public and provenance; a `0.1.0-next.N` or later
//              semver; `files` names dist, README.md, CHANGELOG.md and LICENSE; "./package.json" exported.
//   present    the tarball holds package.json, README.md, LICENSE and every file an `exports` entry (or `main`, `types`) points at.
//   only       the tarball holds package.json, README.md, CHANGELOG.md, LICENSE and files under dist/: no sources, tests, fixtures, source maps or .env.
//
// Usage: node scripts/check-package-pack.mjs [--list]
// Exit: 0 clean, 1 violations. Node built-ins and npm only.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(ROOT, 'packages');
const REQUIRED = ['package.json', 'README.md', 'LICENSE'];
const FILES_ENTRIES = ['dist', 'README.md', 'CHANGELOG.md', 'LICENSE'];
const FORBIDDEN = [/\.map$/, /(^|\/)(test|tests|src|fixtures|__fixtures__)\//, /\.(spec|test)\.[jt]s$/, /(^|\/)\.env/, /(^|\/)tsconfig[^/]*\.json$/, /(^|\/)jest\.config\./];

/** Every file path an `exports` map, `main` or `types` points at. */
export function exportTargets(manifest) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') out.add(v.replace(/^\.\//, ''));
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(manifest.exports ?? {});
  for (const k of ['main', 'types', 'module']) if (typeof manifest[k] === 'string') out.add(manifest[k].replace(/^\.\//, ''));
  return [...out];
}

export function checkManifest(dir, m) {
  const problems = [];
  if (m.name !== `@marinoscar/${dir}`) problems.push(`name is '${m.name}', expected '@marinoscar/${dir}'`);
  if (m.license !== 'MIT') problems.push(`license is '${m.license}', expected 'MIT'`);
  if (m.private === true) problems.push('"private": true would make npm refuse to publish it');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(m.version ?? '')) problems.push(`version '${m.version}' is not a semver`);
  if (!/^>=\s*24(?:\.|$)/.test(m.engines?.node ?? '')) problems.push(`engines.node is '${m.engines?.node}', expected '>=24'`);
  if (m.publishConfig?.access !== 'public') problems.push('publishConfig.access must be "public"');
  if (m.publishConfig?.provenance !== true) problems.push('publishConfig.provenance must be true');
  if (m.repository?.directory !== `console/packages/${dir}`) problems.push(`repository.directory is '${m.repository?.directory}', expected 'console/packages/${dir}'`);
  for (const e of FILES_ENTRIES) if (!(m.files ?? []).includes(e)) problems.push(`files does not name '${e}'`);
  if (!m.exports || !('./package.json' in m.exports)) problems.push('exports does not export "./package.json"');
  return problems;
}

/** Problems of a tarball's file list (paths relative to the package) against the manifest. */
export function checkTarball(m, files) {
  const problems = [];
  const have = new Set(files);
  for (const f of REQUIRED) if (!have.has(f)) problems.push(`the tarball lacks ${f}`);
  for (const t of exportTargets(m)) if (!have.has(t)) problems.push(`the tarball lacks ${t}, which package.json points at`);
  for (const f of files) {
    const allowed = f === 'package.json' || f === 'README.md' || f === 'CHANGELOG.md' || f === 'LICENSE' || f.startsWith('dist/');
    if (!allowed) problems.push(`the tarball holds ${f}, which \`files\` does not name`);
    if (FORBIDDEN.some((re) => re.test(f))) problems.push(`the tarball holds ${f}: no sources, tests, fixtures, maps or config ship`);
  }
  return problems;
}

function main() {
  const list = process.argv.includes('--list');
  const dirs = readdirSync(PACKAGES).filter((d) => d.startsWith('hexactra-') && existsSync(join(PACKAGES, d, 'package.json')));
  if (dirs.length === 0) {
    console.error('check-package-pack: no packages/hexactra-* found');
    process.exit(1);
  }
  let failed = false;
  for (const dir of dirs) {
    const cwd = join(PACKAGES, dir);
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const problems = checkManifest(dir, manifest);
    const run = spawnSync('npm', ['pack', '--dry-run', '--json', '--silent'], { cwd, encoding: 'utf8' });
    if (run.status !== 0) {
      problems.push(`npm pack --dry-run failed: ${(run.stderr || run.stdout).trim().split('\n').slice(-3).join(' | ')}`);
    } else {
      const packed = JSON.parse(run.stdout)[0];
      const files = packed.files.map((f) => f.path);
      problems.push(...checkTarball(manifest, files));
      if (list) console.log(`${manifest.name}@${manifest.version}: ${files.length} files, ${packed.size} bytes packed\n${files.map((f) => `  ${f}`).join('\n')}`);
      else console.log(`${manifest.name}@${manifest.version}: ${files.length} files, ${packed.size} bytes packed (dry run, nothing published)`);
    }
    for (const p of problems) console.error(`  ${manifest.name}: ${p}`);
    if (problems.length) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
