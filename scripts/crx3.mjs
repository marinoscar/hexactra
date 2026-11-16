// CRX3 packaging for the Hexactra extension (#335), with node:crypto and
// node:zlib only. Google Chrome installs an off-store extension only through
// enterprise policy, from a signed CRX listed in an update manifest
// (updates.xml); this module builds both.
//
// CRX3 layout: "Cr24" | u32le 3 | u32le header length | CrxFileHeader | zip.
// CrxFileHeader (protobuf):
//   2:     AsymmetricKeyProof { 1: public key (SPKI DER), 2: signature }
//   10000: signed_header_data = SignedData { 1: crx id (16 bytes) }
// The RSA-SHA256 signature covers
//   "CRX3 SignedData\x00" | u32le len(signed_header_data) | signed_header_data | zip.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const MAGIC = Buffer.from('Cr24');
const SIGNED_PREFIX = Buffer.from('CRX3 SignedData\x00', 'latin1');

/** The SPKI DER of a PEM private or public key. */
export function publicKeyDer(pem) {
  const key = pem.includes('PRIVATE KEY') ? createPublicKey(createPrivateKey(pem)) : createPublicKey(pem);
  return key.export({ type: 'spki', format: 'der' });
}

/** Chrome's extension id: the first 16 bytes of sha256(SPKI), as nibbles a–p. */
export function extensionId(spkiDer) {
  const hex = createHash('sha256').update(spkiDer).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** The id for a manifest `key` (base64 SPKI DER). */
export function idFromManifestKey(key) {
  return extensionId(Buffer.from(key, 'base64'));
}

// ---------------------------------------------------------------- protobuf

function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

function field(num, bytes) {
  return Buffer.concat([varint(num * 8 + 2), varint(bytes.length), bytes]);
}

function readVarint(buf, pos) {
  let n = 0;
  let mul = 1;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const b = buf[pos++];
    n += (b & 0x7f) * mul;
    if (b < 0x80) return [n, pos];
    mul *= 128;
  }
}

/** Length-delimited fields of a message, as [field number, bytes] pairs. */
function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    if (tag % 8 !== 2) throw new Error(`unexpected wire type ${tag % 8}`);
    let len;
    [len, pos] = readVarint(buf, pos);
    out.push([Math.floor(tag / 8), buf.subarray(pos, pos + len)]);
    pos += len;
  }
  return out;
}

// ---------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A deflated zip of `entries` ([name, bytes]), with a fixed timestamp so builds are reproducible. */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (2020 - 1980) << 9 | 1 << 5 | 1;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Every file under `dir`, sorted, as [posix relative path, bytes]. */
export function readTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push([relative(dir, p).split(sep).join('/'), readFileSync(p)]);
    }
  };
  walk(dir);
  return out;
}

/**
 * The extension directory as a zip, with manifest.json rewritten: `key` is
 * removed (the CRX carries the public key) and `version` set.
 */
export function extensionZip(dir, version) {
  const entries = readTree(dir).map(([name, data]) => {
    if (name !== 'manifest.json') return [name, data];
    const m = JSON.parse(data.toString('utf8'));
    delete m.key;
    if (version) m.version = version;
    return [name, Buffer.from(JSON.stringify(m, null, 2) + '\n')];
  });
  return zip(entries);
}

// ---------------------------------------------------------------- crx3

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

/** A signed CRX3 of `zipBytes` with the PEM private key. */
export function packCrx3(zipBytes, privatePem) {
  const priv = createPrivateKey(privatePem);
  const spki = createPublicKey(priv).export({ type: 'spki', format: 'der' });
  const crxId = createHash('sha256').update(spki).digest().subarray(0, 16);
  const signedHeaderData = field(1, crxId);
  const signature = sign('sha256', Buffer.concat([SIGNED_PREFIX, u32(signedHeaderData.length), signedHeaderData, zipBytes]), priv);
  const header = Buffer.concat([field(2, Buffer.concat([field(1, spki), field(2, signature)])), field(10000, signedHeaderData)]);
  return Buffer.concat([MAGIC, u32(3), u32(header.length), header, zipBytes]);
}

/**
 * Checks a CRX3 the way Chrome does: magic, version, a valid RSA-SHA256
 * proof whose key hashes to the signed crx id. Returns { id, zip }.
 */
export function verifyCrx3(crx) {
  if (!crx.subarray(0, 4).equals(MAGIC)) throw new Error('not a CRX (bad magic)');
  if (crx.readUInt32LE(4) !== 3) throw new Error(`CRX version ${crx.readUInt32LE(4)}, expected 3`);
  const headerLen = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLen);
  const zipBytes = crx.subarray(12 + headerLen);
  let signedHeaderData;
  const proofs = [];
  for (const [num, bytes] of fields(header)) {
    if (num === 10000) signedHeaderData = bytes;
    else if (num === 2) {
      const f = Object.fromEntries(fields(bytes));
      proofs.push({ key: f[1], signature: f[2] });
    }
  }
  if (!signedHeaderData) throw new Error('CRX has no signed header data');
  const crxId = Object.fromEntries(fields(signedHeaderData))[1];
  if (!crxId || crxId.length !== 16) throw new Error('CRX has no crx id');
  const signed = Buffer.concat([SIGNED_PREFIX, u32(signedHeaderData.length), signedHeaderData, zipBytes]);
  const proof = proofs.find((p) => createHash('sha256').update(p.key).digest().subarray(0, 16).equals(crxId));
  if (!proof) throw new Error('no RSA proof matches the crx id');
  const pub = createPublicKey({ key: proof.key, format: 'der', type: 'spki' });
  if (!verify('sha256', signed, pub, proof.signature)) throw new Error('CRX signature does not verify');
  return { id: extensionId(proof.key), zip: zipBytes };
}

/** Chrome's update manifest (gupdate) for one extension version. */
export function updatesXml({ id, version, codebase }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;');
  return [
    "<?xml version='1.0' encoding='UTF-8'?>",
    "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>",
    `  <app appid='${esc(id)}'>`,
    `    <updatecheck codebase='${esc(codebase)}' version='${esc(version)}' />`,
    '  </app>',
    '</gupdate>',
    '',
  ].join('\n');
}

/** { id, version, codebase } of an update manifest this module wrote. */
export function parseUpdatesXml(xml) {
  const id = /appid='([a-p]{32})'/.exec(xml)?.[1];
  const codebase = /codebase='([^']+)'/.exec(xml)?.[1]?.replace(/&amp;/g, '&');
  const version = /version='([0-9.]+)'/.exec(xml.slice(xml.indexOf('<updatecheck')))?.[1];
  if (!id || !codebase || !version) throw new Error('not a Hexactra update manifest');
  return { id, version, codebase };
}

/** A Chrome extension version (1–4 dot-separated integers, each ≤ 65535). */
export function isExtensionVersion(v) {
  const parts = String(v).split('.');
  return parts.length >= 1 && parts.length <= 4 && parts.every((p) => /^(0|[1-9]\d{0,4})$/.test(p) && Number(p) <= 65535);
}
