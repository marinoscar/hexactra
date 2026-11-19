// Who may receive a task's run reports (E39.6, #603).
//
//   * The owner's own account address and the addresses of the owner's own connections are usable at once.
//   * Any other address must be confirmed ONCE by the owner in the web app (a confirm dialog naming the address, recorded with the
//     time). A delivery with an unconfirmed address cannot be switched on, and cannot send.
//   * A recipient who is not the owner is told once, before the first report: "You will receive run reports from <owner> through
//     Hexactra" with a link that stops them. The link disables that recipient on every delivery of the owner (`unsubscribedAt`); only
//     the owner confirming the address again turns it back on.
//   * Nothing in a run can add a recipient: the addresses are fixed on the delivery, and confirming one is the owner's act through
//     this route, never through an MCP tool or a model path.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import './deliveries.errors';
import { PrismaService } from '../prisma/prisma.service';
import { signToken, verifyToken } from '../tasks/signed-token';
import { UNSUBSCRIBE_LINK_TTL_S } from './deliveries.constants';


export const UNSUBSCRIBE_KIND = 'unsubscribe';

export type RecipientState = 'own' | 'confirmed' | 'unconfirmed' | 'unsubscribed';

/** Lower-case and trimmed: the form every comparison and every stored row uses. */
export const normalizeAddress = (a: string): string => a.trim().toLowerCase();

export interface UnsubscribeClaims {
  userId: string;
  address: string;
}

@Injectable()
export class DeliveryRecipients {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** The owner's account address and the addresses of their connections, lower-case. */
  async ownAddresses(userId: string): Promise<Set<string>> {
    const [user, connections] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
      this.prisma.connection.findMany({ where: { userId }, select: { accountEmail: true } }),
    ]);
    return new Set([user?.email, ...connections.map((c) => c.accountEmail)].filter((e): e is string => Boolean(e)).map(normalizeAddress));
  }

  /** Where each address stands for this owner. */
  async states(userId: string, addresses: readonly string[]): Promise<Map<string, RecipientState>> {
    const wanted = [...new Set(addresses.map(normalizeAddress))];
    const own = await this.ownAddresses(userId);
    const rows = await this.prisma.forUser({ userId }).deliveryRecipient.findMany({ where: { address: { in: wanted } }, select: { address: true, unsubscribedAt: true } });
    const by = new Map(rows.map((r) => [r.address, r]));
    return new Map(
      wanted.map((a): [string, RecipientState] => {
        const row = by.get(a);
        // The owner's own addresses cannot stop their own emails: a row for one is ignored.
        if (own.has(a)) return [a, 'own'];
        if (!row) return [a, 'unconfirmed'];
        return [a, row.unsubscribedAt ? 'unsubscribed' : 'confirmed'];
      }),
    );
  }

  /** The addresses that are neither the owner's nor confirmed (an unsubscribed one counts as confirmed here: it is skipped, not refused). */
  async unconfirmed(userId: string, addresses: readonly string[]): Promise<string[]> {
    const s = await this.states(userId, addresses);
    return [...s.entries()].filter(([, st]) => st === 'unconfirmed').map(([a]) => a);
  }

  /** The owner confirms an address (the dialog). Confirming again re-enables a recipient who had stopped the emails. */
  async confirm(userId: string, address: string): Promise<{ address: string; confirmedAt: Date; unsubscribedAt: Date | null }> {
    const a = normalizeAddress(address);
    const db = this.prisma.forUser({ userId });
    const now = new Date();
    const existing = await db.deliveryRecipient.findFirst({ where: { address: a } });
    const row = existing
      ? await this.prisma.deliveryRecipient.update({ where: { id: existing.id }, data: { confirmedAt: now, unsubscribedAt: null } })
      : await this.prisma.deliveryRecipient.create({ data: { userId, address: a, confirmedAt: now } });
    return { address: row.address, confirmedAt: row.confirmedAt, unsubscribedAt: row.unsubscribedAt };
  }

  async list(userId: string): Promise<{ address: string; confirmedAt: Date; unsubscribedAt: Date | null }[]> {
    const rows = await this.prisma.forUser({ userId }).deliveryRecipient.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({ address: r.address, confirmedAt: r.confirmedAt, unsubscribedAt: r.unsubscribedAt }));
  }

  /** Whether the first-use notice still has to go out to this address (it never does for the owner's own addresses). */
  async noticeDue(userId: string, address: string): Promise<boolean> {
    const a = normalizeAddress(address);
    if ((await this.ownAddresses(userId)).has(a)) return false;
    const row = await this.prisma.forUser({ userId }).deliveryRecipient.findFirst({ where: { address: a }, select: { noticeSentAt: true } });
    return Boolean(row) && !row!.noticeSentAt;
  }

  async markNoticeSent(userId: string, address: string): Promise<void> {
    await this.prisma.deliveryRecipient.updateMany({ where: { userId, address: normalizeAddress(address), noticeSentAt: null }, data: { noticeSentAt: new Date() } });
  }

  // ----- the unsubscribe link ---------------------------------------------------------------------------------------

  unsubscribeToken(userId: string, address: string): string {
    return signToken(UNSUBSCRIBE_KIND, { u: userId, a: normalizeAddress(address) }, UNSUBSCRIBE_LINK_TTL_S);
  }

  unsubscribeUrl(userId: string, address: string): string {
    return `${(this.config.get<string>('appUrl') ?? '').replace(/\/+$/, '')}/api/deliveries/unsubscribe/${this.unsubscribeToken(userId, address)}`;
  }

  verifyUnsubscribe(token: string): UnsubscribeClaims | null {
    const c = verifyToken(UNSUBSCRIBE_KIND, token);
    return c && typeof c.u === 'string' && typeof c.a === 'string' ? { userId: c.u, address: c.a } : null;
  }

  /**
   * The recipient followed the link: their address stops receiving the owner's reports. Idempotent. Returns whether an address was
   * disabled now (false: unknown address or already stopped), so the audit event is written once.
   */
  async unsubscribe(claims: UnsubscribeClaims): Promise<boolean> {
    const r = await this.prisma.deliveryRecipient.updateMany({ where: { userId: claims.userId, address: normalizeAddress(claims.address), unsubscribedAt: null }, data: { unsubscribedAt: new Date() } });
    return r.count > 0;
  }
}
