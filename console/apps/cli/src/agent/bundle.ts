import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentPaths } from './paths.js';

/** The bundle CI publishes (scripts/package-agent-bundle.mjs, .github/workflows/agent-release.yml). */
export const BUNDLE_NAME = 'hexactra-agent-linux-x86_64';
export const RELEASES = 'https://github.com/marinoscar/hexactra/releases/download';

export interface BundleInfo {
  version: string;
  commit: string;
  builtAt?: string;
  files: Record<string, string>;
}

export interface InstalledBundle {
  version: string;
  commit: string;
  dir: string;
}

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Where a bundle comes from: `--bundle FILE|URL`, else a release (`agent-v<version>`, default `agent-latest`). */
export function bundleSource(opts: { bundle?: string; version?: string }): { archive: string; checksum: string } {
  if (opts.bundle) return { archive: opts.bundle, checksum: `${opts.bundle}.sha256` };
  const tag = opts.version ? `agent-v${opts.version.replace(/^v/, '')}` : 'agent-latest';
  const base = `${RELEASES}/${tag}/${BUNDLE_NAME}.tar.gz`;
  return { archive: base, checksum: `${base}.sha256` };
}

const isUrl = (s: string) => /^https?:\/\//.test(s);

async function read(source: string, fetch: Fetch): Promise<Buffer> {
  if (!isUrl(source)) return readFileSync(source);
  const res = await fetch(source);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${source}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Downloads (or reads) the bundle, checks its sha256 against the published
 * checksum, extracts it, checks every file against BUNDLE.json, and installs
 * it as a new version. The active version is switched only by
 * {@link activate}, so a failed download never touches a working install.
 */
export async function fetchBundle(
  paths: AgentPaths,
  opts: { bundle?: string; version?: string },
  fetch: Fetch,
  log: (line: string) => void,
): Promise<InstalledBundle> {
  const src = bundleSource(opts);
  log(`Downloading ${src.archive}`);
  const archive = await read(src.archive, fetch);
  const expected = (await read(src.checksum, fetch)).toString('utf8').trim().split(/\s+/)[0] ?? '';
  const actual = sha256(archive);
  if (!/^[0-9a-f]{64}$/.test(expected) || expected !== actual) {
    throw new Error(`checksum mismatch for the agent bundle (expected ${expected || 'nothing'}, got ${actual}); nothing was installed`);
  }
  log(`Checksum verified (sha256 ${actual.slice(0, 12)}…)`);

  const stage = mkdtempSync(join(tmpdir(), 'hexactra-agent-'));
  try {
    const file = join(stage, 'bundle.tar.gz');
    writeFileSync(file, archive);
    execFileSync('tar', ['-xzf', file, '-C', stage]);
    const dir = join(stage, BUNDLE_NAME);
    const info = JSON.parse(readFileSync(join(dir, 'BUNDLE.json'), 'utf8')) as BundleInfo;
    for (const [rel, sum] of Object.entries(info.files)) {
      const p = join(dir, rel);
      if (!existsSync(p) || sha256(readFileSync(p)) !== sum) throw new Error(`bundle file does not match BUNDLE.json: ${rel}; nothing was installed`);
    }
    for (const needed of ['bin/hexactra-agent', 'bin/hexactra-native-host', 'extension/manifest.json']) {
      if (!existsSync(join(dir, needed))) throw new Error(`the bundle has no ${needed}`);
    }
    const id = `${info.version}-${info.commit.slice(0, 7)}`;
    const target = join(paths.versionsDir, id);
    mkdirSync(paths.versionsDir, { recursive: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(dir, target);
    log(`Agent ${info.version} (${info.commit.slice(0, 7)}) unpacked`);
    return { version: info.version, commit: info.commit, dir: target };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Points `current` at a bundle (atomic rename of a fresh symlink). */
export function activate(paths: AgentPaths, bundle: InstalledBundle): void {
  const tmp = `${paths.current}.next`;
  rmSync(tmp, { force: true });
  symlinkSync(bundle.dir, tmp);
  renameSync(tmp, paths.current);
}
