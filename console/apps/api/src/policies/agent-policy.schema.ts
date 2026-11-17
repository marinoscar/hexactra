import { z } from 'zod';

/**
 * The agent policy spec (#401): the single source of truth for what a policy
 * holds. The API schemas, the OpenAPI document, the built-in policies, the
 * run snapshot, the JSON export/import (#402), the budget engine (#404) and
 * the web editor (#407) all derive from this file. Every field carries a
 * `.describe()` text that the editor and the MCP tool docs reuse.
 *
 * Pure: no I/O. Whether a model pin names an enabled model is checked in the
 * service (`policy-model-check.ts`), never here.
 */

/** The three fixed model tiers, cheapest first. */
export const TIERS = ['fast', 'standard', 'frontier'] as const;
export type Tier = (typeof TIERS)[number];

const tier = z.enum(TIERS);

/** Position of a tier in the escalation ladder (0 = fast). */
export function tierRank(t: Tier): number {
  return TIERS.indexOf(t);
}

/** An integer limit from 1 to `max`; `null` means unlimited. */
const limit = (max: number, text: string) => z.number().int().min(1).max(max).nullable().describe(`${text} \`null\` means unlimited.`);

export const STALL_ACTIONS = ['nudge_then_escalate', 'escalate', 'ask_human', 'fail'] as const;
export type StallAction = (typeof STALL_ACTIONS)[number];

const pin = (name: string) =>
  z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe(`Model that replaces the ${name} tier for runs under this policy: \`provider:modelId\` or a bare model id. \`null\` or absent uses the tier's own definition.`);

const modelsSchema = z
  .object({
    startTier: tier.describe('The tier a run starts on.'),
    maxTier: tier.describe('The highest tier a run may escalate to when it stalls. Never below `startTier`.'),
    allowProviderFallback: z.boolean().describe("Use the tier's fallback model when the provider errors or rate-limits."),
    pins: z
      .object({
        fast: pin('fast'),
        standard: pin('standard'),
        frontier: pin('frontier'),
      })
      .optional()
      .describe("Optional per-policy model override per tier. Each pin must name an enabled model that supports tools and vision."),
  })
  .describe('Which models a run uses, and how it moves between tiers.');

const budgetSchema = z
  .object({
    maxActions: limit(100_000, 'Most browser actions a run may take.'),
    maxModelCalls: limit(100_000, 'Most model round trips a run may make.'),
    maxActiveMinutes: limit(10_080, 'Most active minutes a run may use (time waiting for a person does not count); 7 days at most when set.'),
    maxInputTokens: limit(1_000_000_000, 'Most input tokens a run may send.'),
    maxOutputTokens: limit(100_000_000, 'Most output tokens a run may receive.'),
    maxCostUsd: z.number().positive().max(100_000).nullable().describe('Most a run may cost in US dollars. `null` means unlimited.'),
    warnAtPercent: z.number().int().min(10).max(95).describe('Warn the owner when any set budget reaches this percentage.'),
  })
  .describe('What a run may spend. Every limit may be unlimited; stall detection stays on regardless.');

const stallSchema = z
  .object({
    maxConsecutiveFailures: z.number().int().min(1).max(50).describe('Failed actions in a row that count as a stall.'),
    maxRepeatedAction: z.number().int().min(2).max(50).describe('The same action repeated this many times counts as a stall.'),
    noProgressActions: z.number().int().min(3).max(200).describe('Actions without visible progress that count as a stall.'),
    onStall: z.enum(STALL_ACTIONS).describe('What to do on a stall: nudge the model then escalate a tier, escalate at once, ask a person, or fail the run.'),
    maxEscalations: z.number().int().min(0).max(10).describe('Most tier escalations per run.'),
  })
  .describe('Stall and loop detection. Always on.');

const contextSchema = z
  .object({
    screenshotsKept: z.number().int().min(0).max(5).describe('Recent screenshots kept in the model context.'),
    pruneBatch: z.number().int().min(1).max(50).describe('How many old tool results are pruned together once the context grows.'),
    callsPerChunk: z.number().int().min(1).max(20).describe('Model calls per chunk; the model tier only changes between chunks.'),
    observationChars: z.number().int().min(500).max(20_000).describe('Most characters of one page observation sent to the model.'),
  })
  .describe('Context efficiency: how much the model sees each round.');

export const agentPolicySpecSchema = z
  .object({
    schemaVersion: z.literal(1).describe('Version of this document format.'),
    models: modelsSchema,
    budget: budgetSchema,
    stall: stallSchema,
    context: contextSchema,
  })
  .superRefine((spec, ctx) => {
    if (tierRank(spec.models.maxTier) < tierRank(spec.models.startTier)) {
      ctx.addIssue({ code: 'custom', path: ['models', 'maxTier'], message: 'maxTier must be the same as or above startTier' });
    }
  })
  .describe('An agent policy: model tiers, budgets, stall detection and context settings.');

export type AgentPolicySpec = z.infer<typeof agentPolicySpecSchema>;

/** The budget keys that cap a run (every one except the warning threshold). */
export const BUDGET_LIMIT_KEYS = ['maxActions', 'maxModelCalls', 'maxActiveMinutes', 'maxInputTokens', 'maxOutputTokens', 'maxCostUsd'] as const;

/** True when no budget limit is set: the run only ends by finishing, a stop or a stall. */
export function hasNoHardStop(spec: AgentPolicySpec): boolean {
  return BUDGET_LIMIT_KEYS.every((k) => spec.budget[k] === null);
}

/** The pin for `tier`, or null. */
export function pinFor(spec: AgentPolicySpec, t: Tier): string | null {
  return spec.models.pins?.[t] ?? null;
}

/** Every pin the spec sets, with its tier. */
export function pinsOf(spec: AgentPolicySpec): { tier: Tier; pin: string }[] {
  return TIERS.flatMap((t) => {
    const p = spec.models.pins?.[t];
    return p ? [{ tier: t, pin: p }] : [];
  });
}
