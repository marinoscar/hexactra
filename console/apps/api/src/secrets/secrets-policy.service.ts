// The two switches of "the agent may use stored secrets" (E37.2, #591): the deployment's (system setting
// `secrets.agentUse.enabled`, default off) and the owner's (user setting `secrets.agentUse.enabled`, default off).
// BOTH must be on, whatever a Vault allows: this is Hexactra's own kill switch, in front of Vault's.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../prisma/prisma.service';
import { resolveSecretsSystemSettings, secretsAgentUseOf, secretsDefaultUseSavedLoginsOf, secretsProviderOf, type ResolvedSecretsSystemSettings, type SecretsProviderId } from './secrets.settings';

/** How stale the cached system settings may be: a switch takes effect within a few seconds. */
export const SECRETS_SETTINGS_CACHE_MS = 5_000;

export interface AgentUseState {
  deployment: boolean;
  user: boolean;
  /** Both on. */
  effective: boolean;
}

@Injectable()
export class SecretsPolicyService {
  private readonly log = new Logger(SecretsPolicyService.name);
  private cached: { at: number; value: ResolvedSecretsSystemSettings } | null = null;

  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SystemSettingsService,
  ) {}

  /** The deployment's `secrets` settings with every field filled, at most `SECRETS_SETTINGS_CACHE_MS` old. A failed read keeps the last good value, or the safe defaults (off). */
  async system(): Promise<ResolvedSecretsSystemSettings> {
    const now = this.clock();
    if (this.cached && now - this.cached.at < SECRETS_SETTINGS_CACHE_MS) return this.cached.value;
    try {
      const v = await this.settings?.getNamespace('secrets');
      const value = resolveSecretsSystemSettings(v ?? null);
      this.cached = { at: now, value };
      return value;
    } catch (e) {
      this.log.warn(`secrets settings could not be read (${e instanceof Error ? e.name : 'error'}); using the last known values`);
      const value = this.cached?.value ?? resolveSecretsSystemSettings(null);
      this.cached = { at: now, value };
      return value;
    }
  }

  /** Forget the cached value (tests, and right after this process changed the settings). */
  invalidate(): void {
    this.cached = null;
  }

  /** The owner's switch, read from their settings document. */
  async userSwitch(userId: string): Promise<boolean> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    return secretsAgentUseOf(row?.value);
  }

  /** Which provider the owner chose (`vault` unless they picked the built-in store). One is active at a time. */
  async activeProvider(userId: string): Promise<SecretsProviderId> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    return secretsProviderOf(row?.value);
  }

  /** Whether new tasks and chats of the owner start with "sign in with my saved logins" on (user setting `secrets.defaultUseSavedLogins`, off by default). */
  async defaultUseSavedLogins(userId: string): Promise<boolean> {
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    return secretsDefaultUseSavedLoginsOf(row?.value);
  }

  /** The state of both switches for an owner. `effective` is what `secrets_lookup` and the fabric registration obey. */
  async agentUse(userId: string): Promise<AgentUseState> {
    const [system, user] = await Promise.all([this.system(), this.userSwitch(userId)]);
    return { deployment: system.agentUse.enabled, user, effective: system.agentUse.enabled && user };
  }
}
