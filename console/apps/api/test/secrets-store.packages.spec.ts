// The console's copies of what the Vault packages declare, checked against the packages (E37.5, #594). The console
// registers ownership and permissions WITHOUT importing the packages (so a slice that is off loads none of them);
// this spec is what keeps those copies honest when the packages are upgraded.
import { VAULT_MODEL_OWNERSHIP, VAULT_PERMISSIONS, VAULT_USER_OWNED_MODELS } from '@marinoscar/vault-api/core';

import { STORE_MODEL_OWNERSHIP, STORE_USER_OWNED_MODELS } from '../src/secrets/builtin/store.ownership';
import { loadSecretsStoreModule } from '../src/secrets/builtin/secrets-store.loader';
import { SECRETS_PERMISSIONS } from '../src/secrets/secrets.permissions';
import { TEST_STORE_KEY } from './support/secrets-store-env';

describe('ownership', () => {
  it('classifies every model the Vault packages own, with the same owner column', () => {
    const mine = new Map(STORE_USER_OWNED_MODELS.map((m) => [m.model as string, m]));
    for (const pkg of VAULT_USER_OWNED_MODELS) {
      const own = mine.get(pkg.model);
      expect([pkg.model, own !== undefined]).toEqual([pkg.model, true]);
      expect([pkg.model, own?.ownerField]).toEqual([pkg.model, pkg.ownerField]);
      expect([pkg.model, own?.actorFields]).toEqual([pkg.model, pkg.actorFields]);
    }
    const kinds = new Map(STORE_MODEL_OWNERSHIP.map((m) => [m.model as string, m.kind]));
    for (const pkg of VAULT_MODEL_OWNERSHIP) expect([pkg.model, kinds.get(pkg.model)]).toEqual([pkg.model, pkg.kind]);
  });

  it('differs from Vault only where documented: a console user’s secrets are removed with them', () => {
    const secret = STORE_USER_OWNED_MODELS.find((m) => m.model === 'Secret')!;
    const pkg = VAULT_USER_OWNED_MODELS.find((m) => m.model === 'Secret')!;
    expect(pkg.purge).toBe('detach');
    // 'detach' matches the package's SET NULL foreign key; the user-data manifest deletes the rows in the saved-logins category.
    expect(secret.purge).toBe('detach');
  });
});

describe('permissions', () => {
  it('declares every id the mounted Vault controllers enforce, and no `*_any`', () => {
    const declared = new Set(Object.values(SECRETS_PERMISSIONS).map((p) => p.id as string));
    const enforced = Object.values(VAULT_PERMISSIONS)
      .map((p) => p.id)
      .filter((id) => /^(secrets|secret_types):/.test(id) && !id.endsWith('_any') && id !== 'secrets:fill');
    for (const id of enforced) expect([id, declared.has(id)]).toEqual([id, true]);
    for (const id of declared) expect(id.endsWith('_any')).toBe(false);
  });
});

describe('the loader', () => {
  it('returns the module when the key is valid', () => {
    const mod = loadSecretsStoreModule({ SECRETS_STORE_ENABLED: 'true', SECRETS_STORE_KEY: TEST_STORE_KEY });
    expect(mod.name).toBe('SecretsStoreModule');
  });
});
