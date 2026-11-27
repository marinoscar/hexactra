// The administrator's side of web search (E50.5, #975): the system settings and the deployment's usage. Audited; no key, no user.
import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { registerErrorCode } from '@marinoscar/platform-api/core';
import type { Prisma } from '@prisma/client';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { OutboundHttp, OutboundHttpError } from '../oauth-client/outbound-http';
import { PrismaService } from '../prisma/prisma.service';
import { SearchProviderRegistry } from './search-provider';
import type { WebSearchAdminSettings } from './web-search.schemas';
import { mergeWebSearchSystemSettings, providerSettingsOf, resolveWebSearchSystemSettings, type WebSearchSystemSettings } from './web-search.settings';
import { WebSearchService } from './web-search.service';
import { WebSearchUsage, type UsageRow } from './web-search.usage';

export const WEB_SEARCH_SETTINGS_AUDIT = 'web_search.settings_saved';

registerErrorCode({
  code: 'WEB_SEARCH_ADDRESS_REFUSED',
  status: 422,
  description: "A self-hosted provider's address is refused: it must be https and public, unless \"this instance is on my private network\" (`allowPrivate`) is ticked, which accepts http and a private address for that one host. `details.reason` says why.",
});

/** Why an address is refused, from the transport's closed codes. An address that does not resolve yet is accepted (Test says so). */
function addressRefused(reason: string): HttpException {
  return new HttpException({ code: 'WEB_SEARCH_ADDRESS_REFUSED', message: "The self-hosted provider's address is refused.", details: { reason } }, HttpStatus.UNPROCESSABLE_ENTITY);
}

@Injectable()
export class WebSearchAdminService {
  private readonly log = new Logger('WebSearch');

  constructor(
    private readonly service: WebSearchService,
    private readonly registry: SearchProviderRegistry,
    private readonly usage: WebSearchUsage,
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SystemSettingsService,
    @Optional() private readonly http?: OutboundHttp,
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
    await this.checkAddresses(patch);
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

  /**
   * A self-hosted provider's address (E50.8), checked when it is saved with the same rule every request applies again: https and a
   * public address, or, with `allowPrivate`, http and a private address for that one host. A clear refusal here; the request-time
   * check stays the authority (the setting can also be written through the generic settings route).
   */
  private async checkAddresses(patch: WebSearchSystemSettings): Promise<void> {
    const touched = Object.entries(patch.providers ?? {}).filter(([, p]) => p && ('baseUrl' in p || 'allowPrivate' in p)).map(([id]) => id);
    if (touched.length === 0) return;
    this.service.invalidate();
    const current = await this.service.system();
    const next = resolveWebSearchSystemSettings(mergeWebSearchSystemSettings(current, patch));
    for (const id of touched) {
      if (this.registry.get(id)?.credential !== 'none') continue;
      const { baseUrl, allowPrivate } = providerSettingsOf(next, id);
      if (!baseUrl) continue;
      const u = new URL(baseUrl);
      if (u.protocol === 'http:' && !allowPrivate) throw addressRefused('scheme_not_allowed');
      const host = u.hostname.replace(/^\[|\]$/g, '');
      try {
        await this.http?.check(baseUrl, allowPrivate ? [host] : [], allowPrivate);
      } catch (e) {
        const code = e instanceof OutboundHttpError ? e.code : 'invalid_url';
        if (code !== 'unresolvable') throw addressRefused(code);
      }
    }
  }

  usageTotals(days: number): Promise<UsageRow[]> {
    return this.usage.totals(this.service.clock(), days);
  }
}
