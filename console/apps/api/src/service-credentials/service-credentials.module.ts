import { Module } from '@nestjs/common';
import { CredentialsModule, OrgCredentialsModule, UserCredentialsModule } from '@marinoscar/platform-api/credentials';

import { CredentialStoreServiceCredentials } from './credential-store.binding';
import { SERVICE_CREDENTIAL_PORT } from './service-credential.port';
import { ServiceCredentialRegistry } from './service-credential.registry';
import { ServiceCredentialsController } from './service-credentials.controller';
import { ServiceCredentialsService } from './service-credentials.service';

/**
 * Service credentials (E50.2, #972): the keys of outside services the console itself calls, in three tiers (the user's own, the
 * organization's, the deployment's), behind one port. Mounted with the credentials slice (app.module.ts).
 *
 * What the next issues use: `ServiceCredentialRegistry` (a feature registers its references in `onModuleInit`) and
 * `SERVICE_CREDENTIAL_PORT` (`resolve` a key at the moment of a request; the caller wipes it). E50.3 rebinds the user tier.
 */
@Module({
  imports: [CredentialsModule, UserCredentialsModule, OrgCredentialsModule],
  controllers: [ServiceCredentialsController],
  providers: [
    ServiceCredentialRegistry,
    CredentialStoreServiceCredentials,
    { provide: SERVICE_CREDENTIAL_PORT, useExisting: CredentialStoreServiceCredentials },
    ServiceCredentialsService,
  ],
  exports: [ServiceCredentialRegistry, SERVICE_CREDENTIAL_PORT],
})
export class ServiceCredentialsModule {}
