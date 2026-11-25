// Hexactra passkeys in the built-in store (epic E47, #940). The fabric makes a P-256 key pair in the browser it drives and keeps
// it here: the private key (PKCS#8) as AES-256-GCM ciphertext under the owner's data key, like a saved password. It is released
// only on the internal route, to the fabric, for one signature, and only when the RP ID is the passkey's and the browser-reported
// origin may use it (WebAuthn's rule). Nothing else returns it: the list for the owner (E47.5) has the site, the account and dates.
import { Injectable } from '@nestjs/common';

import { registrableDomain } from '../../approvals/approval-match';
import { PrismaService } from '../../prisma/prisma.service';
import { SecretsProviderError } from '../secrets-provider.port';
import { decryptValue, encryptValue } from './store.cipher';
import { SecretsStoreKeys } from './store.data-keys';

/**
 * Whether `origin` may use a passkey of `rpId` (WebAuthn §5.1.3): the RP ID is the origin's host or a registrable suffix of it,
 * never a bare public suffix; `https`, or `http` on `localhost` only. The same rule as the fabric's (`rp_id_allowed`).
 */
export function rpIdAllowed(rpId: string, origin: string): boolean {
  if (!rpId || rpId !== rpId.trim().toLowerCase() || rpId.length > 253 || rpId.endsWith('.')) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && host === 'localhost')) return false;
  if (rpId === host) return true;
  const reg = registrableDomain(origin);
  if (!reg) return false;
  return host.endsWith(`.${rpId}`) && (rpId === reg || rpId.endsWith(`.${reg}`));
}

export interface PasskeySummary {
  id: string;
  credentialId: string;
  userHandle: string;
  userName: string;
  rpId: string;
  signCount: number;
}

export interface NewPasskey {
  rpId: string;
  origin: string;
  credentialId: string;
  userHandle: string;
  userName: string;
  publicKey: string;
  /** PKCS#8 DER; the caller wipes it. */
  privateKey: Buffer;
  runId?: string;
}

/** One owner's passkey as the owner's own list shows it (E47.5): never a key. */
export interface PasskeyListItem {
  id: string;
  rpId: string;
  origin: string;
  userName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

@Injectable()
export class StorePasskeys {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: SecretsStoreKeys,
  ) {}

  /** Keep a passkey the fabric made. Its RP ID must fit the page it was made on. */
  async save(ownerId: string, p: NewPasskey): Promise<{ id: string }> {
    if (!rpIdAllowed(p.rpId, p.origin)) throw new SecretsProviderError('origin_mismatch', 'origin');
    const dataKey = await this.keys.load(ownerId, { create: true });
    if (!dataKey) throw new SecretsProviderError('unavailable', 'key');
    let enc: { ciphertext: string; iv: string; authTag: string };
    const plain = p.privateKey.toString('base64url');
    try {
      enc = encryptValue(ownerId, dataKey, plain);
    } finally {
      dataKey.fill(0);
    }
    try {
      const row = await this.prisma.passkeyCredential.create({
        data: {
          ownerUserId: ownerId,
          rpId: p.rpId,
          origin: new URL(p.origin).origin,
          credentialId: p.credentialId,
          userHandle: p.userHandle,
          userName: p.userName.slice(0, 200),
          publicKey: p.publicKey,
          keyCiphertext: enc.ciphertext,
          keyIv: enc.iv,
          keyAuthTag: enc.authTag,
          ...(p.runId ? { createdByRunId: p.runId } : {}),
        },
        select: { id: true },
      });
      return row;
    } catch {
      throw new SecretsProviderError('refused', 'save');
    }
  }

  /** The owner's passkeys for an RP ID the origin may use. Never a key. */
  async lookup(ownerId: string, rpId: string, origin: string): Promise<PasskeySummary[]> {
    if (!rpIdAllowed(rpId, origin)) throw new SecretsProviderError('origin_mismatch', 'origin');
    const rows = await this.prisma.passkeyCredential.findMany({
      where: { ownerUserId: ownerId, rpId },
      select: { id: true, credentialId: true, userHandle: true, userName: true, rpId: true, signCount: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows;
  }

  /** The private key (PKCS#8) of one passkey, for one signature: the RP ID must be the passkey's, and the origin allowed for it. */
  async release(ownerId: string, itemId: string, rpId: string, origin: string): Promise<Buffer> {
    if (!rpIdAllowed(rpId, origin)) throw new SecretsProviderError('origin_mismatch', 'origin');
    const row = await this.prisma.passkeyCredential.findFirst({ where: { id: itemId, ownerUserId: ownerId } });
    if (!row) throw new SecretsProviderError('not_found', 'passkey');
    if (row.rpId !== rpId) throw new SecretsProviderError('origin_mismatch', 'rp');
    const dataKey = await this.keys.load(ownerId, { create: false });
    if (!dataKey) throw new SecretsProviderError('unavailable', 'key');
    try {
      return Buffer.from(decryptValue(ownerId, dataKey, row.keyCiphertext, row.keyIv, row.keyAuthTag), 'base64url');
    } catch {
      throw new SecretsProviderError('unavailable', 'decrypt');
    } finally {
      dataKey.fill(0);
    }
  }

  /** A signature was made: the counter never goes down. */
  async used(ownerId: string, itemId: string, signCount: number): Promise<void> {
    await this.prisma.passkeyCredential.updateMany({ where: { id: itemId, ownerUserId: ownerId, signCount: { lt: signCount } }, data: { signCount, lastUsedAt: new Date() } });
  }

  /** The owner's passkeys, newest first (E47.5). */
  async list(ownerId: string): Promise<PasskeyListItem[]> {
    return this.prisma.passkeyCredential.findMany({
      where: { ownerUserId: ownerId },
      select: { id: true, rpId: true, origin: true, userName: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Remove one of the owner's passkeys (the ciphertext goes with the row). False when it is not theirs. */
  async remove(ownerId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.passkeyCredential.deleteMany({ where: { id, ownerUserId: ownerId } });
    return count > 0;
  }
}
