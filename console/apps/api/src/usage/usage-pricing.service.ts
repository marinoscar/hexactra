import { Injectable, Logger, Optional } from '@nestjs/common';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import type { PriceTable } from '../runner/cost';
import { priceTableOf } from '../runner/agent-pricing.settings';

/** The price table a usage report uses, and whether the user's own overrides changed it. */
export interface EffectivePrices {
  table: PriceTable;
  /** True when the caller's own model prices replaced at least one of the deployment's. */
  overridesApplied: boolean;
}

/**
 * The prices of a usage report (#733): the deployment's `agentPricing` table.
 * A user's own overrides (#735) apply to their own report only (`forUser`),
 * never to the deployment-wide one (`deployment`).
 */
@Injectable()
export class UsagePricingService {
  private readonly log = new Logger(UsagePricingService.name);

  constructor(@Optional() private readonly settings?: SystemSettingsService) {}

  /** The deployment's table. Unreadable settings give an empty table (every model unpriced), never an error. */
  async deployment(): Promise<PriceTable> {
    try {
      return priceTableOf(await this.settings?.getNamespace('agentPricing'));
    } catch (e) {
      this.log.warn(`could not read the model price table: ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  }

  /** The table for `userId`'s own report. */
  async forUser(_userId: string): Promise<EffectivePrices> {
    return { table: await this.deployment(), overridesApplied: false };
  }
}
