import { Injectable, type OnModuleInit } from '@nestjs/common';
import { EgressRegistry, egressDependency, type EgressContributor, type EgressDependency } from '@marinoscar/platform-api/doctor';

import { FabricClient } from './fabric.client';
import { FABRIC_SETTINGS_PATH } from './fabric.doctor-checks';

/** The console's one outbound dependency of its own: the fabric control plane. */
@Injectable()
export class FabricEgressContributor implements EgressContributor, OnModuleInit {
  readonly id = 'fabric';

  constructor(
    private readonly egress: EgressRegistry,
    private readonly fabric: FabricClient,
  ) {}

  onModuleInit(): void {
    this.egress.register(this);
  }

  async describe(): Promise<EgressDependency[]> {
    const config = await this.fabric.config();
    return [
      egressDependency({
        id: 'fabric.control',
        capability: 'Hexactra Fabric control plane',
        direction: 'server',
        enabled: config !== null,
        required: true,
        hosts: [config?.url],
        degradation: 'No browser work runs: tasks, fleet and handoffs need the fabric',
        settingsPath: FABRIC_SETTINGS_PATH,
      }),
    ];
  }
}
