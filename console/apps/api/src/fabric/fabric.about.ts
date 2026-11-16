import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { registerAboutContributor, type AboutContributorDef, type BoundedFacts } from '@marinoscar/platform-api/host';

import { FabricClient, FabricError, type FabricHost } from './fabric.client';

/**
 * Each fabric call gets this long. The platform drops a contributor that takes
 * more than two seconds (ABOUT_CONTRIBUTOR_TIMEOUT_MS), and health and hosts
 * run in parallel, so one budget below that keeps the section on the page.
 */
const PROBE_TIMEOUT_MS = 1_500;

/**
 * The live client, bound by {@link FabricAboutBinding} when the application
 * starts. The contributor registry is static (registered at import time, frozen
 * at bootstrap) and `describe()` gets no injector, so this is how it reaches DI.
 */
let client: FabricClient | null = null;

function reason(e: unknown): string {
  return e instanceof FabricError ? e.message : e instanceof Error ? e.message : String(e);
}

/**
 * The "Hexactra Fabric" section of Administration → About: the control plane
 * this console drives browsers through. The service token is never reported
 * (and a key named like one would be dropped by the platform anyway). An
 * unreachable fabric is a fact on the page, never an error: this never throws.
 */
export async function describeFabric(fabric: FabricClient | null = client): Promise<BoundedFacts> {
  if (!fabric) return { configured: false };
  const config = await fabric.config().catch(() => null);
  if (!config) return { configured: false, fix: 'Administration → Fabric connection' };

  const facts: BoundedFacts = { configured: true, url: config.url };
  const [health, hosts] = await Promise.allSettled([
    fabric.health(PROBE_TIMEOUT_MS),
    fabric.request<{ hosts: FabricHost[] }>('GET', '/v1/hosts', { timeoutMs: PROBE_TIMEOUT_MS, retries: 0 }),
  ]);

  if (health.status === 'fulfilled') {
    facts.reachable = true;
    facts.version = health.value.version;
  } else {
    facts.reachable = false;
    facts.error = reason(health.reason);
  }

  if (hosts.status === 'fulfilled') {
    const list = hosts.value.hosts;
    facts.browserHosts = list.length;
    facts.browserHostsOnline = list.filter((h) => h.online).length;
    facts.browsersConnected = list.filter((h) => h.browser_connected).length;
  } else if (health.status === 'fulfilled') {
    // Reachable but the host list was refused: almost always the service token.
    facts.hostsError = reason(hosts.reason);
  }
  return facts;
}

export const fabricAboutContributor: AboutContributorDef = {
  id: 'fabric',
  label: 'Hexactra Fabric',
  describe: () => describeFabric(),
};

// At import time, as the platform requires (the registry freezes once the
// application has bootstrapped). Importing this file twice is one registration.
registerAboutContributor(fabricAboutContributor);

/** Hands the contributor the application's {@link FabricClient}. */
@Injectable()
export class FabricAboutBinding implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly fabric: FabricClient) {}

  onModuleInit(): void {
    client = this.fabric;
  }

  onModuleDestroy(): void {
    if (client === this.fabric) client = null;
  }
}
