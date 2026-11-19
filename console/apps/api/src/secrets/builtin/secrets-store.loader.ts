// Loads the built-in store only when the slice is on (E37.5, #594).
//
// This file imports nothing of `@marinoscar/vault-*`, Nest feature modules or Prisma, so `app.module.ts` can import it
// unconditionally. With `SECRETS_STORE_ENABLED` unset or false, `loadSecretsStoreModule` is never called and the
// module (and with it every Vault package) is never `require`d. With it on, the configuration is checked FIRST, before
// anything else is built, so a missing or malformed `SECRETS_STORE_KEY` stops the API at start-up with one clear error.
import type { Type } from '@nestjs/common';

import { isSliceEnabled } from '../../platform/slices/manifest';
import { SecretsStoreConfigError, STORE_ENABLED_ENV, StoreKeyRing, secretsStoreEnabled } from './store.keys';

export { secretsStoreEnabled };

/** Is the slice on AND mountable (it needs the credential store and notifications, like the Vault connection)? */
export function secretsStoreMounted(env: Record<string, string | undefined> = process.env): boolean {
  return secretsStoreEnabled(env) && isSliceEnabled('credentials') && isSliceEnabled('notifications');
}

/**
 * Validates the configuration and returns the module. Throws {@link SecretsStoreConfigError} naming the variable and the
 * problem, never a value.
 */
export function loadSecretsStoreModule(env: Record<string, string | undefined> = process.env): Type<unknown> {
  if (!isSliceEnabled('credentials') || !isSliceEnabled('notifications')) {
    throw new SecretsStoreConfigError(`${STORE_ENABLED_ENV}=true needs the "credentials" and "notifications" slices (packages/shared/slices.json)`);
  }
  // Throws on a missing, malformed or duplicated key. The ring is rebuilt by the module's provider; this one only checks.
  StoreKeyRing.fromEnv(env).wipe();
  /* eslint-disable @typescript-eslint/no-require-imports */
  // The packages load here, and only here. The platform range check is Vault's own (`VaultApiModule.forRoot` makes it;
  // this module does not call `forRoot`).
  const { assertSupportedPlatform } = require('@marinoscar/vault-api/core') as { assertSupportedPlatform: () => void };
  assertSupportedPlatform();
  return (require('./secrets-store.module') as { SecretsStoreModule: Type<unknown> }).SecretsStoreModule;
  /* eslint-enable @typescript-eslint/no-require-imports */
}
