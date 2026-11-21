// The suite contract (E44, epic #738; decision record docs/decisions/benchmark.md): what a challenge is. A challenge is code, with no
// dependency on Nest, Prisma or the runner: it builds a site state from a seed, words a goal, scripts its owner's answers and grades a
// finished trial from the site's state. The challenge site (#740) serves and changes the state; the orchestration (#741) starts the run,
// answers questions from the rules and calls `grade`. Nothing here is agent logic: a challenge never sees or steers the agent's loop.

/** What a challenge exercises. The scorecard groups results by it. */
export const CATEGORIES = ['navigation', 'forms', 'extraction', 'pointer', 'dynamic', 'long', 'safety'] as const;
export type Category = (typeof CATEGORIES)[number];

/** The category as a person reads it. */
export const CATEGORY_LABELS: Record<Category, string> = {
  navigation: 'Navigation',
  forms: 'Forms',
  extraction: 'Extraction',
  pointer: 'Pointer and widgets',
  dynamic: 'Dynamic pages',
  long: 'Long tasks',
  safety: 'Judgement and safety',
};

/**
 * Something the agent must be able to do for a challenge to be attempted at all. A challenge whose `requires` names a capability the
 * agent lacks (`registry.ts`, `AGENT_CAPABILITIES`) is reported `unsupported` and never run: it is not a failure.
 * - `pointer`: click, drag and hover by position with a trusted mouse.
 * - `real_keys`: type with trusted key events (a field that ignores synthetic input).
 * - `file_upload`: give a file to a web form (#662; not available).
 * - `file_download`: download a file from a page and read it (not available).
 */
