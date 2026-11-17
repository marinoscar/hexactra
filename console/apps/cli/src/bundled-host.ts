import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The bundled VPS browser host on or off (#386). `COMPOSE_PROFILES` in the
 * deployment's `.env` decides whether `fabric-host` runs (#343): `bundled-host`
 * on, `none` off. `deploy update` keeps the value (its generator only fills an
 * empty one), so the choice survives updates. Off stops and removes only the
 * fabric-host container and keeps its volume, so `on` brings the profiles back.
 */

export const APPS_ROOT = '/opt/infra/apps';
const ON = 'bundled-host';
const OFF = 'none';

export interface Exec {
  (argv: string[]): { status: number; stdout: string; stderr: string };
}

export const realExec: Exec = (argv) => {
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
};

export interface BundledHostDeps {
  exec: Exec;
  log: (line: string) => void;
  appsRoot?: string;
}

/** The deployment: `--root`, else the one deployment under /opt/infra/apps that has this app's checkout. */
export function deploymentRoot(root: string | undefined, appsRoot = APPS_ROOT): string {
  if (root) return resolve(root);
  const found = existsSync(appsRoot)
    ? readdirSync(appsRoot).filter((n) => existsSync(join(appsRoot, n, 'repo', 'console', 'infra', 'compose', '.env')))
    : [];
  if (found.length === 1) return join(appsRoot, found[0]!);
  throw new Error(found.length ? `Several deployments under ${appsRoot} (${found.join(', ')}); pass --root.` : `No deployment found under ${appsRoot}; pass --root.`);
}

const composeDir = (root: string) => join(root, 'repo', 'console', 'infra', 'compose');

/** The current COMPOSE_PROFILES value ('' when unset). */
export function readProfiles(envFile: string): string {
  const m = /^COMPOSE_PROFILES=(.*)$/m.exec(readFileSync(envFile, 'utf8'));
  return (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
}

/** Writes COMPOSE_PROFILES, keeping every other line. */
export function writeProfiles(envFile: string, value: string): void {
  const text = readFileSync(envFile, 'utf8');
  const next = /^COMPOSE_PROFILES=.*$/m.test(text)
    ? text.replace(/^COMPOSE_PROFILES=.*$/m, `COMPOSE_PROFILES=${value}`)
    : `${text}${text.endsWith('\n') || !text ? '' : '\n'}COMPOSE_PROFILES=${value}\n`;
  writeFileSync(envFile, next);
}

interface Container {
  id: string;
  service: string;
  state: string;
}

function containers(d: BundledHostDeps, dir: string): Container[] {
  const r = d.exec(['docker', 'ps', '-a', '--filter', `label=com.docker.compose.project.working_dir=${dir}`, '--format', '{{.ID}} {{.Label "com.docker.compose.service"}} {{.State}}']);
  if (r.status !== 0) throw new Error(`docker ps failed: ${r.stderr.trim()}`);
  return r.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 3)
    .map(([id, service, state]) => ({ id: id!, service: service!, state: state! }));
}

export interface BundledHostStatus {
  setting: 'on' | 'off';
  running: boolean;
}

export function bundledHostStatus(d: BundledHostDeps, root: string): BundledHostStatus {
  const dir = composeDir(root);
  const profiles = readProfiles(join(dir, '.env')).split(',').map((p) => p.trim());
  const host = containers(d, dir).find((c) => c.service === 'fabric-host');
  return { setting: profiles.includes(ON) ? 'on' : 'off', running: host?.state === 'running' };
}

/** Turns the bundled host off: COMPOSE_PROFILES=none, then stop and remove only fabric-host (its volume stays). */
export function bundledHostOff(d: BundledHostDeps, root: string): void {
  const dir = composeDir(root);
  writeProfiles(join(dir, '.env'), OFF);
  d.log('COMPOSE_PROFILES=none: the bundled browser host stays off across updates.');
  const host = containers(d, dir).find((c) => c.service === 'fabric-host');
  if (!host) return d.log('No bundled host container is running.');
  for (const argv of [['docker', 'stop', host.id], ['docker', 'rm', host.id]]) {
    const r = d.exec(argv);
    if (r.status !== 0) throw new Error(`${argv.join(' ')} failed: ${r.stderr.trim()}`);
  }
  d.log('Stopped and removed the bundled host container (its profiles volume is kept, so `on` brings them back).');
  d.log('It still shows in Fleet as offline: revoke it there (or `hexactra fleet revoke local --yes`) if you do not want it back.');
}

/** Turns the bundled host on: COMPOSE_PROFILES=bundled-host, then `docker compose up -d fabric-host` with the stack's own files. */
export function bundledHostOn(d: BundledHostDeps, root: string): void {
  const dir = composeDir(root);
  writeProfiles(join(dir, '.env'), ON);
  d.log('COMPOSE_PROFILES=bundled-host: the bundled browser host runs, and keeps running across updates.');
  const api = containers(d, dir).find((c) => c.service === 'api');
  if (!api) throw new Error('The stack is not running; run `hexactra deploy update` to start it with the bundled host.');
  const labels = d.exec(['docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}', api.id]);
  if (labels.status !== 0) throw new Error(`docker inspect failed: ${labels.stderr.trim()}`);
  const [project, files] = labels.stdout.trim().split('|');
  if (!project || !files) throw new Error('Could not read the stack\'s compose project from its containers; run `hexactra deploy update`.');
  const argv = ['docker', 'compose', '-p', project, '--project-directory', dir, '--env-file', join(dir, '.env'), ...files.split(',').flatMap((f) => ['-f', f]), '--profile', ON, 'up', '-d', 'fabric-host'];
  const r = d.exec(argv);
  if (r.status !== 0) throw new Error(`docker compose up fabric-host failed: ${r.stderr.trim()}`);
  d.log('The bundled host is starting; it shows in Fleet as "local" within a minute.');
}
