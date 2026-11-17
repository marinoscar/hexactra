// =============================================================================
// The AI target resolver: which (provider, model) a call goes to
// =============================================================================
//
// Bound to the platform's `AI_TARGET_RESOLVER` port in `AiHostModule`.
//
//  - `browser_agent` (the goal runner): the runner always names the tier's model
//    (agent policies, #403), so this validates and returns it. A call that names
//    none (a snapshot that predates the tiers) falls to the user's default model
//    like any feature; when there is none the error names the Model tiers page.
//  - Every other feature (`notes-summary`, ...): exactly the platform's default
//    order, so other features are unchanged.
//
// The platform's `DefaultAiTargetResolver` is exported, but it needs the
// provider registry, which is not, so it cannot be built here. Its documented
// behaviour is reproduced instead: the request's model, else the user's
// `ai.defaultModel`, else the sole registered provider (SEAM REQUEST: export
// `AiProviderRegistry`, or let a resolver wrap the default one).
// =============================================================================

import { Inject, Injectable, Optional } from '@nestjs/common';
import { AI_MODULE_OPTIONS, AiError, UsableModelsService, type AiTarget, type AiTargetContext, type AiTargetResolver } from '@marinoscar/platform-api/ai';
import { ModuleRef } from '@nestjs/core';

import { PrismaService } from '../../prisma/prisma.service';
import { MODEL_TIERS_PAGE } from '../../policies/model-tiers';
import { matchPin } from '../../policies/policy-model-check';
import { BROWSER_AGENT_FEATURE_ID } from '../../runner/browser-agent.feature';

@Injectable()
export class BrowserAgentTargetResolver implements AiTargetResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly modules: ModuleRef,
    @Optional() @Inject(AI_MODULE_OPTIONS) private readonly options?: { perUserDefaultModel?: boolean },
  ) {}

  async resolve(ctx: AiTargetContext): Promise<AiTarget | null> {
    const requested = ctx.requested.model?.trim();
    if (ctx.feature === BROWSER_AGENT_FEATURE_ID && requested) {
      const provider = ctx.requested.provider ?? (await this.providerOf(ctx, requested)) ?? (await this.defaultModel(ctx.userId))?.provider ?? (await this.soleProvider(ctx));
      if (!provider) throw new AiError('AI_INVALID_REQUEST', 'No provider selected.', { details: { model: requested } });
      return { provider, model: requested };
    }
    const target = await this.platformDefault(ctx);
    if (!target && ctx.feature === BROWSER_AGENT_FEATURE_ID) {
      throw new AiError('AI_INVALID_REQUEST', `No model selected. Set one on the ${MODEL_TIERS_PAGE}.`, { details: { feature: ctx.feature } });
    }
    return target;
  }

  /** The platform's default order (`DefaultAiTargetResolver`). */
  private async platformDefault(ctx: AiTargetContext): Promise<AiTarget | null> {
    const requested = ctx.requested.model?.trim();
    if (requested) {
      const provider = ctx.requested.provider ?? (await this.defaultModel(ctx.userId))?.provider ?? (await this.soleProvider(ctx));
      if (!provider) throw new AiError('AI_INVALID_REQUEST', 'No provider selected.', { details: { model: requested } });
      return { provider, model: requested };
    }
    const fallback = await this.defaultModel(ctx.userId);
    if (!fallback || (ctx.requested.provider !== undefined && ctx.requested.provider !== fallback.provider)) return null;
    return { provider: fallback.provider, model: fallback.modelId };
  }

  private async defaultModel(userId: string | null): Promise<{ provider: string; modelId: string } | null> {
    if (this.options?.perUserDefaultModel === false || userId === null) return null;
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    const d = (row?.value as { ai?: { defaultModel?: { provider?: unknown; modelId?: unknown } | null } } | null | undefined)?.ai?.defaultModel;
    return d && typeof d.provider === 'string' && typeof d.modelId === 'string' ? { provider: d.provider, modelId: d.modelId } : null;
  }

  private usable(): UsableModelsService | null {
    try {
      return this.modules.get(UsableModelsService, { strict: false });
    } catch {
      return null;
    }
  }

  /** The provider that serves a bare model id, when exactly one usable provider does. */
  private async providerOf(ctx: AiTargetContext, model: string): Promise<string | null> {
    if (ctx.userId === null) return null;
    const models = (await this.usable()?.listForUser(ctx.userId)) ?? [];
    const hits = models.filter((m) => m.modelId === model);
    return hits.length === 1 ? hits[0]!.provider : (matchPin(models, model)?.provider ?? null);
  }

  /** The only provider the user can use, standing in for the registry's "sole provider". */
  private async soleProvider(ctx: AiTargetContext): Promise<string | undefined> {
    const svc = this.usable();
    if (!svc) return undefined;
    const models = ctx.userId === null ? await svc.listForSystem() : await svc.listForUser(ctx.userId);
    const ids = [...new Set(models.map((m) => m.provider))];
    return ids.length === 1 ? ids[0] : undefined;
  }
}
