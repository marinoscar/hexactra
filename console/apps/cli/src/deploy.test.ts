// The deploy's view of this app (issue #294): the wizard generates the
// fabric's secrets without asking, so `deploy install --non-interactive`
// needs no answer for them.
import { createCli } from '@marinoscar/platform-cli';
import { generateValue, resolveEnvMetadata } from '@marinoscar/platform-cli/core';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';

beforeAll(() => {
  resetCliForTests();
  createCli(APP_CLI_OPTIONS);
});
afterAll(() => resetCliForTests());

describe('deploy environment of the fabric keys', () => {
  it('generates the operator token without asking', () => {
    const meta = resolveEnvMetadata('HEXACTRA_FABRIC_OPERATOR_TOKEN');
    expect(meta).toMatchObject({ secret: true, generate: 'hex-32', autoGenerate: true });
  });

  it('generates a viewer password noVNC accepts (at most 8 characters)', () => {
    const meta = resolveEnvMetadata('HEXACTRA_VIEWER_PASSWORD');
    expect(meta).toMatchObject({ secret: true, autoGenerate: true });
    const a = generateValue(meta!.generate!);
    const b = generateValue(meta!.generate!);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(a).not.toBe(b);
  });

  it('lets the fabric OTLP endpoint stay blank', () => {
    expect(resolveEnvMetadata('HEXACTRA_FABRIC_OTLP_ENDPOINT')).toMatchObject({ allowBlank: true });
  });
});

describe('the stack-agent image the VPS deploy runs', () => {
  it('is the platform image of the installed platform version', async () => {
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const overlay = readFileSync(new URL('../../../infra/compose/app.vps.stack-agent-image.compose.yml', import.meta.url), 'utf8');
    const platform = createRequire(import.meta.url)('@marinoscar/platform-cli/package.json') as { version: string };
    expect(overlay).toContain(`image: ghcr.io/marinoscar/enterpriseappbase-stack-agent:${platform.version}\n`);
  });
});

describe('where the deploy finds the app in its checkout', () => {
  it('names the directory of this app inside the repository', async () => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { join } = await import('node:path');
    const appDir = APP_CLI_OPTIONS.deploy?.appDir;
    expect(appDir).toBe('console');
    // The deploy clones the repository and runs compose from <repo>/<appDir>/infra/compose.
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    expect(existsSync(join(repoRoot, appDir!, 'infra', 'compose', 'base.compose.yml'))).toBe(true);
    // The fabric overlay builds from the repository root (context ../../.. of that directory).
    expect(existsSync(join(repoRoot, 'deploy', 'container', 'Dockerfile'))).toBe(true);
  });
});
