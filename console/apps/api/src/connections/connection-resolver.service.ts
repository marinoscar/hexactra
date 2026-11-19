// Which account does this need? (E39.2, #599). Used by every later issue (deliveries, agent tools, triggers). The account is
// ALWAYS explicit: when two could apply and the owner did not say which, this throws `CONNECTION_AMBIGUOUS` listing the labels,
// and the caller turns it into a question to the owner. It never guesses between accounts.
//
//   1. an explicit `connectionId` or `label` wins (a label is matched ignoring case);
//   2. otherwise the default account for the capability's group (at most one per provider; with no provider named and a default
//      at two providers, that is ambiguous too);
//   3. otherwise, if exactly one ACTIVE connection has the capability, that one;
//   4. otherwise `CONNECTION_AMBIGUOUS` (several) or `CONNECTION_NONE` (none).
// A paused or `needs_reconnect` connection is never chosen: naming one, or its being the default, fails with a typed error
// (`CONNECTION_PAUSED`, `CONNECTION_NEEDS_RECONNECT`) rather than silently falling back to another account.
import { Injectable } from '@nestjs/common';
import type { Connection } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { groupOf, type Capability, type ConnectionProviderId } from './connections.constants';
import { ConnectionError, notFound } from './connections.errors';
import { capabilitiesOf } from './connection-view';

export interface ResolveSelector {
  provider?: ConnectionProviderId;
  capability: Capability;
  connectionId?: string;
  label?: string;
}

/** The connection a caller may use: no token (ask `ConnectionTokensService` for one when needed). */
export interface ResolvedConnection {
  id: string;
  provider: ConnectionProviderId;
  label: string;
  accountEmail: string;
  capabilities: Capability[];
}

const resolved = (c: Connection): ResolvedConnection => ({ id: c.id, provider: c.provider as ConnectionProviderId, label: c.label, accountEmail: c.accountEmail, capabilities: capabilitiesOf(c) });

@Injectable()
export class ConnectionResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveConnection(userId: string, sel: ResolveSelector): Promise<ResolvedConnection> {
    const all = await this.prisma.connection.findMany({ where: { userId, ...(sel.provider ? { provider: sel.provider } : {}), NOT: { provider: 'mcp' } }, orderBy: { label: 'asc' } });
    const group = groupOf(sel.capability);

    // 1. explicit
    if (sel.connectionId || sel.label) {
      const hit = sel.connectionId ? all.find((c) => c.id === sel.connectionId) : all.find((c) => c.label.toLowerCase() === (sel.label ?? '').trim().toLowerCase());
      if (!hit) throw notFound();
      return this.usable(hit, sel.capability);
    }

    const withCapability = all.filter((c) => c.status !== 'revoked' && capabilitiesOf(c).includes(sel.capability));

    // 2. the default
    const defaults = withCapability.filter((c) => c.defaultFor.includes(group));
    if (defaults.length === 1) return this.usable(defaults[0]!, sel.capability);
    if (defaults.length > 1) throw new ConnectionError('CONNECTION_AMBIGUOUS', 'More than one account is a default for this: say which.', { capability: sel.capability, candidates: defaults.map((c) => c.label) });

    // 3. exactly one active candidate
    const active = withCapability.filter((c) => c.status === 'active');
    if (active.length === 1) return resolved(active[0]!);
    if (active.length > 1) throw new ConnectionError('CONNECTION_AMBIGUOUS', 'More than one account could do this: say which.', { capability: sel.capability, candidates: active.map((c) => c.label) });

    throw new ConnectionError('CONNECTION_NONE', 'No active connection can do this.', { capability: sel.capability, unavailable: withCapability.map((c) => ({ label: c.label, status: c.status })) });
  }

  /** The chosen connection, if it can be used for this capability right now. */
  private usable(c: Connection, capability: Capability): ResolvedConnection {
    if (c.status === 'paused') throw new ConnectionError('CONNECTION_PAUSED', 'This connection is paused.', { label: c.label });
    if (c.status !== 'active') throw new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { label: c.label, reason: c.statusReason ?? 'NEEDS_RECONNECT' });
    if (!capabilitiesOf(c).includes(capability)) throw new ConnectionError('CONNECTION_CAPABILITY_OFF', 'This capability is not switched on for this connection.', { label: c.label, capability });
    return resolved(c);
  }
}
