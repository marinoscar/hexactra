import { Injectable, Logger, Optional } from '@nestjs/common';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../prisma/prisma.service';
import type { PriceTable } from '../runner/cost';
import { mergePrices, priceTableOf, readUserPriceOverrides } from '../runner/agent-pricing.settings';

/** The price table a usage report uses, and whether the user's own overrides changed it. */
export interface EffectivePrices {
  table: PriceTable;
  /** True when the caller's own model prices replaced at least one of the deployment's. */
  overridesApplied: boolean;
}

/**
 * The prices of a usage report (#733): the deployment's `agentPricing` table,
 * and for a user's own report their own prices on top (#735, `forUser`). The
 * deployment-wide report (`deployment`) never uses a user's prices.
 */
@Injectable()
export class UsagePricingService {
  private readonly log = new Logger(UsagePricingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SystemSettingsService,
  ) {}

  /** The deployment's table. Unreadable settings give an empty table (every model unpriced), never an error. */
  async deployment(): Promise<PriceTable> {
    try {
      return priceTableOf(await this.settings?.getNamespace('agentPricing'));
    } catch (e) {
      this.log.warn(`could not read the model price table: ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  }

  /** The table for `userId`'s own report: the deployment's, with the user's own prices on top (#735). */
  async forUser(userId: string): Promise<EffectivePrices> {
    const deployment = await this.deployment();
    let own: PriceTable = {};
    try {
      own = await readUserPriceOverrides(this.prisma, userId);
    } catch (e) {
      this.log.warn(`could not read a user's own model prices: ${e instanceof Error ? e.name : 'error'}`);
    }
    return { table: mergePrices(deployment, own), overridesApplied: Object.keys(own).length > 0 };
  }
}
