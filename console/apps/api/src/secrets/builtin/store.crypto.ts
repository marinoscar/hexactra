// `VAULT_CRYPTO` for the built-in store (E37.5, #594): the envelope cipher behind Vault's synchronous crypto port.
// See store.context.ts for why the owner's key is read from the operation's scope, and store.cipher.ts for the format.
import { Injectable } from '@nestjs/common';
import type { VaultCryptoPort, VaultEncryptedData } from '@marinoscar/vault-api/ports';

import { decryptValue, encryptValue, ownerOfCiphertext, SecretsStoreCryptoError } from './store.cipher';
import { currentKeyScope } from './store.context';

@Injectable()
export class SecretsStoreCrypto implements VaultCryptoPort {
  encrypt(plaintext: string): VaultEncryptedData {
    const scope = currentKeyScope();
    if (!scope) throw new SecretsStoreCryptoError('no_context');
    const key = scope.keys.get(scope.current);
    if (!key) throw new SecretsStoreCryptoError('key_unavailable');
    return encryptValue(scope.current, key, plaintext);
  }

  decrypt(ciphertext: string, iv: string, authTag: string): string {
    const scope = currentKeyScope();
    if (!scope) throw new SecretsStoreCryptoError('no_context');
    const owner = ownerOfCiphertext(ciphertext);
    if (!owner) throw new SecretsStoreCryptoError('malformed');
    // A scope holds the keys of the owner of this operation only: a row of another owner does not decrypt.
    const key = scope.keys.get(owner);
    if (!key) throw new SecretsStoreCryptoError(owner === scope.current ? 'key_unavailable' : 'foreign_owner');
    return decryptValue(owner, key, ciphertext, iv, authTag);
  }
}
