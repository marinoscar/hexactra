#!/usr/bin/env node
// Packs the built extension as a signed CRX3 plus Chrome's update manifest,
// for the policy force-install on nodes (#335, docs/nodes.md).
//
//   node scripts/pack-crx3.mjs --key key.pem --version 0.1.0.42 \
//     --codebase https://…/hexactra-extension.crx \
//     [--extension-dir apps/chrome-extension/dist] [--out dist/agent] [--any-key]
//
// The key must give the manifest's extension id, so the id Chrome installs is
// the one the native host and the policy allow. `--any-key` skips that check,
// for pull-request builds that have no access to the signing key.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extensionZip, isExtensionVersion, packCrx3, updatesXml, verifyCrx3 } from './crx3.mjs';
import { manifestId } from './extension-id.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CRX_NAME = 'hexactra-extension.crx';
export const UPDATES_NAME = 'updates.xml';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const fail = (msg) => {
  console.error(`pack-crx3: ${msg}`);
  process.exit(1);
};

const keyFile = arg('--key');
const version = arg('--version');
const codebase = arg('--codebase');
const extensionDir = resolve(root, arg('--extension-dir', 'apps/chrome-extension/dist'));
const out = resolve(root, arg('--out', 'dist/agent'));
if (!keyFile || !version || !codebase) fail('--key, --version and --codebase are required');
if (!isExtensionVersion(version)) fail(`"${version}" is not a Chrome extension version (1-4 integers, each at most 65535)`);
if (!/^https?:\/\//.test(codebase)) fail('--codebase must be an http(s) URL');

const pem = readFileSync(keyFile, 'utf8');
const crx = packCrx3(extensionZip(extensionDir, version), pem);
const { id } = verifyCrx3(crx);
const expected = manifestId();
if (id !== expected && !argv.includes('--any-key')) {
  fail(`the signing key gives extension id ${id}, but the manifest key gives ${expected}; nothing was written`);
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, CRX_NAME), crx);
writeFileSync(join(out, UPDATES_NAME), updatesXml({ id, version, codebase }));
console.log(JSON.stringify({ id, version, crx: join(out, CRX_NAME), updates: join(out, UPDATES_NAME), bytes: crx.length }));
