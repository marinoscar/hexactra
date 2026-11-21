// Loads the built-in store when its key is configured (E37.5, #594; #711).
//
// Mounting is not switching on: the store is OFFERED only while the administrator's switch (system setting
// `secrets.store.enabled`, Administration → Secrets) is on. The module is mounted whenever the deployment has a store key
// (the installer generates `SECRETS_STORE_KEY`), so the switch takes effect without a restart.
//
// This file imports nothing of `@marinoscar/vault-*`, Nest feature modules or Prisma, so `app.module.ts` can import it
// unconditionally. With `SECRETS_STORE_ENABLED` unset or false, `loadSecretsStoreModule` is never called and the
// module (and with it every Vault package) is never `require`d. With it on, the configuration is checked FIRST, before
// anything else is built, so a missing or malformed `SECRETS_STORE_KEY` stops the API at start-up with one clear error.
import type { Type } from '@nestjs/common';

import { isSliceEnabled } from '../../platform/slices/manifest';
import { SecretsStoreConfigError, STORE_ENABLED_ENV, STORE_KEY_ENV, StoreKeyRing, secretsStoreEnabled, secretsStoreKeyConfigured } from './store.keys';

export { secretsStoreEnabled, secretsStoreKeyConfigured };

/** Is the store mounted: a key configured (or the deprecated switch on), and the credential store and notifications slices on? */
export function secretsStoreMounted(env: Record<string, string | undefined> = process.env): boolean {
  return (secretsStoreKeyConfigured(env) || secretsStoreEnabled(env)) && isSliceEnabled('credentials') && isSliceEnabled('notifications');
}

/**
 * Whether app.module mounts the store. A configured key mounts it (a malformed one stops the API in `loadSecretsStoreModule`).
 * The deprecated `SECRETS_STORE_ENABLED=true` without the slices it needs still stops the API with its old error; a generated
 * key without them is simply not used.
 */
export function secretsStoreMountable(env: Record<string, string | undefined> = process.env): boolean {
  if (!secretsStoreKeyConfigured(env) && !secretsStoreEnabled(env)) return false;
  if (!isSliceEnabled('credentials') || !isSliceEnabled('notifications')) {
    if (secretsStoreEnabled(env)) throw new SecretsStoreConfigError(`${STORE_ENABLED_ENV}=true needs the "credentials" and "notifications" slices (packages/shared/slices.json)`);
    return false;
  }
  return true;
}

/**
 * Validates the configuration and returns the module. Throws {@link SecretsStoreConfigError} naming the variable and the
 * problem, never a value.
 */
export function loadSecretsStoreModule(env: Record<string, string | undefined> = process.env): Type<unknown> {
  if (!isSliceEnabled('credentials') || !isSliceEnabled('notifications')) {
    throw new SecretsStoreConfigError(`the built-in store (${STORE_KEY_ENV}) needs the "credentials" and "notifications" slices (packages/shared/slices.json)`);
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
