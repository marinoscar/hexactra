import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { readKgraphSystemSettings, type KgraphSystemSettings } from './kgraph.settings';

/**
 * Reads and writes the system settings' `kgraph` namespace: the same document `/api/system-settings` edits, through the platform's service.
 * The audit event carries the keys changed and the switch only.
 */
@Injectable()
export class KgraphAdminService {
  private readonly log = new Logger(KgraphAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SystemSettingsService,
  ) {}

  private service(): SystemSettingsService {
    if (!this.settings) throw new ServiceUnavailableException('System settings are not available');
    return this.settings;
  }

  async get(): Promise<KgraphSystemSettings> {
    return readKgraphSystemSettings(await this.service().getNamespace('kgraph'));
  }

  async put(userId: string, patch: Partial<KgraphSystemSettings>): Promise<KgraphSystemSettings> {
    const before = await this.get();
    const next = { ...before, ...patch };
    await this.service().patchSettings({ kgraph: next } as never, userId);
    const changed = (Object.keys(patch) as (keyof KgraphSystemSettings)[]).filter((k) => before[k] !== next[k]);
    if (changed.length) {
      try {
        await this.prisma.auditEvent.create({ data: { actorUserId: userId, action: 'kgraph.settings.changed', targetType: 'system_settings', targetId: 'kgraph', meta: { changed, enabled: next.enabled } as Prisma.InputJsonValue } });
      } catch (err) {
        this.log.warn(`kgraph.settings.changed: the audit record could not be written: ${err instanceof Error ? err.name : 'error'}`);
      }
    }
    return this.get();
  }
}
