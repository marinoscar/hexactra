import { Global, Injectable, Logger, Module, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UsableModelsService } from '@marinoscar/platform-api/ai';

import { PrismaService } from '../prisma/prisma.service';
import { aiHelpersSettingsOf, type AiHelpersSettings } from './ai-helpers.settings';

/** What a helper asks a model for: `title` (run and chat titles) or `task` (create and improve tasks). */
export type HelperKind = 'title' | 'task';

/** What is spread into an AI request: both the provider and the model, or nothing (the owner's default model). */
export type HelperTarget = { provider: string; model: string } | Record<string, never>;

/**
 * The model the owner picked for a helper (E55.1, #1094).
 *
 * A pick is `provider:modelId`. It is used only while the owner can call that
 * model right now (`UsableModelsService`); otherwise, and when nothing is
 * picked or the AI slice is absent, the answer is `{}` and the request goes to
 * the owner's default model exactly as before. It never throws: a helper must
 * not fail because of this setting.
 *
 * The provider is always sent with the model: for a feature other than the
 * browser agent, the platform's target resolver does not look up which
 * provider serves a model.
 */
@Injectable()
export class HelperModels {
  private readonly log = new Logger(HelperModels.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly modules?: ModuleRef,
  ) {}

  /** The owner's helper settings, with defaults. */
  async settings(userId: string): Promise<AiHelpersSettings> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    return aiHelpersSettingsOf(row?.value);
  }

  async target(userId: string, kind: HelperKind): Promise<HelperTarget> {
    try {
      const settings = await this.settings(userId);
      const pick = kind === 'title' ? settings.titleModel : settings.taskModel;
      if (!pick) return {};
      let usable: UsableModelsService | null = null;
      try {
        usable = this.modules?.get(UsableModelsService, { strict: false }) ?? null;
      } catch {
        usable = null;
      }
      if (!usable) return {};
      const found = (await usable.listForUser(userId)).find((m) => `${m.provider}:${m.modelId}` === pick);
      if (!found) {
        this.log.warn(`helper model (${kind}): the picked model can no longer be used; the default model is used`);
        return {};
      }
      return { provider: found.provider, model: found.modelId };
    } catch (e) {
      this.log.warn(`helper model (${kind}): could not read the pick, the default model is used: ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  }
}

/** Global: the helpers that use it (chat, task builder, task improver, titles) are in several modules. */
@Global()
@Module({ providers: [HelperModels], exports: [HelperModels] })
export class AiHelpersModule {}
