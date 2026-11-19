// The deploy's view of this app (issue #294): the wizard generates the
// fabric's secrets without asking, so `deploy install --non-interactive`
// needs no answer for them.
import { readFileSync } from 'node:fs';
import { createCli } from '@marinoscar/platform-cli';
import { generateValue, resolveEnvMetadata } from '@marinoscar/platform-cli/core';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS, bundledHostProfile } from './app.js';

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

  it('runs the bundled host only where it already exists (#343)', () => {
    const meta = resolveEnvMetadata('COMPOSE_PROFILES');
    expect(meta).toMatchObject({ autoGenerate: true, generate: 'bundled-host-profile' });
    expect(['bundled-host', 'none']).toContain(generateValue(meta!.generate!));
    expect(bundledHostProfile(() => 'hexactra_db-data\nhexactra_fabric-host-data\n')).toBe('bundled-host');
    expect(bundledHostProfile(() => 'hexactra_db-data\nhexactra_fabric-control-data\n')).toBe('none');
    // Docker cannot be asked: keep what an older deployment ran.
    expect(bundledHostProfile(() => null)).toBe('bundled-host');
  });

  it('lets the fabric OTLP endpoint stay blank', () => {
    expect(resolveEnvMetadata('HEXACTRA_FABRIC_OTLP_ENDPOINT')).toMatchObject({ allowBlank: true });
  });
});

describe('the built-in secrets store keys (E37.5)', () => {
  it('the switch and the callback address may stay blank (the store is off by default)', () => {
    for (const name of ['SECRETS_STORE_ENABLED', 'SECRETS_STORE_CALLBACK_URL']) expect(resolveEnvMetadata(name)).toMatchObject({ allowBlank: true });
  });

  it('neither key is a variable of the template: a declared secret is asked for, and the key matters only when the store is on', () => {
    const template = readFileSync(new URL('../../../infra/compose/.env.example', import.meta.url), 'utf8');
    expect(template).toMatch(/^SECRETS_STORE_ENABLED=/m);
    expect(template).not.toMatch(/^SECRETS_STORE_KEY(_PREVIOUS)?=/m);
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

describe('the template the install screen reads its questions from', () => {
  // The TUI install screen (platform-cli before 0.1.0-next.33) read its questions
  // from <deployRoot>/repo/infra/compose/.env.example and ignores deploy.appDir.
  // Without this root symlink it found no template, asked nothing, and the
  // run failed with "Cannot run without a terminal: 10 value(s) are missing".
  it('is reachable at the repository root and is this app\'s template', async () => {
    const { lstatSync, readFileSync, realpathSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { join } = await import('node:path');
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const atRoot = join(repoRoot, 'infra', 'compose', '.env.example');
    const appTemplate = join(repoRoot, APP_CLI_OPTIONS.deploy!.appDir!, 'infra', 'compose', '.env.example');
    // A relative symlink, so it still resolves inside a deployment's clone.
    expect(lstatSync(atRoot).isSymbolicLink()).toBe(true);
    expect(realpathSync(atRoot)).toBe(realpathSync(appTemplate));
    const template = readFileSync(atRoot, 'utf8');
    for (const key of ['POSTGRES_HOST', 'POSTGRES_PASSWORD', 'JWT_SECRET', 'GOOGLE_CLIENT_ID', 'INITIAL_ADMIN_EMAIL']) {
      expect(template).toMatch(new RegExp(`^${key}=`, 'm'));
    }
  });
});
