// The editor's helper texts and limits: the SAME `.describe()` strings and
// bounds as the API's policy spec (`apps/api/src/policies/agent-policy.schema.ts`).
// `__tests__/policies/help.test.ts` compares every entry with the OpenAPI
// document (`packages/sdk/openapi.json`), so the two never drift: when the API
// changes a text, that test names the entry to update here.
import type { BudgetLimitKey } from './types';

export interface FieldHelp {
  /** The `.describe()` text, as the API documents it. */
  text: string;
  min: number;
  max: number;
}

export const SECTION_HELP = {
  models: 'Which models a run uses, and how it moves between tiers.',
  budget: 'What a run may spend. Every limit may be unlimited; stall detection stays on regardless. Chat runs show these limits but are not stopped by them.',
  stall: 'Stall and loop detection. Always on.',
  context: 'Context efficiency: how much the model sees each round.',
} as const;

export const MODELS_HELP = {
  startTier: 'The tier a run starts on.',
  maxTier: 'The highest tier a run may escalate to when it stalls. Never below `startTier`.',
  allowProviderFallback: "Use the tier's fallback model when the provider errors or rate-limits.",
  pins: 'Optional per-policy model override per tier. Each pin must name an enabled model that supports tools and vision.',
} as const;

export const BUDGET_HELP: Record<BudgetLimitKey | 'warnAtPercent', FieldHelp> = {
  maxActions: { text: 'Most browser actions a run may take. `null` means unlimited.', min: 1, max: 100_000 },
  maxModelCalls: { text: 'Most model round trips a run may make. `null` means unlimited.', min: 1, max: 100_000 },
  maxActiveMinutes: {
    text: 'Most active minutes a run may use (time waiting for a person does not count); 7 days at most when set. `null` means unlimited.',
    min: 1,
    max: 10_080,
  },
  maxInputTokens: { text: 'Most input tokens a run may send. `null` means unlimited.', min: 1, max: 1_000_000_000 },
  maxOutputTokens: { text: 'Most output tokens a run may receive. `null` means unlimited.', min: 1, max: 100_000_000 },
  // Exclusive minimum 0 in the API (`positive()`): the smallest the editor offers is a cent.
  maxCostUsd: { text: 'Most a run may cost in US dollars. `null` means unlimited.', min: 0.01, max: 100_000 },
  warnAtPercent: { text: 'Warn the owner when any set budget reaches this percentage.', min: 10, max: 95 },
};

export const STALL_HELP = {
  maxConsecutiveFailures: { text: 'Failed actions in a row that count as a stall.', min: 1, max: 50 },
  maxRepeatedAction: { text: 'The same action repeated this many times counts as a stall.', min: 2, max: 50 },
  noProgressActions: { text: 'Actions without visible progress that count as a stall.', min: 3, max: 200 },
  maxEscalations: { text: 'Most tier escalations per run.', min: 0, max: 10 },
  onStall: 'What to do on a stall: nudge the model then escalate a tier, escalate at once, ask a person, or fail the run.',
} as const;

export const CONTEXT_HELP = {
  screenshotsKept: { text: 'Recent screenshots kept in the model context.', min: 0, max: 5 },
  pruneBatch: { text: 'How many old tool results are pruned together once the context grows.', min: 1, max: 50 },
  callsPerChunk: { text: 'Model calls per chunk; the model tier only changes between chunks.', min: 1, max: 20 },
  observationChars: { text: 'Most characters of one page observation sent to the model.', min: 500, max: 20_000 },
} as const;

/** An API description as plain text: code spans lose their backticks. */
export function plain(text: string): string {
  return text.replace(/`([^`]*)`/g, '$1');
}

/**
 * A budget limit's API description for the editor: the "`null` means unlimited"
 * sentence is the editor's "No limit" switch, so it is left out there.
 */
export function budgetHelp(key: BudgetLimitKey): string {
  return plain(BUDGET_HELP[key].text.replace(/\s*`null` means unlimited\.$/, ''));
}
