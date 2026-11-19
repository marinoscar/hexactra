// Per-owner data keys of the built-in store (E37.5, #594): create, load (unwrap), scope, re-wrap.
//
// A data key is random, one per owner, stored ONLY wrapped under the deployment's store key
// (`secrets_store_data_keys`). It is unwrapped into memory for one operation (store.context.ts) and zeroed after.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { newDataKey, rewrapDataKey, SecretsStoreCryptoError, unwrapDataKey, wrapDataKey } from './store.cipher';
import { runInKeyScope } from './store.context';
import { StoreKeyRing } from './store.keys';

export const STORE_KEY_RING = Symbol('SECRETS_STORE_KEY_RING');

export interface RewrapResult {
  rewrapped: number;
  /** Rows wrapped under a key the configuration no longer holds (the previous key was removed too early). */
  unreadable: number;
}

@Injectable()
export class SecretsStoreKeys {
  private readonly log = new Logger(SecretsStoreKeys.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORE_KEY_RING) readonly ring: StoreKeyRing,
  ) {}

  /** The owner's data key, unwrapped (the caller zeroes it), or null when the owner has none and `create` is false. */
  async load(userId: string, opts: { create: boolean }): Promise<Buffer | null> {
    const row = await this.prisma.secretsStoreDataKey.findUnique({ where: { userId } });
    if (row) return unwrapDataKey(this.ring, userId, row.keyId, row.wrapped);
    if (!opts.create) return null;
    const dataKey = newDataKey();
    const { keyId, wrapped } = wrapDataKey(this.ring, userId, dataKey);
    try {
      await this.prisma.secretsStoreDataKey.create({ data: { userId, keyId, wrapped } });
      return dataKey;
    } catch (e) {
      // Two requests of a new owner raced: the first insert wins, use its key.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        dataKey.fill(0);
        const winner = await this.prisma.secretsStoreDataKey.findUniqueOrThrow({ where: { userId } });
        return unwrapDataKey(this.ring, userId, winner.keyId, winner.wrapped);
      }
      dataKey.fill(0);
      throw e;
    }
  }

  /**
   * Runs `fn` with the owner's data key loaded for the crypto port. `create` makes a key for an owner who has none
   * (the first save); without it an owner with no key has no secrets and `fn` runs with an empty key set.
   */
  async scope<R>(userId: string, opts: { create: boolean }, fn: () => Promise<R>): Promise<R> {
    const key = await this.load(userId, opts);
    const keys = new Map<string, Buffer>();
    if (key) keys.set(userId.toLowerCase(), key);
    return runInKeyScope({ current: userId.toLowerCase(), keys }, fn);
  }

  /** How many data keys are wrapped under a key other than the current one (the rotation backlog). */
  countStale(): Promise<number> {
    return this.prisma.secretsStoreDataKey.count({ where: { keyId: { not: this.ring.current.id } } });
  }

  /** Data keys per wrapping key id, for the Doctor (ids are not secret). */
  async countsByKeyId(): Promise<Record<string, number>> {
    const rows = await this.prisma.secretsStoreDataKey.groupBy({ by: ['keyId'], _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.keyId, r._count._all]));
  }

  /**
   * Re-wraps data keys that are not wrapped under the current store key, `limit` at a time. Each row is updated only
   * if it is still wrapped under the key it was read with, so two runs never fight and a failed row is left alone.
   */
  async rewrapStale(limit = 200): Promise<RewrapResult> {
    const rows = await this.prisma.secretsStoreDataKey.findMany({ where: { keyId: { not: this.ring.current.id } }, take: limit, orderBy: { createdAt: 'asc' } });
    let rewrapped = 0;
    let unreadable = 0;
    for (const row of rows) {
      try {
        const next = rewrapDataKey(this.ring, row.userId, row.keyId, row.wrapped);
        next.dataKey.fill(0);
        const { count } = await this.prisma.secretsStoreDataKey.updateMany({
          where: { id: row.id, keyId: row.keyId },
          data: { keyId: next.keyId, wrapped: next.wrapped, rewrappedAt: new Date() },
        });
        rewrapped += count;
      } catch (e) {
        if (!(e instanceof SecretsStoreCryptoError)) throw e;
        unreadable += 1;
        this.log.warn(`a data key could not be re-wrapped (${e.reason}); keep SECRETS_STORE_KEY_PREVIOUS until it can`);
      }
    }
    return { rewrapped, unreadable };
  }
}
