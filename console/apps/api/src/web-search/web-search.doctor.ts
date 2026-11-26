// The egress list's view of web search (E50.5, #975): one dependency per installed search provider, with its hosts. Read-only:
// no call to a provider, no key, nothing that identifies a user. The Doctor checks of web search are E50.13.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { EgressRegistry, egressDependency, type EgressContributor, type EgressDependency } from '@marinoscar/platform-api/doctor';

import { SearchProviderRegistry } from './search-provider';
import { providerSettingsOf } from './web-search.settings';
import { WebSearchService } from './web-search.service';

/** Where an administrator configures web search. */
export const WEB_SEARCH_SETTINGS_PATH = '/admin/settings/web-search';

@Injectable()
export class WebSearchEgressContributor implements EgressContributor, OnModuleInit {
  readonly id = 'web_search';

  constructor(
    private readonly egress: EgressRegistry,
    private readonly registry: SearchProviderRegistry,
    private readonly service: WebSearchService,
  ) {}

  onModuleInit(): void {
    this.egress.register(this);
  }

  async describe(): Promise<EgressDependency[]> {
    const s = await this.service.system();
    return this.registry.list().map((p) => {
      const ps = providerSettingsOf(s, p.id);
      return egressDependency({
        id: `web_search.${p.id}`,
        capability: `Web search (${p.label})`,
        direction: 'server',
        enabled: s.enabled && ps.enabled && s.order.includes(p.id),
        required: false,
        hosts: p.credential === 'none' ? [ps.baseUrl ?? ''] : [...p.hosts],
        degradation: 'The agent searches in the browser instead',
        settingsPath: WEB_SEARCH_SETTINGS_PATH,
      });
    });
  }
}
