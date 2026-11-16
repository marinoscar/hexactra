// node --test scripts/crx3.test.mjs  (#335)
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';

import {
  extensionId,
  extensionZip,
  idFromManifestKey,
  isExtensionVersion,
  packCrx3,
  parseUpdatesXml,
  publicKeyDer,
  updatesXml,
  verifyCrx3,
} from './crx3.mjs';
import { findIds, manifestId, strayIds } from './extension-id.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

/** Entries of a zip this module wrote: { name: bytes }. */
function unzip(buf) {
  const out = {};
  let pos = 0;
  while (buf.readUInt32LE(pos) === 0x04034b50) {
    const size = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString();
    const start = pos + 30 + nameLen;
    out[name] = inflateRawSync(buf.subarray(start, start + size));
    pos = start + size;
  }
  return out;
}

function extensionDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hx-ext-'));
  mkdirSync(join(dir, 'icons'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'X', version: '0.1.0', key: 'MIIBkey' }));
  writeFileSync(join(dir, 'icons', 'a.txt'), 'icon');
  return dir;
}

test('packs a CRX3 that verifies and carries the key id', () => {
  const crx = packCrx3(extensionZip(extensionDir(), '0.1.0.7'), pem);
  const { id, zip } = verifyCrx3(crx);
  assert.equal(id, extensionId(publicKeyDer(pem)));
  assert.match(id, /^[a-p]{32}$/);
  const files = unzip(zip);
  assert.deepEqual(Object.keys(files).sort(), ['icons/a.txt', 'manifest.json']);
  const manifest = JSON.parse(files['manifest.json'].toString());
  assert.equal(manifest.version, '0.1.0.7');
  assert.equal(manifest.key, undefined, 'the CRX carries the key, not the manifest');
});

test('rejects a tampered or foreign CRX', () => {
  const crx = packCrx3(extensionZip(extensionDir(), '1.0'), pem);
  const flipped = Buffer.from(crx);
  flipped[flipped.length - 30] ^= 0xff;
  assert.throws(() => verifyCrx3(flipped), /signature/);
  const bad = Buffer.from(crx);
  bad.write('Cr23', 0);
  assert.throws(() => verifyCrx3(bad), /magic/);
});

test('builds are reproducible', () => {
  const dir = extensionDir();
  assert.ok(extensionZip(dir, '1.2').equals(extensionZip(dir, '1.2')));
});

test('the update manifest round-trips', () => {
  const xml = updatesXml({ id: 'a'.repeat(32), version: '0.1.0.42', codebase: 'https://example.test/x.crx?a=1&b=2' });
  assert.match(xml, /<gupdate xmlns='http:\/\/www.google.com\/update2\/response' protocol='2.0'>/);
  assert.deepEqual(parseUpdatesXml(xml), { id: 'a'.repeat(32), version: '0.1.0.42', codebase: 'https://example.test/x.crx?a=1&b=2' });
});

test('extension versions', () => {
  for (const v of ['1', '0.1.0', '0.1.0.65535']) assert.ok(isExtensionVersion(v), v);
  for (const v of ['', '0.1.0.65536', '1.2.3.4.5', '01.2', 'v1', '1.-2']) assert.ok(!isExtensionVersion(v), v);
});

test('the committed manifest key, the Rust constant and the scripts agree', () => {
  const id = manifestId();
  const rust = readFileSync(new URL('../crates/hexactra-core/src/bridge.rs', import.meta.url), 'utf8');
  assert.match(rust, new RegExp(`EXTENSION_ID: &str = "${id}"`));
  const sh = readFileSync(new URL('./install-native-host.sh', import.meta.url), 'utf8');
  assert.match(sh, new RegExp(`EXTENSION_ID="${id}"`));
  const m = JSON.parse(readFileSync(new URL('../apps/chrome-extension/manifest/manifest.json', import.meta.url), 'utf8'));
  assert.equal(idFromManifestKey(m.key), id);
});

test('the id check flags a stray id or key and ignores base64 runs', () => {
  const good = 'ahpjoclfeibdmlnbaednepiihpamklcl';
  const other = 'p'.repeat(32); // built, so the repository check does not see a stray literal here
  assert.deepEqual(findIds(`chrome-extension://${good}/ and ${other}.`), [good, other]);
  assert.deepEqual(findIds(`Zm9v${good}+abc`), [], 'part of a base64 string');
  const files = { 'a.md': `use ${good}`, 'b.rs': `const ID: &str = "${other}";`, 'pnpm-lock.yaml': other };
  assert.deepEqual(strayIds(Object.keys(files), (f) => files[f], good), [{ file: 'b.rs', id: other }]);
  const otherKey = publicKeyDer(pem).toString('base64');
  const withKey = { 'release/manifest.json': `{"key": "${otherKey}"}` };
  assert.deepEqual(strayIds(Object.keys(withKey), (f) => withKey[f], good), [{ file: 'release/manifest.json', id: extensionId(publicKeyDer(pem)) }]);
});
