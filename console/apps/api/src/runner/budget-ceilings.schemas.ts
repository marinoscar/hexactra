import { z } from 'zod';

const ceiling = (max: number, text: string) =>
  z.number().int().min(1).max(max).nullable().describe(`${text} \`null\` sets no ceiling.`);

/**
 * The `browserAgentCeilings` system settings namespace (#404): the most any
 * agent policy may allow a run, set by the deployment's admin. Same keys as a
 * policy's `budget`; every one is nullable and the default is all `null` (no
 * ceilings). A run's effective limit is `min(policy, ceiling)`; a policy that
 * is unlimited is held to the ceiling.
 */
export const browserAgentCeilingsSchema = z.object({
  maxActions: ceiling(100_000, 'Most browser actions a run may take.'),
  maxModelCalls: ceiling(100_000, 'Most model round trips a run may make.'),
  maxActiveMinutes: ceiling(10_080, 'Most active minutes a run may use.'),
  maxInputTokens: ceiling(1_000_000_000, 'Most input tokens a run may send.'),
  maxOutputTokens: ceiling(100_000_000, 'Most output tokens a run may receive.'),
  maxCostUsd: z.number().positive().max(100_000).nullable().describe('Most a run may cost in US dollars. `null` sets no ceiling.'),
});
export type BrowserAgentCeilings = z.infer<typeof browserAgentCeilingsSchema>;

/** A PATCH changes the ceilings it names; `null` clears one. */
export const browserAgentCeilingsPatchSchema = browserAgentCeilingsSchema.partial();

export const NO_CEILINGS: BrowserAgentCeilings = {
  maxActions: null,
  maxModelCalls: null,
  maxActiveMinutes: null,
  maxInputTokens: null,
  maxOutputTokens: null,
  maxCostUsd: null,
};
