// The credentials slice: the encrypted credential store in three tiers (the
// deployment's, a user's own, an organization's). Storage, email, notifications
// and AI keep their secrets in it, so they `require` it. It has no routes.
import type { ApiSlice } from '../slices/slice';

export const credentialsSlice: ApiSlice = {
  id: 'credentials',
  contribute: () => {
    const { APP_CREDENTIAL_PURPOSES } = require('./credential-purposes') as typeof import('./credential-purposes');
    return { credentialPurposes: APP_CREDENTIAL_PURPOSES };
  },
  // The user tiers of the app's purposes (the Vault connection's client secret and grant, E37.2): static registry,
  // so registered here, before any forRoot().
  register: () => {
    const { registerUserCredentialPurpose } = require('@marinoscar/platform-api/credentials') as typeof import('@marinoscar/platform-api/credentials');
    const { SECRETS_USER_CREDENTIAL_PURPOSES } = require('../../secrets/secrets.credentials') as typeof import('../../secrets/secrets.credentials');
    const { CONNECTION_USER_CREDENTIAL_PURPOSES } = require('../../connections/connections.credentials') as typeof import('../../connections/connections.credentials');
    for (const purpose of [...SECRETS_USER_CREDENTIAL_PURPOSES, ...CONNECTION_USER_CREDENTIAL_PURPOSES]) registerUserCredentialPurpose(purpose);
  },
  modules: () => {
    const { credentialsModules } = require('./credentials.config') as typeof import('./credentials.config');
    return credentialsModules;
  },
};
