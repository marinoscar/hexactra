// The deployment's caps on deliveries (settings namespace `deliveries`, deliveries.settings.ts) and the count the daily cap uses.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../prisma/prisma.service';
import { DELIVERY_AUDIT } from './deliveries.constants';
import { DELIVERY_LIMIT_DEFAULTS, resolveDeliveryLimits, type ResolvedDeliveryLimits } from './deliveries.settings';

const CACHE_MS = 30_000;
const DAY_MS = 24 * 60 * 60_000;

@Injectable()
export class DeliveryLimits {
  private readonly log = new Logger(DeliveryLimits.name);
  private cached: { at: number; value: ResolvedDeliveryLimits } | null = null;
  clock: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly settings?: SystemSettingsService,
  ) {}

  async get(): Promise<ResolvedDeliveryLimits> {
    const now = this.clock();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.value;
    try {
      const v = await this.settings?.getNamespace('deliveries');
      const value = resolveDeliveryLimits(v ?? null);
      this.cached = { at: now, value };
      return value;
    } catch (e) {
      this.log.warn(`deliveries settings could not be read (${e instanceof Error ? e.name : 'error'}); using the last known values`);
      const value = this.cached?.value ?? { ...DELIVERY_LIMIT_DEFAULTS };
      this.cached = { at: now, value };
      return value;
    }
  }

  invalidate(): void {
    this.cached = null;
  }

  /**
   * How many email messages this user's deliveries sent in the last 24 hours: the run deliveries that are sent or being sent, and the
   * test sends. Counted from the log's own counts (`detail.messages`), never from content.
   */
  async emailsInLastDay(userId: string): Promise<number> {
    const since = new Date(this.clock() - DAY_MS);
    const [runs, tests] = await Promise.all([
      this.prisma.runDelivery.findMany({ where: { userId, kind: 'email', createdAt: { gte: since }, status: { in: ['sent', 'sending', 'failed'] } }, select: { detail: true } }),
      this.prisma.auditEvent.findMany({ where: { actorUserId: userId, action: DELIVERY_AUDIT.tested, createdAt: { gte: since } }, select: { meta: true } }),
    ]);
    const n = (d: unknown): number => {
      const m = d && typeof d === 'object' ? (d as { messages?: unknown }).messages : 0;
      return typeof m === 'number' && Number.isFinite(m) ? m : 0;
    };
    return runs.reduce((s, r) => s + n(r.detail), 0) + tests.reduce((s, t) => s + n(t.meta), 0);
  }
}
