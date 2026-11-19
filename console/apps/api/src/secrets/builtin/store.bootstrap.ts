// Makes sure the built-in store has the one secret type it holds (E37.5, #594).
//
// The built-in store holds saved logins: the `Credential` system type of the Vault domain. `seedVaultSystemSecretTypes`
// is idempotent (it converges the definition, never removes a field), and it is given the Credential definition only,
// so Card, Identity, API Key and the rest are never created. Runs at start-up when the slice is on, so enabling the
// slice needs no separate seed step.
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { seedVaultSystemSecretTypes } from '@marinoscar/vault-api/secret-types';
import { SYSTEM_SECRET_TYPES } from '@marinoscar/vault-contract/secret-types';

import { PrismaService } from '../../prisma/prisma.service';
import { STORE_SECRET_TYPE } from './store.interceptor';

@Injectable()
export class SecretsStoreBootstrap implements OnModuleInit {
  private readonly log = new Logger(SecretsStoreBootstrap.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const credential = SYSTEM_SECRET_TYPES.filter((t) => t.name === STORE_SECRET_TYPE);
      await seedVaultSystemSecretTypes(this.prisma, credential);
    } catch (e) {
      // A database that is not migrated yet fails everything anyway; say why this one failed.
      this.log.warn(`the Credential secret type could not be seeded (${e instanceof Error ? e.name : 'error'}): run the database migrations`);
    }
  }
}
