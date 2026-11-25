// The owner's Hexactra passkeys (E47.5, #943): the list (the site, the account, when it was added and last used) and Remove. Never a
// key: the private key stays ciphertext in the built-in store and is released only to the fabric (store.callback.controller.ts).
// Another user's passkey is a 404. Removing it here stops Hexactra using it at once; the site still lists the public key until the
// owner removes it there too, which the answer says.
import { Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';

import type { StorePasskeys } from './builtin/store.passkeys';

/** The built-in store's passkey service, by token: this module never loads the store's code, which is mounted only when enabled. */
export const STORE_PASSKEYS = 'STORE_PASSKEYS';

export interface PasskeyView {
  id: string;
  site: string;
  origin: string;
  account: string;
  createdAt: string;
  lastUsedAt: string | null;
}

@ApiTags('Secrets')
@Controller('secrets/passkeys')
export class PasskeysController {
  constructor(private readonly modules: ModuleRef) {}

  /** The store's passkeys, or null when the built-in store is not mounted in this deployment (then there are none). */
  private store(): StorePasskeys | null {
    try {
      return this.modules.get<StorePasskeys>(STORE_PASSKEYS, { strict: false });
    } catch {
      return null;
    }
  }

  /** Your Hexactra passkeys, newest first. */
  @Get()
  @Auth({ permissions: ['secrets:read'] })
  async list(@CurrentUser('id') userId: string): Promise<PasskeyView[]> {
    const store = this.store();
    if (!store) return [];
    return (await store.list(userId)).map((p) => ({ id: p.id, site: p.rpId, origin: p.origin, account: p.userName, createdAt: p.createdAt.toISOString(), lastUsedAt: p.lastUsedAt?.toISOString() ?? null }));
  }

  /** Remove one of your Hexactra passkeys. Remove it on the site too: the site still lists it. */
  @Delete(':id')
  @HttpCode(200)
  @Auth({ permissions: ['secrets:write'] })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<{ removed: true; removeOnSite: true }> {
    const store = this.store();
    if (!store || !(await store.remove(userId, id))) throw new NotFoundException({ code: 'PASSKEY_NOT_FOUND', message: 'Passkey not found' });
    return { removed: true, removeOnSite: true };
  }
}
