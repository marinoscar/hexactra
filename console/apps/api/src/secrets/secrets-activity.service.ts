// The durable Activity list of the Secrets page (E37.4, #593): ingest of the fabric's `secrets.*` audit events, and
// the reads built on the rows. Nothing here handles a value: `sanitizeSecretsEvent` copies a whitelist of fields and
// every response below is made of those columns only.
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { readUsedSavedLogins } from '../runner/saved-logins';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVITY_FIELDS, SECRETS_ACTIVITY_KEEP_DAYS, isRefusal, sanitizeSecretsEvent, type SanitizedActivity } from './secrets-activity';

/** The newest uses the page lists. */
export const ACTIVITY_PAGE_SIZE = 100;
const DAY_MS = 86_400_000;

export interface ActivityItem {
  id: string;
  at: string;
  /** `lookup`: asked the provider for the logins of a page. `release`: a field was handed over to be typed. */
  event: 'lookup' | 'release';
  /** The run (or chat browser) it happened in, when it is one of this user's and still exists. */
  runId: string | null;
  site: string | null;
  /** The saved login's name, as the run recorded it when it signed in (E37.3); null when the run is gone or did not record this site. */
  loginName: string | null;
  field: (typeof ACTIVITY_FIELDS)[number] | null;
  outcome: string;
  /** The fabric refused or failed: nothing was typed. */
  refused: boolean;
  /** For a lookup: how many logins matched the page. */
  matches: number | null;
}

export interface ReachItem {
  site: string | null;
  /** The fields typed so far for this login, in the order username, password, one_time_code. */
  fields: string[];
  uses: number;
  lastUsedAt: string;
  lastRunId: string | null;
}

export interface SecretsAdminSummary {
  deploymentEnabled: boolean;
  usersConnected: number;
  usersNeedingReconnect: number;
  usesThisWeek: number;
  refusalsThisWeek: number;
}

const hostOfOrigin = (origin: string): string | null => {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
};

const FIELD_ORDER: readonly string[] = ACTIVITY_FIELDS;

@Injectable()
export class SecretsActivityService {
  private readonly log = new Logger(SecretsActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fabric: FabricClient,
  ) {}

