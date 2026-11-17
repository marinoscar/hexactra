import { Injectable } from '@nestjs/common';
import type { AiCost, AiPricing, AiPricingUsage } from '@marinoscar/platform-api/ai';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { priceTableOf } from '../../runner/agent-pricing.settings';
import { priceCall } from '../../runner/cost';

/**
 * The `AI_PRICING` port, bound through `AiModule.forRoot({ pricing })`: the
 * platform's usage report prices its slices with the admin's `agentPricing`
 * table, the same table that prices a run. A model that is not listed has no
 * cost (`null`: unknown, never 0). Non-token units (images, audio seconds)
 * have no price in the table, so a slice that used them is unpriced too.
 */
@Injectable()
export class ConsoleAiPricing implements AiPricing {
  constructor(private readonly settings: SystemSettingsService) {}

  async costFor(usage: AiPricingUsage): Promise<AiCost | null> {
    if (Object.values(usage.units).some((n) => n > 0)) return null;
    const prices = priceTableOf(await this.settings.getNamespace('agentPricing'));
    const amount = priceCall(usage.provider, usage.modelId, usage, prices);
    return amount === null ? null : { amount, currency: 'USD' };
  }
}
