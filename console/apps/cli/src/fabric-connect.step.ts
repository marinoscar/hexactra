import { join } from 'node:path';

import type { DeployStepContext, DeployStepRegistration } from '@marinoscar/platform-cli/deploy';

/** The fabric bundled with the console's stack, as the api container reaches it. */
export const BUNDLED_FABRIC_URL = 'http://fabric-control:8787';
/** The in-container script (apps/api/src/fabric/fabric-connect.cli.ts), from the api image's working directory. */
const SCRIPT = 'dist/fabric/fabric-connect.cli.js';
const RESULT_PREFIX = 'FABRIC_CONNECT ';
/**
 * Exit codes the in-container script may end with without failing the deploy:
 * 1 (it ran and said "not connected") and 137 (the kernel killed it, SIGKILL:
 * the script boots a second copy of the application inside the api container,
 * under that container's memory limit). Either way the step warns and the
 * deployment goes on (#668).
 */
const TOLERATED_EXIT_CODES = [1, 137] as const;

interface ConnectStatus {
  state: 'connected' | 'missing' | 'broken';
  url: string | null;
  tokenHint: string | null;
  error: string | null;
}

/** A compose service's running container in this deployment, by compose labels. */
async function containerOf(ctx: DeployStepContext, service: string): Promise<string | undefined> {
  const composeDir = join(ctx.checkoutPath, 'infra', 'compose');
  const { stdout } = await ctx.exec([
    'docker', 'ps', '-q',
    '--filter', `label=com.docker.compose.project.working_dir=${composeDir}`,
    '--filter', `label=com.docker.compose.service=${service}`,
  ]);
  const id = stdout.trim().split('\n')[0]?.trim();
  // Container ids are hex; anything else is not interpolated into a shell line.
  return id && /^[0-9a-f]{6,64}$/.test(id) ? id : undefined;
}

/** The last `FABRIC_CONNECT {...}` line of the script's output. */
export function parseStatus(stdout: string): ConnectStatus | undefined {
  const line = stdout.split('\n').reverse().find((l) => l.startsWith(RESULT_PREFIX));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length)) as ConnectStatus;
  } catch {
    return undefined;
  }
}

/** What the step does with a status: nothing, connect the bundled fabric, or leave the operator's own URL alone. */
export function decide(status: ConnectStatus): 'keep' | 'connect' | 'leave-custom' {
  if (status.state === 'connected') return 'keep';
  if (status.state === 'broken' && status.url && status.url.replace(/\/+$/, '') !== BUNDLED_FABRIC_URL) return 'leave-custom';
  return 'connect';
}

/**
 * Connects the console to the bundled fabric (issue #309). When the console is
 * not connected (or its bundled connection is broken, e.g. after a volume
 * restore), it mints an `hxs_` service token inside `fabric-control` and pipes
 * it straight into the api container's script, which stores it encrypted: the
 * token is in no argv, no log line and no journal. A connection the operator
 * pointed at another fabric is never replaced. A failure warns and leaves the
 * deployment as it is: the connection can still be set in Administration →
 * Fabric connection, and the next `deploy update` tries again.
 */
export async function connectFabric(ctx: DeployStepContext): Promise<'kept' | 'connected' | 'left-custom' | 'skipped' | 'failed'> {
  const api = await containerOf(ctx, 'api');
  const control = await containerOf(ctx, 'fabric-control');
  if (!api || !control) {
    ctx.log('fabric-connect: no running api or fabric-control container in this deployment; nothing to connect.');
    return 'skipped';
  }
  const before = parseStatus((await ctx.exec(['docker', 'exec', api, 'node', SCRIPT, 'status'], { allowExitCodes: TOLERATED_EXIT_CODES })).stdout);
  if (!before) {
    ctx.log('fabric-connect: WARNING could not read the console\'s fabric connection (the check may have been killed for memory: see docker stats and the kernel log); set it at Administration → Fabric connection, or run deploy update again.');
    return 'failed';
  }
  switch (decide(before)) {
    case 'keep':
      ctx.log(`fabric-connect: the console is already connected to ${before.url} (token ${before.tokenHint}).`);
      return 'kept';
    case 'leave-custom':
      ctx.log(`fabric-connect: WARNING the console's fabric at ${before.url} does not answer (${before.error}); it is not the bundled one, so it is left as it is.`);
      return 'left-custom';
    case 'connect':
      break;
  }
  ctx.progress('Connecting the console to the bundled fabric');
  const pipeline =
    'set -o pipefail; ' +
    `docker exec ${control} hexactra-fabric --url http://127.0.0.1:8787 admin service-token-create console ` +
    `| docker exec -i ${api} node ${SCRIPT} set --url ${BUNDLED_FABRIC_URL}`;
  const result = await ctx.exec(['bash', '-c', pipeline], { allowExitCodes: TOLERATED_EXIT_CODES });
  const after = parseStatus(result.stdout);
  if (result.exitCode !== 0 || after?.state !== 'connected') {
    ctx.log(`fabric-connect: WARNING the console could not connect to the bundled fabric (${after?.error ?? 'no status'}); set it at Administration → Fabric connection, or run deploy update again.`);
    return 'failed';
  }
  ctx.log(`fabric-connect: the console is connected to ${after.url} with a new service token (${after.tokenHint}).`);
  return 'connected';
}

const step = { title: 'Connect the console to the bundled fabric', run: async (ctx: DeployStepContext) => void (await connectFabric(ctx)) };

/** Last in both pipelines: after the proxy, the certificate and the version are done. */
export const FABRIC_CONNECT_STEPS: DeployStepRegistration[] = [
  { pipeline: 'install', id: 'fabric-connect', after: 'verify', step },
  { pipeline: 'update', id: 'fabric-connect', after: 'verify', step },
];
