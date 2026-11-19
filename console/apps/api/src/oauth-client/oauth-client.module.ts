import { Module } from '@nestjs/common';

import { OAuthClientService } from './oauth-client.service';
import { OutboundHttp, PinnedOutboundHttp } from './outbound-http';

/**
 * An OAuth 2.1 client toward a provider the owner connects (E37.2: Vault; E39: Google and Microsoft reuse it):
 * PKCE, discovery, code exchange, refresh, revoke, over an SSRF-guarded outbound transport. No routes and no
 * state of its own: the feature that connects keeps its state, verifier and tokens.
 */
@Module({
  providers: [{ provide: OutboundHttp, useClass: PinnedOutboundHttp }, OAuthClientService],
  exports: [OutboundHttp, OAuthClientService],
})
export class OAuthClientModule {}
