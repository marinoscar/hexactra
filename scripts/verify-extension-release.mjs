#!/usr/bin/env node
// Checks a published extension the way Chrome's policy install reads it
// (#335): the update manifest names the manifest's id, its codebase
// downloads a CRX3 whose signature verifies, with that id and version.
//   node scripts/verify-extension-release.mjs <updates.xml URL>

import { inflateRawSync } from 'node:zlib';

import { parseUpdatesXml, verifyCrx3 } from './crx3.mjs';
import { manifestId } from './extension-id.mjs';

const url = process.argv[2];
if (!url) {
  console.error('usage: verify-extension-release.mjs <updates.xml URL>');
  process.exit(2);
}

async function get(u) {
  const res = await fetch(u, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${u}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** manifest.json of a zip written by crx3.mjs (deflated entries). */
function zipManifest(zip) {
  let pos = 0;
  while (zip.readUInt32LE(pos) === 0x04034b50) {
    const size = zip.readUInt32LE(pos + 18);
    const nameLen = zip.readUInt16LE(pos + 26);
    const name = zip.subarray(pos + 30, pos + 30 + nameLen).toString();
    const start = pos + 30 + nameLen;
    if (name === 'manifest.json') return JSON.parse(inflateRawSync(zip.subarray(start, start + size)).toString());
    pos = start + size;
  }
  throw new Error('the CRX has no manifest.json');
}

const expected = manifestId();
const info = parseUpdatesXml((await get(url)).toString('utf8'));
if (info.id !== expected) throw new Error(`updates.xml names ${info.id}, expected ${expected}`);
const { id, zip } = verifyCrx3(await get(info.codebase));
if (id !== expected) throw new Error(`the CRX is signed for ${id}, expected ${expected}`);
const version = zipManifest(zip).version;
if (version !== info.version) throw new Error(`the CRX is version ${version}, updates.xml says ${info.version}`);
console.log(`OK: ${id} ${version} from ${info.codebase}`);
