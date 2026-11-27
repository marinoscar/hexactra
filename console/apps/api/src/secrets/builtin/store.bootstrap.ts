// Makes sure the built-in store has the one secret type it holds (E37.5, #594).
//
// The built-in store holds saved logins: the `Credential` system type of the Vault domain, and the keys of outside services
// the console's server calls (E50.3): the `Service Key` type. `seedVaultSystemSecretTypes` is idempotent (it converges the
// definition, never removes a field), and it is given these two definitions only, so Card, Identity, API Key and the rest are
// never created. Runs at start-up when the slice is on, so enabling the
// slice needs no separate seed step.
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { seedVaultSystemSecretTypes } from '@marinoscar/vault-api/secret-types';
import { SERVICE_KEY_TYPE_NAME, SYSTEM_SECRET_TYPES } from '@marinoscar/vault-contract/secret-types';

import { PrismaService } from '../../prisma/prisma.service';
import { STORE_SECRET_TYPE } from './store.interceptor';

@Injectable()
export class SecretsStoreBootstrap implements OnModuleInit {
  private readonly log = new Logger(SecretsStoreBootstrap.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const types = SYSTEM_SECRET_TYPES.filter((t) => t.name === STORE_SECRET_TYPE || t.name === SERVICE_KEY_TYPE_NAME);
      await seedVaultSystemSecretTypes(this.prisma, types);
    } catch (e) {
      // A database that is not migrated yet fails everything anyway; say why this one failed.
      this.log.warn(`the Credential and Service Key secret types could not be seeded (${e instanceof Error ? e.name : 'error'}): run the database migrations`);
    }
  }
}
