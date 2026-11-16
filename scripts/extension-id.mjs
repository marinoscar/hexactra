#!/usr/bin/env node
// The Hexactra extension id, derived from the public key in its manifest
// (#335). Every literal id in the repository must equal it:
//   node scripts/extension-id.mjs           # print the id
//   node scripts/extension-id.mjs --check   # fail on any other id in tracked files
//   node scripts/extension-id.mjs --pem key.pem   # the id a signing key gives

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extensionId, idFromManifestKey, publicKeyDer } from './crx3.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = 'apps/chrome-extension/manifest/manifest.json';

/** The id the committed manifest key gives. */
export function manifestId(dir = root) {
  const m = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
  if (!m.key) throw new Error(`${MANIFEST} has no "key"`);
  return idFromManifestKey(m.key);
}

/** Extension-id-shaped literals (32 letters a–p as a whole word) in `text`. */
export function findIds(text) {
  return [...text.matchAll(/(?<![A-Za-z0-9+])[a-p]{32}(?![A-Za-z0-9+=])/g)].map((m) => m[0]);
}

const SKIP = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|Cargo\.lock)$|\.(png|jpg|jpeg|gif|ico|woff2?|crx|zip|gz|pem|der)$/;

/** [{ file, id }] for every tracked literal that is not `expected`. */
export function strayIds(files, read, expected) {
  const out = [];
  for (const file of files) {
    if (SKIP.test(file)) continue;
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const id of findIds(text)) if (id !== expected) out.push({ file, id });
    // A manifest "key" elsewhere (a prebuilt copy) must give the same id.
    for (const m of text.matchAll(/"key"\s*:\s*"(MII[A-Za-z0-9+/=]+)"/g)) {
      let id;
      try {
        id = idFromManifestKey(m[1]);
      } catch {
        continue;
      }
      if (id !== expected) out.push({ file, id });
    }
  }
  return out;
}

function main(argv) {
  const pemAt = argv.indexOf('--pem');
  if (pemAt >= 0) {
    console.log(extensionId(publicKeyDer(readFileSync(argv[pemAt + 1], 'utf8'))));
    return 0;
  }
  const id = manifestId();
  if (!argv.includes('--check')) {
    console.log(id);
    return 0;
  }
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const stray = strayIds(files, (f) => readFileSync(join(root, f), 'utf8'), id);
  if (stray.length) {
    for (const s of stray) console.error(`${s.file}: extension id ${s.id} is not the manifest's ${id}`);
    return 1;
  }
  console.log(`OK: every extension id literal is ${id}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
