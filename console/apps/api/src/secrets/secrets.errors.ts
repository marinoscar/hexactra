import { registerErrorCode } from '@marinoscar/platform-api/core';

// The secrets provider error codes (E37.2, #591), registered once at module load. The platform's filter passes a
// `code` through only when it is registered for the response status. None carries a token, a URL path or a message
// from the provider.
registerErrorCode({ code: 'SECRETS_VAULT_NOT_CONFIGURED', status: 409, description: 'No Vault address, client id and client secret are set (neither the owner\'s nor the deployment default).' });
registerErrorCode({ code: 'SECRETS_VAULT_URL_REFUSED', status: 422, description: 'The Vault address is not allowed: it must be https (loopback http in development only), without a user name, and must resolve to a public address. `details.reason` names the rule.' });
registerErrorCode({ code: 'SECRETS_VAULT_DISCONNECT_FIRST', status: 409, description: 'The Vault address or client id cannot change while a connection exists: disconnect first.' });
registerErrorCode({ code: 'SECRETS_VAULT_NOT_CONNECTED', status: 409, description: 'No Vault is connected for this owner.' });
registerErrorCode({ code: 'SECRETS_VAULT_NEEDS_RECONNECT', status: 409, description: 'Vault refused the saved grant (revoked, replayed or expired): connect again.' });
registerErrorCode({ code: 'SECRETS_VAULT_UNAVAILABLE', status: 503, description: 'The Vault could not be reached or answered with an error. Nothing was changed; try again.' });
registerErrorCode({ code: 'SECRETS_VAULT_CONNECT_FAILED', status: 502, description: 'The Vault did not answer the discovery request as an OAuth server. `details.reason` is a closed code.' });
