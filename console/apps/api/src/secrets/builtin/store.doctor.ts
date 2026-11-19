// The Doctor's view of the built-in store (E37.5, #594). Read-only: counts and key ids (public identifiers), never a
// key, a value or an owner.
//
//   secrets.store_key   fail: a data key is wrapped under a key the configuration no longer holds (that owner's
//                       logins cannot be read); warn: a rotation is unfinished; pass: key present, well formed, every
//                       data key wrapped under it.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DoctorCheckRegistry, type DoctorCheck, type DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';

import { SECRETS_SETTINGS_PATH } from '../secrets.doctor';
import { SecretsStoreKeys } from './store.data-keys';

@Injectable()
export class StoreKeyCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'secrets.store_key';
  readonly label = 'Built-in secrets store key';
  readonly category = 'secrets';
  readonly settingsPath = SECRETS_SETTINGS_PATH;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly keys: SecretsStoreKeys,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      const counts = await this.keys.countsByKeyId();
      const ring = this.keys.ring;
      const unreadable = Object.entries(counts).filter(([id]) => ring.keyFor(id) === null).reduce((n, [, c]) => n + c, 0);
      const stale = ring.current.id in counts ? Object.entries(counts).filter(([id]) => id !== ring.current.id).reduce((n, [, c]) => n + c, 0) : Object.values(counts).reduce((n, c) => n + c, 0);
      const data = { currentKeyId: ring.current.id, previousKeyConfigured: ring.previous !== null, dataKeys: Object.values(counts).reduce((n, c) => n + c, 0), wrappedUnderOtherKeys: stale, unreadable };
      if (unreadable > 0) {
        return {
          status: 'fail',
          detail: `${unreadable} owner key${unreadable === 1 ? ' is' : 's are'} wrapped under a store key this deployment no longer has: those owners' saved logins cannot be read.`,
          remedy: 'Restore the previous SECRETS_STORE_KEY into SECRETS_STORE_KEY_PREVIOUS and restart. Without that key the logins cannot be recovered.',
          data,
        };
      }
      if (stale > 0) {
        return {
          status: 'warn',
          detail: `A rotation is unfinished: ${stale} owner key${stale === 1 ? ' is' : 's are'} still wrapped under the previous store key.`,
          remedy: 'Run "Re-wrap" (POST /api/admin/secrets-store/rewrap); remove SECRETS_STORE_KEY_PREVIOUS once nothing is wrapped under it.',
          data,
        };
      }
      return { status: 'pass', detail: `The store key is present and well formed (id ${ring.current.id}); every owner key is wrapped under it.${ring.previous ? ' SECRETS_STORE_KEY_PREVIOUS can be removed.' : ''}`, data };
    } catch {
      return { status: 'fail', detail: 'The check could not run.' };
    }
  }
}