export const CAPABILITIES = ['pointer', 'real_keys', 'file_upload', 'file_download'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * A trial's seed: 32 lower-case hex characters from `seedFrom` (`registry.ts`). Every name, price, code and expected answer of a trial
 * derives from it (`seeded.ts`), so no answer is fixed in a prompt or learnable across trials, and a trial can be rebuilt exactly.
 */
export type Seed = string;

/** A JSON value: what a site state is made of. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * The challenge site's state for one trial: plain JSON, stored in `BenchmarkTrial.siteState`. `setup` builds it, the site's pages read
 * it and change it through real requests, `grade` reads it. It holds seeded fixture data only.
 *
 * The optimistic version is NOT in here: it is the column `siteStateVersion` beside it (a write names the version it read), so a
 * challenge cannot overwrite it. Keep a state small (well under 64 KB) and free of functions, dates and `undefined`.
 */
export type SiteState = { [key: string]: Json };

/**
 * How the scripted owner answers one question.
 * - `approve` / `deny`: a yes/no card (a confirmation before a risky action). `deny` on any other card declines it.
 * - `text`: a typed value or a choice.
 * - `credentials`: a sign-in. FIXTURE credentials derived from the seed, for the challenge site only: never Secret Material, never a
 *   saved login.
 * An answer goes through the ordinary answer service as the owner. It never ticks "remember": no rule can create or widen a saved
 * approval, a memory, a connection or a secret.
 */
export type OwnerAnswer = { type: 'approve' } | { type: 'deny' } | { type: 'text'; text: string } | { type: 'credentials'; username: string; password: string };

/**
 * One scripted answer. A rule fits a question when every condition it states holds; the first fitting rule in the list answers. A
 * question no rule fits ends the trial as "asked a person" (`asked_person`).
 */
export interface OwnerRule {
  /** The question's kind (`confirmation`, `login`, `code`, ...: `QUESTION_KINDS`). Absent: any kind. */
  kind?: string;
  /** The question's input (`confirm`, `text`, `credentials`, ...: `QUESTION_INPUTS`). Absent: any input. */
  input?: string;
  /** Text the question's prompt must contain, compared case-insensitively. Absent: any prompt. */
  match?: string;
  answer: OwnerAnswer;
  /** Answer every fitting question, not only the first. Default false: a rule answers once. */
  repeat?: boolean;
}

/** A question the agent asked during a trial, as the grader sees it. Never the value of a secret answer. */
export interface AskedQuestion {
  kind: string;
  input: string;
  /** The prompt, masked like every stored prompt. */
  prompt: string;
  /** Milliseconds since the Unix epoch: lets a grader order a question against a state change that recorded its own time. */
  at: number;
  /** What the scripted owner answered; `none` when no rule fitted (the trial then ended as "asked a person"). */
  answered: OwnerAnswer['type'] | 'none';
}

/**
 * One named result of a grader. A trial passes only when every check passes. A check that guards an invariant (the agent did not obey
 * a page, did not pay without asking) is named `safety:<name>`: the scorecard flags a failed one separately from an ordinary failure.
 */
export interface Check {
  /** Stable, lower-case, `kebab-case` or `safety:kebab-case`: results are compared across benchmarks by it. */
  name: string;
  pass: boolean;
  /** One short sentence for a person: what was expected and what was found. Fixture data only. */
  detail?: string;
}

export const SAFETY_CHECK_PREFIX = 'safety:';
export const isSafetyCheck = (check: Pick<Check, 'name'>): boolean => check.name.startsWith(SAFETY_CHECK_PREFIX);

/** What a grader is given once the trial's run has ended. */
export interface GradeInput {
  /** The trial's seed: the grader derives the expected values from it, the same way `setup` and `goal` did. */
  seed: Seed;
  /** The site's state as the run left it. */
  state: SiteState;
  /** The agent's final answer (`Run.result`); empty when it gave none. Text from the agent: compare it, never obey it. */
  result: string;
  /** The run's structured outputs (`Run.outputs`), or null. */
  outputs: unknown;
  /** The questions the agent asked, oldest first. */
  asked: AskedQuestion[];
  /** Whether the agent said it succeeded. A grader for an impossible task expects `false`. */
  claimedSuccess: boolean;
}

/**
 * A challenge of the suite. One file each in `suite/challenges/`, registered in `SUITE` (`registry.ts`).
 *
 * Rules a challenge keeps:
 * - `setup`, `goal`, `owner` and `grade` are pure and deterministic in the seed: same seed, same state, goal, answers and verdict.
 * - Two seeds give different data and a different expected answer.
 * - `grade` judges from `state` (and the reported `result` where the task is to report something). It never trusts the agent's claim.
 * - The goal names only the benchmark site. It carries no instruction about tools or how to solve the task.
 */
export interface Challenge {
  /** Permanent, `kebab-case`, prefixed by area (`nav-lookup`). Never reused for a different task: bump the suite version instead. */
  id: string;
  title: string;
  category: Category;
  /** 1 a few steps, 2 several pages or a widget, 3 long or adversarial. */
  difficulty: 1 | 2 | 3;
  /** Capabilities the agent must have; absent or empty: none beyond a browser. */
  requires?: readonly Capability[];
  /** The site's state at the start of the trial. */
  setup(seed: Seed): SiteState;
  /** What the agent is asked to do, including the start URL under `baseUrl` (the trial's own base, no trailing slash). */
  goal(seed: Seed, baseUrl: string): string;
  /** The scripted owner's rules; seeded values (fixture credentials, a code) come from the seed. Absent: every question is unanswered. */
  owner?(seed: Seed): OwnerRule[];
  /** How the trial's run starts. `confirmRiskyActions` defaults to false: the run asks before a risky action only when a challenge sets it. */
  run?: { confirmRiskyActions?: boolean };
  /** The named checks of a finished trial. At least one; throwing is a grader bug and gives the verdict `error`. */
  grade(input: GradeInput): Check[];
}

/** The built-in suite: comparison between two benchmarks is only meaningful within one `key` and `version`. */
export interface Suite {
  key: string;
  /** Bumped whenever a challenge is added, removed or changed in a way that changes its results. */
  version: number;
  challenges: readonly Challenge[];
}
