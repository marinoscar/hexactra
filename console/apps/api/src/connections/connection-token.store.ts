// Where a connection's secrets live (E39.2, #599): the encrypted per-user credential store, never a column of `connections`.
// Three kinds of entry under purpose `connection_token`: the refresh token, the cached access token and the PKCE verifier of a
// flow in progress. Every method that returns plaintext is for server-side use at the moment of use: never return one from a
// controller, never log one.
import { Injectable } from '@nestjs/common';
import { UserCredentialsService } from '@marinoscar/platform-api/credentials';

import { CONNECTION_TOKEN_PURPOSE, accessTokenName, flowVerifierName, refreshTokenName } from './connections.credentials';

@Injectable()
export class ConnectionTokenStore {
  constructor(private readonly users: UserCredentialsService) {}

  refreshToken(userId: string, connectionId: string): Promise<string | null> {
    return this.users.getSecret(userId, CONNECTION_TOKEN_PURPOSE, refreshTokenName(connectionId));
  }

  accessToken(userId: string, connectionId: string): Promise<string | null> {
    return this.users.getSecret(userId, CONNECTION_TOKEN_PURPOSE, accessTokenName(connectionId));
  }

  /** The NEW refresh token is stored (replacing the old) before anything uses the new access token. */
  setRefreshToken(userId: string, connectionId: string, token: string): Promise<void> {
    return this.users.setSecret(userId, CONNECTION_TOKEN_PURPOSE, refreshTokenName(connectionId), token);
  }

  setAccessToken(userId: string, connectionId: string, token: string): Promise<void> {
    return this.users.setSecret(userId, CONNECTION_TOKEN_PURPOSE, accessTokenName(connectionId), token);
  }

  /** Deletes both tokens of a connection (removal, a grant that is gone). Idempotent. */
  async clearTokens(userId: string, connectionId: string): Promise<void> {
    await this.users.deleteSecret(userId, CONNECTION_TOKEN_PURPOSE, refreshTokenName(connectionId));
    await this.users.deleteSecret(userId, CONNECTION_TOKEN_PURPOSE, accessTokenName(connectionId));
  }

  setVerifier(userId: string, flowId: string, verifier: string): Promise<void> {
    return this.users.setSecret(userId, CONNECTION_TOKEN_PURPOSE, flowVerifierName(flowId), verifier);
  }

  verifier(userId: string, flowId: string): Promise<string | null> {
    return this.users.getSecret(userId, CONNECTION_TOKEN_PURPOSE, flowVerifierName(flowId));
  }

  clearVerifier(userId: string, flowId: string): Promise<void> {
    return this.users.deleteSecret(userId, CONNECTION_TOKEN_PURPOSE, flowVerifierName(flowId));
  }
}
