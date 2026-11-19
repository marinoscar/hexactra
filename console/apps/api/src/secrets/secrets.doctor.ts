// The Doctor's view of the Vault connections (E37.2, #591). Read-only, as the Doctor requires: a count and a
// host list, no write, no audit row, no job, no call to Vault, and nothing that identifies an owner.
//
//   secrets.vault_connections   warn: connections need reconnecting (the owner is notified once; this is the
//                               administrator's line); pass: how many are connected and whether agent use is on.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DoctorCheckRegistry, EgressRegistry, egressDependency, type DoctorCheck, type DoctorCheckOutcome, type EgressContributor, type EgressDependency } from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../prisma/prisma.service';
import { SecretsPolicyService } from './secrets-policy.service';

/** Where an administrator configures the deployment default (the settings registry card is E37.4's). */
export const SECRETS_SETTINGS_PATH = '/admin/settings/secrets';

@Injectable()
export class VaultConnectionsCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'secrets.vault_connections';
  readonly label = 'Vault connections';
  readonly category = 'secrets';
  readonly settingsPath = SECRETS_SETTINGS_PATH;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
    private readonly policy: SecretsPolicyService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      this.policy.invalidate();
      const [connected, needs, system] = await Promise.all([
        this.prisma.secretsConnection.count({ where: { provider: 'vault', status: 'connected' } }),
        this.prisma.secretsConnection.count({ where: { provider: 'vault', status: 'needs_reconnect' } }),
        this.policy.system(),
      ]);
      const data = { connected, needsReconnect: needs, agentUseEnabled: system.agentUse.enabled };
      if (needs > 0) {
        return {
          status: 'warn',
          detail: `${needs} Vault connection${needs === 1 ? '' : 's'} need${needs === 1 ? 's' : ''} to be reconnected: Vault refused the saved grant (removed in Vault, replayed or expired). Agents fall back to asking the owner.`,
          remedy: 'Each owner connects again in Settings → Secrets; they were notified once.',
          data,
        };
      }
      return { status: 'pass', detail: `${connected} Vault connection${connected === 1 ? '' : 's'} connected; agent use of stored secrets is ${system.agentUse.enabled ? 'on' : 'off'} for the deployment.`, data };
    } catch {
      return { status: 'fail', detail: 'The check could not run.' };
    }
  }
}

/** The Vault hosts the console calls: connected owners' and the deployment default. Hostnames only. */
@Injectable()
export class VaultEgressContributor implements EgressContributor, OnModuleInit {
  readonly id = 'secrets';

  constructor(
    private readonly egress: EgressRegistry,
    private readonly prisma: PrismaService,
    private readonly policy: SecretsPolicyService,
  ) {}

  onModuleInit(): void {
    this.egress.register(this);
  }

  async describe(): Promise<EgressDependency[]> {
    const rows = await this.prisma.secretsConnection.findMany({ where: { provider: 'vault', status: { in: ['connected', 'needs_reconnect'] }, baseUrl: { not: null } }, select: { baseUrl: true }, distinct: ['baseUrl'], take: 20 });
    const system = await this.policy.system();
    const hosts = [system.vault.baseUrl, ...rows.map((r) => r.baseUrl)];
    return [
      egressDependency({
        id: 'secrets.vault',
        capability: "Vault (the owner's saved logins)",
        direction: 'server',
        enabled: hosts.some(Boolean),
        required: false,
        hosts,
        degradation: 'The agent cannot use saved logins and falls back to asking the owner',
        settingsPath: SECRETS_SETTINGS_PATH,
      }),
    ];
  }
}
