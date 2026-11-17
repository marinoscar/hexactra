import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UsableModelsService } from '@marinoscar/platform-api/ai';

import { pinsOf, type AgentPolicySpec, type Tier } from './agent-policy.schema';

/** What a model needs to drive the browser agent: tool calls and screenshots. */
export const PIN_REQUIRED_CAPABILITIES = ['tools', 'vision_input'] as const;

export interface PinProblem {
  tier: Tier;
  pin: string;
  /** `unknown_or_disabled` (not an enabled, reachable model) or `unsupported` (lacks tools or vision). */
  reason: 'unknown_or_disabled' | 'unsupported';
  message: string;
}

export interface ResolvedPin {
  provider: string;
  modelId: string;
}

/**
 * Checks a policy's model pins against the platform's AI catalogue (#401). The
 * ONE place that decides "is this `provider:model` usable for the browser
 * agent": the policy service calls `check` on every write, and the model tier
 * resolver (#403) calls `resolvePin` / `listUsable` for the same rule.
 *
 * A pin is `provider:modelId` or a bare model id. It is accepted when the user
 * can call that model right now (`UsableModelsService`: enabled by an
 * administrator, on an enabled provider, reachable with a key) and the model
 * has the `tools` and `vision_input` capabilities. When the AI slice is not
 * mounted there is no catalogue to check and only the format is validated.
 */
@Injectable()
export class PolicyModelCheck {
  private readonly log = new Logger(PolicyModelCheck.name);

  constructor(@Optional() private readonly modules?: ModuleRef) {}

  private usable(): UsableModelsService | null {
    try {
      return this.modules?.get(UsableModelsService, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

  /** Models the user can call right now, with their capabilities; null when the AI slice is absent. */
  async listUsable(userId: string): Promise<{ provider: string; modelId: string; capabilities: string[] }[] | null> {
    const svc = this.usable();
    if (!svc) return null;
    const models = await svc.listForUser(userId);
    return models.map((m) => ({ provider: m.provider, modelId: m.modelId, capabilities: m.capabilities.capabilities }));
  }

  /** The (provider, model) a pin names among the usable models, or null. */
  async resolvePin(userId: string, pin: string): Promise<ResolvedPin | null> {
    const models = await this.listUsable(userId);
    return models ? matchPin(models, pin) : null;
  }

  /** Every pin of `spec` that is not a usable model with the capabilities the browser agent needs. */
  async check(userId: string, spec: AgentPolicySpec): Promise<PinProblem[]> {
    const pins = pinsOf(spec);
    if (pins.length === 0) return [];
    let models: Awaited<ReturnType<PolicyModelCheck['listUsable']>>;
    try {
      models = await this.listUsable(userId);
    } catch (e) {
      // The catalogue could not be read: do not block saving a policy on it.
      this.log.warn(`could not read the AI catalogue to check model pins: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
    if (!models) return [];
    const problems: PinProblem[] = [];
    for (const { tier, pin } of pins) {
      const found = models.filter((m) => `${m.provider}:${m.modelId}` === pin || m.modelId === pin);
      if (found.length === 0) {
        problems.push({ tier, pin, reason: 'unknown_or_disabled', message: `"${pin}" is not an enabled model you can use` });
      } else if (!found.some((m) => PIN_REQUIRED_CAPABILITIES.every((c) => m.capabilities.includes(c)))) {
        problems.push({ tier, pin, reason: 'unsupported', message: `"${pin}" does not support tools and vision, which the browser agent needs` });
      }
    }
    return problems;
  }
}

/** Pure: the usable model a pin names (an exact `provider:model` first, then a bare model id). */
export function matchPin<M extends { provider: string; modelId: string }>(models: readonly M[], pin: string): M | null {
  return models.find((m) => `${m.provider}:${m.modelId}` === pin) ?? models.find((m) => m.modelId === pin) ?? null;
}