  /** Rows for the events, skipping what is already stored and what names an unknown user. Returns how many were new. */
  async ingest(events: readonly unknown[]): Promise<number> {
    const rows = events.map((e) => sanitizeSecretsEvent(e)).filter((r): r is SanitizedActivity => r !== null);
    if (rows.length === 0) return 0;

    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true } });
    const known = new Set(users.map((u) => u.id));
    const runIds = [...new Set(rows.map((r) => r.runId).filter((id): id is string => id !== null))];
    const runs = runIds.length ? await this.prisma.run.findMany({ where: { id: { in: runIds } }, select: { id: true, userId: true } }) : [];
    const runOwner = new Map(runs.map((r) => [r.id, r.userId]));

    const data: Prisma.SecretsActivityCreateManyInput[] = rows
      .filter((r) => known.has(r.userId))
      .map((r) => ({
        userId: r.userId,
        occurredAt: r.occurredAt,
        event: r.event,
        opId: r.opId,
        // A run of another user is never linked.
        runId: r.runId && runOwner.get(r.runId) === r.userId ? r.runId : null,
        provider: r.provider,
        itemId: r.itemId,
        field: r.field,
        site: r.site,
        purpose: r.purpose,
        outcome: r.outcome,
        matches: r.matches,
        released: r.released,
      }));
    if (data.length === 0) return 0;
    const res = await this.prisma.secretsActivity.createMany({ data, skipDuplicates: true });
    return res.count;
  }

  /** Reads the fabric's events and stores them; `0` when the fabric is not configured or not answering (the next tick tries again). */
  async ingestFromFabric(): Promise<{ read: number; stored: number }> {
    let events: unknown[];
    try {
      events = await this.fabric.secretsEvents();
    } catch (e) {
      if (e instanceof FabricError) {
        this.log.debug(`secrets activity: the fabric's events could not be read (${e.kind})`);
        return { read: 0, stored: 0 };
      }
      throw e;
    }
    return { read: events.length, stored: await this.ingest(events) };
  }

  /** Deletes rows older than the retention. */
  async purge(now = new Date()): Promise<number> {
    const res = await this.prisma.secretsActivity.deleteMany({ where: { occurredAt: { lt: new Date(now.getTime() - SECRETS_ACTIVITY_KEEP_DAYS * DAY_MS) } } });
    return res.count;
  }

  /** The owner's newest uses and refusals. */
  async list(userId: string, limit = ACTIVITY_PAGE_SIZE): Promise<ActivityItem[]> {
    const rows = await this.prisma.secretsActivity.findMany({ where: { userId }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: Math.min(limit, ACTIVITY_PAGE_SIZE) });
    // The login's name is not in the fabric's audit event: it is the one the run recorded for that site.
    const runIds = [...new Set(rows.map((r) => r.runId).filter((id): id is string => id !== null))];
    const runs = runIds.length ? await this.prisma.run.findMany({ where: { id: { in: runIds }, userId }, select: { id: true, usedSavedLogins: true } }) : [];
    const used = new Map(runs.map((r) => [r.id, readUsedSavedLogins(r.usedSavedLogins)]));
    const nameOf = (runId: string | null, site: string | null): string | null => {
      if (!runId || !site) return null;
      return used.get(runId)?.find((l) => hostOfOrigin(l.origin) === site)?.itemName ?? null;
    };
    return rows.map((r) => ({
      id: r.id,
      at: r.occurredAt.toISOString(),
      event: r.event === 'lookup' ? 'lookup' : 'release',
      runId: r.runId,
      site: r.site,
      loginName: r.event === 'release' ? nameOf(r.runId, r.site) : null,
      field: (r.field as ActivityItem['field']) ?? null,
      outcome: r.outcome,
      refused: isRefusal(r.outcome),
      matches: r.matches,
    }));
  }

  /**
   * The logins the agent has used so far: one entry per login (provider item) and site, from the typed fields. This
   * is what the page shows because Vault's lookup is per origin: there is no call that lists every opened login.
   */
  async reach(userId: string): Promise<ReachItem[]> {
    const rows = await this.prisma.secretsActivity.findMany({
      where: { userId, event: 'release', outcome: { in: ['typed', 'selected'] } },
      orderBy: { occurredAt: 'desc' },
      take: 1000,
      select: { itemId: true, site: true, field: true, occurredAt: true, runId: true },
    });
    const by = new Map<string, ReachItem & { fieldSet: Set<string> }>();
    for (const r of rows) {
      const key = `${r.itemId ?? ''}|${r.site ?? ''}`;
      const cur = by.get(key);
      if (!cur) by.set(key, { site: r.site, fields: [], fieldSet: new Set(r.field ? [r.field] : []), uses: 1, lastUsedAt: r.occurredAt.toISOString(), lastRunId: r.runId });
      else {
        cur.uses++;
        if (r.field) cur.fieldSet.add(r.field);
      }
    }
    return [...by.values()].map(({ fieldSet, ...v }) => ({ ...v, fields: FIELD_ORDER.filter((f) => fieldSet.has(f)) }));
  }

  /** Counts for the administrator: no owner, no login, no site. */
  async adminSummary(deploymentEnabled: boolean, now = new Date()): Promise<SecretsAdminSummary> {
    const since = new Date(now.getTime() - 7 * DAY_MS);
    const [connected, reconnect, uses, refusals] = await Promise.all([
      this.prisma.secretsConnection.count({ where: { provider: 'vault', status: 'connected' } }),
      this.prisma.secretsConnection.count({ where: { provider: 'vault', status: 'needs_reconnect' } }),
      this.prisma.secretsActivity.count({ where: { event: 'release', outcome: { in: ['typed', 'selected'] }, occurredAt: { gte: since } } }),
      this.prisma.secretsActivity.count({ where: { outcome: { notIn: ['typed', 'selected', 'ok'] }, occurredAt: { gte: since } } }),
    ]);
    return { deploymentEnabled, usersConnected: connected, usersNeedingReconnect: reconnect, usesThisWeek: uses, refusalsThisWeek: refusals };
  }
}
