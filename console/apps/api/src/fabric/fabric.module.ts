import { Module } from '@nestjs/common';
import { CredentialsModule } from '@marinoscar/platform-api/credentials';

import { FabricConnectService } from './fabric-connect.service';
import { FabricConnectionController } from './fabric-connection.controller';
import { FabricClient } from './fabric.client';
import { FABRIC_DOCTOR_CHECKS } from './fabric.doctor-checks';
import { FabricEgressContributor } from './fabric.egress';

/**
 * The fabric connection: the `/v1` client every console feature uses, its
 * admin routes, four Doctor checks and the egress declaration. Exports
 * `FabricClient`.
 */
@Module({
  imports: [CredentialsModule],
  controllers: [FabricConnectionController],
  providers: [FabricClient, FabricConnectService, ...FABRIC_DOCTOR_CHECKS, FabricEgressContributor],
  exports: [FabricClient, FabricConnectService],
})
export class FabricModule {}
