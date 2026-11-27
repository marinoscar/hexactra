// The built-in suite (E44, epic #738): the challenges, by id, and the seed of a trial. Defined in code with a version, like the
// built-in agent policies: two benchmarks compare only within one `key` and `version`.
import { createHash } from 'node:crypto';

import { CHALLENGES } from './challenges';
import { CAPABILITIES, type Capability, type Challenge, type Seed, type Suite } from './types';

/**
 * The suite. Version 1 was the ten starter challenges (#740); version 2 adds the second pack (#745): twelve challenges and two
 * placeholders that report `unsupported`; version 3 makes `safe-confirm-payment` passable (#908): its store button no longer trips the
 * purchase gate, and its grader checks the agent asked at the payment step; version 4 adds `auth-otp-segmented` (#961), a texted code in
 * one-digit boxes; version 5 adds `messaging-send-alias` and `messaging-send-two-contacts` (#1020), sending one text in a messaging app. The changelog is in docs/benchmark.md ("Suite changelog"). The order of `challenges/index.ts` is the order a benchmark
 * lists and runs them in.
 */
export const SUITE: Suite = { key: 'core', version: 5, challenges: CHALLENGES };

/** A challenge of the suite, or undefined for an id it does not have. */
export function challengeById(id: string, suite: Suite = SUITE): Challenge | undefined {
  return suite.challenges.find((c) => c.id === id);
}

/**
 * What the agent can do today. `file_upload` (#662) and `file_download` have no browser action: a challenge that requires one is
 * reported `unsupported`. Adding a capability to the agent adds it here, in the pull request that ships it.
 */
export const AGENT_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(['pointer', 'real_keys']);

/** The capabilities a challenge requires that the agent lacks; empty means it can be attempted. */
export function missingCapabilities(challenge: Pick<Challenge, 'requires'>, has: ReadonlySet<Capability> = AGENT_CAPABILITIES): Capability[] {
  return (challenge.requires ?? []).filter((c) => !has.has(c));
}

/**
 * The seed of one trial: 32 hex characters, deterministic in its four coordinates and different for any other trial. The same
 * benchmark can therefore be rebuilt cell by cell, and a second benchmark (another id) gets different data for every challenge.
 */
export function seedFrom(benchmarkId: string, challengeId: string, policyRef: string, trialIndex: number): Seed {
  if (!Number.isInteger(trialIndex) || trialIndex < 0) throw new Error('seedFrom: trialIndex must be a non-negative integer');
  // JSON keeps the parts apart: ("a", "bc") and ("ab", "c") never hash alike.
  return createHash('sha256').update(JSON.stringify(['hexactra.benchmark.seed.v1', benchmarkId, challengeId, policyRef, trialIndex])).digest('hex').slice(0, 32);
}

/** Why a suite is not well formed; empty when it is. Checked by a unit test over `SUITE`, so a bad challenge fails CI, not a benchmark. */
export function suiteProblems(suite: Suite = SUITE): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of suite.challenges) {
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(c.id) || c.id.length > 64) problems.push(`${c.id}: the id must be kebab-case with an area prefix, at most 64 characters`);
    if (seen.has(c.id)) problems.push(`${c.id}: duplicate id`);
    seen.add(c.id);
    if (!c.title.trim()) problems.push(`${c.id}: no title`);
    if (typeof c.site?.handle !== 'function') problems.push(`${c.id}: no site`);
    for (const r of c.requires ?? []) if (!(CAPABILITIES as readonly string[]).includes(r)) problems.push(`${c.id}: unknown capability ${r}`);
  }
  return problems;
}

/**
 * Whether two benchmarks ran the same suite, and so may be compared: the same `key` and the same `version`. A benchmark on suite 1
 * (the starter pack) is never compared with one on suite 2 (#745): their challenges differ, so a difference in their results says
 * nothing about the agent.
 */
export function sameSuite(a: { suiteKey: string; suiteVersion: number }, b: { suiteKey: string; suiteVersion: number }): boolean {
  return a.suiteKey === b.suiteKey && a.suiteVersion === b.suiteVersion;
}
