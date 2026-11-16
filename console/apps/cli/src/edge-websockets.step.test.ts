// The deploy's edge-websockets step (#359): it adds the remote desktop
// WebSocket location to the vhost the platform CLI renders for the shared host
// proxy, checks it with nginx -t, reloads, and puts the file back on a failed check.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCli } from '@marinoscar/platform-cli';
import { DEPLOY_STATE_FILENAME, listRegisteredDeploySteps, type DeployStepContext } from '@marinoscar/platform-cli/deploy';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterAll, describe, expect, it } from 'vitest';

// The platform's own renderer, so a change to its template breaks this test
// rather than production. Not in the package's exports, hence the file path.
import { proxyRuntimeFor, renderVhost } from '../../../node_modules/@marinoscar/platform-cli/dist/engine/deploy/proxy.js';

import { APP_CLI_OPTIONS } from './app.js';
import { EDGE_WS_BEGIN, enableEdgeWebsockets, patchVhost } from './edge-websockets.step.js';

const DOMAIN = 'console.example.test';
const rendered = (): string =>
  renderVhost({ domain: DOMAIN, bindPort: 3535, proxyRoot: '/opt/infra/proxy' }, proxyRuntimeFor('container', '/opt/infra/proxy'));

function deployment(record: object | undefined, vhost: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'edge-ws-'));
  const deployRoot = join(root, 'apps', 'hexactra');
  mkdirSync(deployRoot, { recursive: true });
  if (record) writeFileSync(join(deployRoot, DEPLOY_STATE_FILENAME), JSON.stringify(record));
  const vhostPath = join(root, 'proxy', 'nginx', 'conf.d', `${DOMAIN}.conf`);
  if (vhost !== undefined) {
    mkdirSync(join(root, 'proxy', 'nginx', 'conf.d'), { recursive: true });
    writeFileSync(vhostPath, vhost);
  }
  return { deployRoot, vhostPath };
}

function fakeContext(deployRoot: string, nginxTest = { exitCode: 0, stdout: '', stderr: '' }) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const ctx = {
    pipeline: 'update',
    deployRoot,
    checkoutPath: join(deployRoot, 'repo', 'console'),
    log: (l: string) => lines.push(l),
    progress: () => {},
    exec: async (argv: readonly string[]) => {
      calls.push([...argv]);
      if (argv[0] === 'docker' && argv[1] === 'ps') return { exitCode: 0, stdout: 'abcdef123456\n', stderr: '' };
      if (argv.includes('-t')) return nginxTest;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  } as unknown as DeployStepContext;
  return { ctx, calls, lines };
}

describe('patchVhost on the platform-rendered vhost', () => {
  it('the platform vhost does not forward WebSocket upgrades (the bug)', () => {
    expect(rendered()).not.toMatch(/Upgrade/);
  });

  it('adds one WebSocket location inside the HTTPS server, before location /', () => {
    const before = rendered();
    const out = patchVhost(before);
    expect(out.result).toBe('patched');
    const text = (out as { text: string }).text;
    const https = text.indexOf('listen 443 ssl;');
    const ws = text.indexOf(EDGE_WS_BEGIN);
    const catchAll = text.indexOf('    location / {', https);
    expect(ws).toBeGreaterThan(https);
    expect(ws).toBeLessThan(catchAll);
    expect(text).toContain('location ~ "^/(viewer/[0-9a-fA-F-]{36}/websockify|fabric/v1/hosts/[0-9a-fA-F-]{36}/desktop/[0-9a-fA-F-]{36})$" {');
    expect(text).toContain('proxy_pass http://127.0.0.1:3535;');
    expect(text).toContain('proxy_set_header Upgrade           $http_upgrade;');
    expect(text).toContain('proxy_set_header Connection        "upgrade";');
    // Nothing else changed.
    expect(text.replace(/ {4}# BEGIN hexactra[\s\S]*?# END hexactra websockets\n\n/, '')).toBe(before);
  });

  it('is idempotent and leaves an unknown file alone', () => {
    const once = (patchVhost(rendered()) as { text: string }).text;
    expect(patchVhost(once).result).toBe('unchanged');
    expect(patchVhost('server { listen 80; }').result).toBe('unrecognised');
  });
});

describe('edge-websockets deploy step', () => {
  afterAll(() => resetCliForTests());

  it('runs right after publish in install and update', () => {
    resetCliForTests();
    createCli(APP_CLI_OPTIONS);
    for (const pipeline of ['install', 'update'] as const) {
      expect(listRegisteredDeploySteps(pipeline)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'edge-websockets', after: 'publish' })]),
      );
    }
  });

  it('patches the vhost, checks it and reloads the proxy container', async () => {
    const { deployRoot, vhostPath } = deployment({ domain: DOMAIN }, rendered());
    const { ctx, calls } = fakeContext(deployRoot);
    expect(await enableEdgeWebsockets(ctx)).toBe('patched');
    expect(readFileSync(vhostPath, 'utf8')).toContain(EDGE_WS_BEGIN);
    expect(calls).toContainEqual(['docker', 'exec', 'proxy-nginx', 'nginx', '-t']);
    expect(calls).toContainEqual(['docker', 'exec', 'proxy-nginx', 'nginx', '-s', 'reload']);
    // Second run: nothing to do, no reload.
    const again = fakeContext(deployRoot);
    expect(await enableEdgeWebsockets(again.ctx)).toBe('unchanged');
    expect(again.calls.some((c) => c.includes('reload'))).toBe(false);
  });

  it('uses the host nginx when the proxy runs on the host', async () => {
    const { deployRoot } = deployment({ domain: DOMAIN, proxyMode: 'host' }, rendered());
    const { ctx, calls } = fakeContext(deployRoot);
    expect(await enableEdgeWebsockets(ctx)).toBe('patched');
    expect(calls).toContainEqual(['nginx', '-t']);
    expect(calls).toContainEqual(['nginx', '-s', 'reload']);
  });

  it('puts the vhost back when nginx -t refuses it', async () => {
    const before = rendered();
    const { deployRoot, vhostPath } = deployment({ domain: DOMAIN }, before);
    const { ctx, calls, lines } = fakeContext(deployRoot, { exitCode: 1, stdout: '', stderr: 'emerg' });
    expect(await enableEdgeWebsockets(ctx)).toBe('failed');
    expect(readFileSync(vhostPath, 'utf8')).toBe(before);
    expect(calls.some((c) => c.includes('reload'))).toBe(false);
    expect(lines.join('\n')).toMatch(/put back/);
  });

  it('skips an unpublished deployment', async () => {
    const { deployRoot } = deployment({ domain: null }, undefined);
    const { ctx, calls } = fakeContext(deployRoot);
    expect(await enableEdgeWebsockets(ctx)).toBe('skipped');
    expect(calls).toEqual([]);
  });
});
