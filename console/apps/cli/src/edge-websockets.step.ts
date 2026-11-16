import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEPLOY_STATE_FILENAME, type DeployStepContext, type DeployStepRegistration } from '@marinoscar/platform-cli/deploy';

/**
 * WebSockets through the shared host proxy (#359).
 *
 * `hexactra deploy` publishes the console through the shared host proxy
 * (`/opt/infra/proxy`, container `proxy-nginx`), whose vhost the platform CLI
 * renders. Its `location /` never forwards `Upgrade` / `Connection`
 * (hop-by-hop headers nginx drops unless told otherwise), and the platform
 * has no way yet to declare a WebSocket route there. So every remote desktop
 * WebSocket died at the edge with close code 1006: the viewer's
 * `/viewer/<hostId>/websockify` and the node's
 * `/fabric/v1/hosts/<id>/desktop/<tunnel>`.
 *
 * This step adds one regex location for exactly those two paths to the
 * managed vhost, checks it with `nginx -t` and reloads; on a failed check it
 * puts the file back. It runs after `publish`, which re-renders the vhost on
 * every update, so the location is added again each time. Remove it when the
 * platform's host proxy can declare WebSocket routes (seam request upstream).
 */

export const EDGE_WS_BEGIN = '    # BEGIN hexactra websockets (#359): added by the hexactra deploy step edge-websockets';
export const EDGE_WS_END = '    # END hexactra websockets';
/** The two WebSocket routes of the console, and nothing else. */
export const EDGE_WS_PATHS =
  '^/(viewer/[0-9a-fA-F-]{36}/websockify|fabric/v1/hosts/[0-9a-fA-F-]{36}/desktop/[0-9a-fA-F-]{36})$';
const DEFAULT_PROXY_CONTAINER = 'proxy-nginx';

/** The location block, proxied to the console's own nginx on `bindPort`. */
export function websocketLocation(bindPort: number): string {
  return [
    EDGE_WS_BEGIN,
    `    location ~ "${EDGE_WS_PATHS}" {`,
    `        proxy_pass http://127.0.0.1:${bindPort};`,
    '        proxy_http_version 1.1;',
    '',
    '        proxy_set_header Host              $host;',
    '        proxy_set_header X-Real-IP         $remote_addr;',
    '        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto https;',
    '        proxy_set_header X-Forwarded-Host  $host;',
    '        proxy_set_header Upgrade           $http_upgrade;',
    '        proxy_set_header Connection        "upgrade";',
    '',
    '        proxy_buffering off;',
    '        # A desktop tunnel lasts at most an hour; the fabric pings every 20 s.',
    '        proxy_read_timeout 3700s;',
    '        proxy_send_timeout 3700s;',
    '    }',
    EDGE_WS_END,
    '',
  ].join('\n');
}

/**
 * The vhost with the WebSocket location added inside its HTTPS server, before
 * that server's `location /`. Returns `unchanged` when it is already there,
 * or `unrecognised` when the text is not the shape the platform renders (the
 * step then warns and leaves the file alone).
 */
export function patchVhost(text: string): { result: 'patched'; text: string } | { result: 'unchanged' | 'unrecognised' } {
  if (text.includes(EDGE_WS_BEGIN)) return { result: 'unchanged' };
  const https = text.search(/\n\s*listen 443 ssl;/);
  if (https < 0) return { result: 'unrecognised' };
  const rest = text.slice(https);
  const loc = rest.search(/\n {4}location \/ \{\n/);
  if (loc < 0) return { result: 'unrecognised' };
  const port = /proxy_pass http:\/\/127\.0\.0\.1:(\d+);/.exec(rest.slice(loc))?.[1];
  if (!port) return { result: 'unrecognised' };
  const at = https + loc + 1;
  return { result: 'patched', text: `${text.slice(0, at)}${websocketLocation(Number(port))}\n${text.slice(at)}` };
}

interface DeployRecord {
  domain?: string | null;
  proxyRoot?: string;
  proxyMode?: 'container' | 'host';
  proxyContainer?: string;
}

function readRecord(deployRoot: string): DeployRecord | undefined {
  const path = join(deployRoot, DEPLOY_STATE_FILENAME);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DeployRecord;
  } catch {
    return undefined;
  }
}

/** Where the vhost is, and how to run nginx for the proxy: in its container, or on the host. */
async function proxyOf(ctx: DeployStepContext, record: DeployRecord): Promise<{ vhost: string; nginx: string[] } | undefined> {
  if (!record.domain || !/^[a-z0-9.-]+$/i.test(record.domain)) return undefined;
  const root = record.proxyRoot ?? join(ctx.deployRoot, '..', '..', 'proxy');
  const vhost = join(root, 'nginx', 'conf.d', `${record.domain}.conf`);
  let mode = record.proxyMode;
  const container = record.proxyContainer ?? DEFAULT_PROXY_CONTAINER;
  if (!/^[A-Za-z0-9_.-]+$/.test(container)) return undefined;
  if (mode === undefined) {
    const ps = await ctx.exec(['docker', 'ps', '-q', '--filter', `name=^${container}$`], { allowExitCodes: [1] });
    mode = ps.stdout.trim() ? 'container' : 'host';
  }
  return { vhost, nginx: mode === 'container' ? ['docker', 'exec', container, 'nginx'] : ['nginx'] };
}

export async function enableEdgeWebsockets(ctx: DeployStepContext): Promise<'patched' | 'unchanged' | 'skipped' | 'unrecognised' | 'failed'> {
  const record = readRecord(ctx.deployRoot);
  const proxy = record ? await proxyOf(ctx, record) : undefined;
  if (!proxy || !existsSync(proxy.vhost)) {
    ctx.log('edge-websockets: this deployment is not published through the host proxy; nothing to do.');
    return 'skipped';
  }
  const before = readFileSync(proxy.vhost, 'utf8');
  const patch = patchVhost(before);
  if (patch.result === 'unchanged') {
    ctx.log('edge-websockets: the host proxy already forwards the remote desktop WebSockets.');
    return 'unchanged';
  }
  if (patch.result !== 'patched') {
    ctx.log(`edge-websockets: WARNING ${proxy.vhost} is not the vhost shape this step knows; remote desktops will not connect until it forwards WebSocket upgrades.`);
    return 'unrecognised';
  }
  writeFileSync(proxy.vhost, patch.text);
  const check = await ctx.exec([...proxy.nginx, '-t'], { allowExitCodes: [1] });
  if (check.exitCode !== 0) {
    writeFileSync(proxy.vhost, before);
    ctx.log(`edge-websockets: WARNING nginx -t refused the WebSocket location, so the vhost was put back: ${check.stderr || check.stdout}`);
    return 'failed';
  }
  await ctx.exec([...proxy.nginx, '-s', 'reload']);
  ctx.log('edge-websockets: the host proxy now forwards the remote desktop WebSockets (/viewer/<host>/websockify, /fabric/v1/hosts/<id>/desktop/<tunnel>).');
  return 'patched';
}

const step = { title: 'Forward remote desktop WebSockets at the host proxy', run: async (ctx: DeployStepContext) => void (await enableEdgeWebsockets(ctx)) };

/** Right after `publish` (which rewrites the vhost) in both pipelines. */
export const EDGE_WEBSOCKETS_STEPS: DeployStepRegistration[] = [
  { pipeline: 'install', id: 'edge-websockets', after: 'publish', step },
  { pipeline: 'update', id: 'edge-websockets', after: 'publish', step },
];
