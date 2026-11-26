// `hexactra agent doctor` shows each profile's Google sign-in status (E48.2,
// #928) from the agent's own `hexactra-agent doctor`: a profile that needs a
// sign-in is a warning, never a failure.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { profileSigninChecks, type AgentDeps } from './agent.js';

function deps(stdout: string, code = 0) {
  const current = mkdtempSync(join(tmpdir(), 'hx-signin-'));
  mkdirSync(join(current, 'bin'));
  writeFileSync(join(current, 'bin', 'hexactra-agent'), '');
  const calls: string[][] = [];
  const d = { paths: { current }, exec: (argv: string[]) => (calls.push(argv), { code, stdout, stderr: '' }) } as unknown as AgentDeps;
  return { d, calls, current };
}

describe('profile sign-in checks', () => {
  it('turns the agent doctor lines into checks, warning on a profile that needs sign-in', () => {
    const { d, calls, current } = deps(
      [
        'profiles in /home/hexactra/profiles',
        'ok   profile default: signed_in (signed in to Google as owner@example.com)',
        'warn profile work: signed_out (signed out of Google: sign in from the Fleet page or the node\'s desktop)',
        'ok   profile new: unknown (sign-in status unknown (the browser has not run yet, or its settings could not be read))',
      ].join('\n'),
    );
    const checks = profileSigninChecks(d, '/home/hexactra/profiles');
    expect(calls).toEqual([[join(current, 'bin', 'hexactra-agent'), 'doctor', '--profiles-dir', '/home/hexactra/profiles']]);
    expect(checks).toEqual([
      { name: 'profile default', ok: true, warning: false, detail: 'signed in to Google as owner@example.com' },
      { name: 'profile work', ok: true, warning: true, detail: "signed out of Google: sign in from the Fleet page or the node's desktop" },
      { name: 'profile new', ok: true, warning: false, detail: 'sign-in status unknown (the browser has not run yet, or its settings could not be read)' },
    ]);
  });

  it('adds nothing when the agent is older or the command fails', () => {
    expect(profileSigninChecks(deps('error: unrecognized subcommand', 2).d, '/p')).toEqual([]);
    const d = { paths: { current: '/nonexistent' }, exec: () => { throw new Error('not called'); } } as unknown as AgentDeps;
    expect(profileSigninChecks(d, '/p')).toEqual([]);
  });

  it("reads an unattended node's private profiles as the node user, without a prompt (#991)", () => {
    const { d, calls, current } = deps('ok   profile default: signed_in (signed in to Google as owner@example.com)');
    const bin = join(current, 'bin', 'hexactra-agent');
    const checks = profileSigninChecks(d, '/nonexistent/hexactra/profiles', { bin, runAs: 'hexactra' });
    expect(calls).toEqual([['sudo', '-n', '-u', 'hexactra', bin, 'doctor', '--profiles-dir', '/nonexistent/hexactra/profiles']]);
    expect(checks).toEqual([{ name: 'profile default', ok: true, warning: false, detail: 'signed in to Google as owner@example.com' }]);
  });

  it('reads them directly when this user can', () => {
    const { d, calls, current } = deps('');
    const bin = join(current, 'bin', 'hexactra-agent');
    profileSigninChecks(d, current, { bin, runAs: 'hexactra' });
    expect(calls).toEqual([[bin, 'doctor', '--profiles-dir', current]]);
  });

  it('says how to read them when sudo needs a password, rather than nothing', () => {
    const { d, current } = deps('', 1);
    const bin = join(current, 'bin', 'hexactra-agent');
    expect(profileSigninChecks(d, '/nonexistent/p', { bin, runAs: 'hexactra' })).toEqual([
      { name: 'profiles', ok: true, warning: true, detail: `sign-in status needs hexactra's access: run \`sudo -u hexactra ${bin} doctor --profiles-dir /nonexistent/p\`` },
    ]);
  });
});
