import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * Extracts a zip archive (stored or deflated entries, Unix modes and
 * symlinks kept) into `dest`. Enough for Chrome for Testing's archive, with
 * no system `unzip` needed. Refuses an entry that would land outside `dest`,
 * and zip64 archives.
 *
 * @returns the number of entries written.
 */
export function unzipTo(zip: Buffer, dest: string): number {
  const root = resolve(dest);
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip archive (no end of central directory)');
  const entries = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  if (entries === 0xffff || p === 0xffffffff) throw new Error('zip64 archives are not supported');
  let written = 0;
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const mode = zip.readUInt32LE(p + 38) >>> 16;
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const target = resolve(root, name);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`zip entry escapes the destination: ${name}`);
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip entry: ${name}`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressed);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`unsupported zip compression method ${method} for ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    if ((mode & 0o170000) === 0o120000) {
      symlinkSync(data.toString('utf8'), target);
    } else {
      writeFileSync(target, data);
      if (mode & 0o777) chmodSync(target, mode & 0o777);
    }
    written++;
  }
  return written;
}
