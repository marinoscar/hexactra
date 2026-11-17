import { Injectable, Logger, Optional } from '@nestjs/common';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../prisma/prisma.service';
import { SYSTEM_DEFAULT_POLICY_REF } from './builtin-policies';
import type { AgentPolicySpec, Tier } from './agent-policy.schema';
import { TIERS } from './agent-policy.schema';
import { modelTiersOverrideSchema, modelTiersSchema, type ModelTiers, type ModelTiersOverride, type ResolvedTier, type ResolvedTiers } from './model-tiers.schema';
import { noModelMessage, selectTiers, type TierSelection } from './model-tiers';
import { PoliciesService } from './policies.service';
import { PolicyModelCheck, matchPin } from './policy-model-check';

type Catalogue = { provider: string; modelId: string; capabilities: string[] }[] | null;

/** What the effective-tiers endpoint returns. */
export interface EffectiveTiers {
  policy: { id: string; name: string; startTier: Tier; maxTier: Tier };
  tiers: ResolvedTiers;
}

/**
 * Resolves a policy's three model tiers for a user (#403), once, at the start of
 * a run (the runner writes the result to `runs.policy_snapshot.resolvedTiers`),
 * and for the effective-tiers API and the UI.
 *
 * Model precedence per tier: the policy's pin, the user's tier, the deployment's
 * tier, fill-down from another tier, then the user's platform default model
 * (`ai.defaultModel`); see `selectTiers`. Validation reuses `PolicyModelCheck`:
 * a model must be one the user can call right now and must support tool calls;
 * a model without image input is allowed and flagged `vision: false`.
 */
@Injectable()
export class ModelTiersService {
  private readonly log = new Logger(ModelTiersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly check: PolicyModelCheck,
    private readonly policies: PoliciesService,
    @Optional() private readonly systemSettings?: SystemSettingsService,
  ) {}

  /** The deployment default; every tier unset when nothing is stored or it cannot be read. */
  async deployment(): Promise<ModelTiers | null> {
    try {
      const v = await this.systemSettings?.getNamespace('browserAgentTiers');
      const parsed = modelTiersSchema.safeParse(v);
      return parsed.success ? parsed.data : null;
    } catch (e) {
      this.log.warn(`could not read the deployment model tiers: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** The user's own tiers and platform default model, read raw so no settings row is created. */
  private async userLayer(userId: string): Promise<{ user: ModelTiersOverride | null; aiDefault: string | null }> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    const value = (row?.value ?? null) as { browserAgent?: { tiers?: unknown }; ai?: { defaultModel?: { provider?: unknown; modelId?: unknown } | null } } | null;
    const tiers = modelTiersOverrideSchema.safeParse(value?.browserAgent?.tiers ?? undefined);
    const d = value?.ai?.defaultModel;
    const aiDefault = d && typeof d.provider === 'string' && typeof d.modelId === 'string' ? `${d.provider}:${d.modelId}` : null;
    return { user: tiers.success ? (tiers.data ?? null) : null, aiDefault };
  }

  private async catalogue(userId: string): Promise<Catalogue> {
    try {
      return await this.check.listUsable(userId);
    } catch (e) {
      this.log.warn(`could not read the AI catalogue for the model tiers: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Resolve the three tiers of `spec` for `userId`. Pure apart from reads. */
  async resolve(userId: string, spec: AgentPolicySpec): Promise<ResolvedTiers> {
    const [deployment, layer, catalogue] = await Promise.all([this.deployment(), this.userLayer(userId), this.catalogue(userId)]);
    const picked = selectTiers({ pins: spec.models.pins, user: layer.user, deployment, aiDefault: layer.aiDefault });
    return Object.fromEntries(TIERS.map((t) => [t, place(picked[t], catalogue)])) as ResolvedTiers;
  }

  /** The tiers a new run of the user's default policy (or `policyRef`) would use now. */
  async effective(userId: string, policyRef?: string): Promise<EffectiveTiers> {
    const ref = policyRef ?? (await this.policies.getDefault(userId)).policyId;
    const policy = (await this.policies.find(userId, ref)) ?? (await this.policies.require(userId, SYSTEM_DEFAULT_POLICY_REF));
    return {
      policy: { id: policy.id, name: policy.name, startTier: policy.spec.models.startTier, maxTier: policy.spec.models.maxTier },
      tiers: await this.resolve(userId, policy.spec),
    };
  }
}

/** Pure: place a selection's models in the catalogue and judge them. */
export function place(sel: TierSelection, catalogue: Catalogue): ResolvedTier {
  const base = {
    modelSource: sel.modelSource,
    borrowedFrom: sel.borrowedFrom,
    reasoningEffort: sel.reasoningEffort,
    effortSource: sel.effortSource,
    maxOutputTokens: sel.maxOutputTokens,
    maxOutputTokensSource: sel.maxOutputTokensSource,
    fallbackSource: sel.fallbackSource,
  };
  const fb = sel.fallbackModel && catalogue ? matchPin(catalogue, sel.fallbackModel) : null;
  const fallback = { fallbackModel: fb ? `${fb.provider}:${fb.modelId}` : sel.fallbackModel, fallbackProvider: fb?.provider ?? null };
  if (!sel.model) return { ...base, ...fallback, model: null, provider: null, modelId: null, vision: null, tools: null, reasoning: null, usable: false, problem: noModelMessage(sel.tier) };
  if (!catalogue) return { ...base, ...fallback, model: sel.model, provider: null, modelId: null, vision: null, tools: null, reasoning: null, usable: true, problem: null };
  const found = matchPin(catalogue, sel.model);
  if (!found) {
    return { ...base, ...fallback, model: sel.model, provider: null, modelId: null, vision: null, tools: null, reasoning: null, usable: false, problem: `"${sel.model}" (${sel.tier} tier) is not an enabled model you can use. Pick another on the Model tiers page.` };
  }
  const tools = found.capabilities.includes('tools');
  const vision = found.capabilities.includes('vision_input');
  return {
    ...base,
    ...fallback,
    model: `${found.provider}:${found.modelId}`,
    provider: found.provider,
    modelId: found.modelId,
    vision,
    tools,
    reasoning: found.capabilities.includes('reasoning'),
    usable: tools,
    problem: tools ? null : `"${found.provider}:${found.modelId}" (${sel.tier} tier) does not support tool calls, which the browser agent needs. Pick another on the Model tiers page.`,
  };
}
