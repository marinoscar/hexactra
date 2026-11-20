// The deploy's fabric-connect step (issue #309) against a fake docker: it
// mints only when the console is not connected to its bundled fabric, keeps
// the token out of every argv, and leaves an operator's own fabric alone.
import { readFileSync } from 'node:fs';

import { createCli } from '@marinoscar/platform-cli';
import { listRegisteredDeploySteps, type DeployStepContext } from '@marinoscar/platform-cli/deploy';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { BUNDLED_FABRIC_URL, connectFabric, decide, parseStatus } from './fabric-connect.step.js';

const status = (s: object) => `noise\nFABRIC_CONNECT ${JSON.stringify({ url: null, tokenHint: null, error: null, ...s })}\n`;

function fakeContext(answers: { before: string; set?: { exitCode: number; stdout: string }; containers?: boolean }) {
  const calls: string[][] = [];
  const allowed: Array<readonly number[] | undefined> = [];
  const lines: string[] = [];
  const ctx = {
    pipeline: 'install',
    deployRoot: '/opt/infra/apps/hexactra',
    checkoutPath: '/opt/infra/apps/hexactra/repo/console',
    commitSha: undefined,
    log: (l: string) => lines.push(l),
    progress: () => {},
    exec: async (argv: readonly string[], options?: { allowExitCodes?: readonly number[] }) => {
      calls.push([...argv]);
      if (argv[0] === 'docker' && argv[1] === 'exec') allowed.push(options?.allowExitCodes);
      if (argv[0] === 'docker' && argv[1] === 'ps') {
        const service = argv.find((a) => a.startsWith('label=com.docker.compose.service='))!.split('=').pop();
        return { exitCode: 0, stdout: answers.containers === false ? '' : `${service === 'api' ? 'aaaaaa111111' : 'bbbbbb222222'}\n`, stderr: '' };
      }
      if (argv[0] === 'docker' && argv[1] === 'exec') return { exitCode: 0, stdout: answers.before, stderr: '' };
      if (argv[0] === 'bash') return { ...(answers.set ?? { exitCode: 0, stdout: '' }), stderr: '' };
      throw new Error(`unexpected ${argv.join(' ')}`);
    },
  } as unknown as DeployStepContext;
  return { ctx, calls, lines, allowed };
}

describe('fabric-connect deploy step', () => {
  afterAll(() => resetCliForTests());

  it('runs at the end of install and update, after verify', () => {
    resetCliForTests();
    createCli(APP_CLI_OPTIONS);
    for (const pipeline of ['install', 'update'] as const) {
      expect(listRegisteredDeploySteps(pipeline)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'fabric-connect', after: 'verify' })]),
      );
    }
  });

  it('decides from the status', () => {
    expect(decide({ state: 'connected', url: BUNDLED_FABRIC_URL, tokenHint: 'x', error: null })).toBe('keep');
    expect(decide({ state: 'missing', url: null, tokenHint: null, error: null })).toBe('connect');
    expect(decide({ state: 'broken', url: `${BUNDLED_FABRIC_URL}/`, tokenHint: 'x', error: 'refused' })).toBe('connect');
    expect(decide({ state: 'broken', url: 'https://fabric.example.test', tokenHint: 'x', error: 'down' })).toBe('leave-custom');
    expect(parseStatus('no result')).toBeUndefined();
  });

  it('mints and stores a token through a pipe when the console is not connected', async () => {
    const { ctx, calls } = fakeContext({
      before: status({ state: 'missing' }),
      set: { exitCode: 0, stdout: status({ state: 'connected', url: BUNDLED_FABRIC_URL, tokenHint: '••••abcd' }) },
    });
    expect(await connectFabric(ctx)).toBe('connected');
    const pipe = calls.find((c) => c[0] === 'bash')!;
    expect(pipe[2]).toBe(
      'set -o pipefail; docker exec bbbbbb222222 hexactra-fabric --url http://127.0.0.1:8787 admin service-token-create console ' +
        `| docker exec -i aaaaaa111111 node dist/fabric/fabric-connect.cli.js set --url ${BUNDLED_FABRIC_URL}`,
    );
    // The compose directory of THIS deployment selects the containers.
    expect(calls[0]).toContain('label=com.docker.compose.project.working_dir=/opt/infra/apps/hexactra/repo/console/infra/compose');
    expect(calls.flat().some((a) => a.includes('hxs_'))).toBe(false);
  });

  it('does nothing when the console is already connected', async () => {
    const { ctx, calls } = fakeContext({ before: status({ state: 'connected', url: BUNDLED_FABRIC_URL, tokenHint: 't' }) });
    expect(await connectFabric(ctx)).toBe('kept');
    expect(calls.some((c) => c[0] === 'bash')).toBe(false);
  });

  it("leaves an operator's own fabric alone, even when it is down", async () => {
    const { ctx, calls, lines } = fakeContext({ before: status({ state: 'broken', url: 'https://fabric.example.test', error: 'down' }) });
    expect(await connectFabric(ctx)).toBe('left-custom');
    expect(calls.some((c) => c[0] === 'bash')).toBe(false);
    expect(lines.join('\n')).toMatch(/WARNING/);
  });

  it('warns instead of failing the deploy when the connection cannot be made', async () => {
    const { ctx, lines } = fakeContext({ before: status({ state: 'missing' }), set: { exitCode: 1, stdout: status({ state: 'broken', error: 'refused' }) } });
    expect(await connectFabric(ctx)).toBe('failed');
    expect(lines.join('\n')).toMatch(/Administration → Fabric connection/);
  });

  it('skips a stack without the bundled fabric', async () => {
    const { ctx } = fakeContext({ before: '', containers: false });
    expect(await connectFabric(ctx)).toBe('skipped');
  });
  it('treats a status check the kernel killed (exit 137) as a warning, not a failed deploy (#668)', async () => {
    // The script boots a second copy of the app inside the api container's memory limit; out of memory it
    // is killed with SIGKILL and prints nothing. The exec must allow 137, and the step must warn and go on.
    const { ctx, lines, allowed } = fakeContext({ before: '' });
    await expect(connectFabric(ctx)).resolves.toBe('failed');
    expect(allowed[0]).toEqual(expect.arrayContaining([1, 137]));
    expect(lines.join('\n')).toContain('WARNING could not read');
    expect(lines.join('\n')).toContain('docker stats');
  });

  it('allows the killed exit code on the connect pipeline too', async () => {
    const { ctx, lines } = fakeContext({
      before: status({ state: 'missing' }),
      set: { exitCode: 137, stdout: '' },
    });
    await expect(connectFabric(ctx)).resolves.toBe('failed');
    expect(lines.join('\n')).toContain('could not connect to the bundled fabric');
  });

});

describe('the api memory overlay (#668)', () => {
  it('raises the api limit above the generated 512M, as an app-owned overlay the deploy applies', () => {
    const overlay = readFileSync(new URL('../../../infra/compose/app.prod.api-memory.compose.yml', import.meta.url), 'utf8');
    expect(overlay).toMatch(/services:\s*\n\s+api:\s*\n\s+deploy:\s*\n\s+resources:\s*\n\s+limits:\s*\n\s+memory:\s*1G/);
    const generated = readFileSync(new URL('../../../infra/compose/prod.compose.yml', import.meta.url), 'utf8');
    expect(generated).toMatch(/memory:\s*512M/);
  });
});
