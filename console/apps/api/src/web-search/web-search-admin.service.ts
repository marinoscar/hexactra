// The administrator's side of web search (E50.5, #975): the system settings and the deployment's usage. Audited; no key, no user.
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../prisma/prisma.service';
import { SearchProviderRegistry } from './search-provider';
import type { WebSearchAdminSettings } from './web-search.schemas';
import type { WebSearchSystemSettings } from './web-search.settings';
import { WebSearchService } from './web-search.service';
import { WebSearchUsage, type UsageRow } from './web-search.usage';

export const WEB_SEARCH_SETTINGS_AUDIT = 'web_search.settings_saved';

@Injectable()
export class WebSearchAdminService {
  private readonly log = new Logger('WebSearch');

  constructor(
    private readonly service: WebSearchService,
    private readonly registry: SearchProviderRegistry,
    private readonly usage: WebSearchUsage,
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SystemSettingsService,
  ) {}

  async view(): Promise<WebSearchAdminSettings> {
    this.service.invalidate();
    const s = await this.service.system();
    return {
      ...s,
      installed: this.registry.list().map((p) => ({ id: p.id, label: p.label, credential: p.credential, hosts: [...p.hosts], defaultEstimatedCostPerCallUsd: p.estimatedCostPerCallUsd })),
    };
  }

  /** A patch: a field left out is kept. Audited with the names of the fields changed, never their values' text. */
  async save(adminId: string, patch: WebSearchSystemSettings): Promise<WebSearchAdminSettings> {
    if (Object.keys(patch).length > 0) await this.settings?.patchSettings({ webSearch: patch } as never, adminId);
    this.service.invalidate();
    try {
      await this.prisma.auditEvent.create({
        data: { actorUserId: adminId, action: WEB_SEARCH_SETTINGS_AUDIT, targetType: 'system_settings', targetId: 'webSearch', meta: { fields: Object.keys(patch).sort() } as Prisma.InputJsonValue },
      });
    } catch (e) {
      this.log.warn(`web search: the audit record could not be written: ${e instanceof Error ? e.name : 'error'}`);
    }
    return this.view();
  }

  usageTotals(days: number): Promise<UsageRow[]> {
    return this.usage.totals(this.service.clock(), days);
  }
}
