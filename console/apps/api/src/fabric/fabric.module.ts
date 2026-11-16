import { Module } from '@nestjs/common';
import { CredentialsModule } from '@marinoscar/platform-api/credentials';

import { FabricAboutBinding } from './fabric.about';
import { FabricConnectService } from './fabric-connect.service';
import { FabricConnectionController } from './fabric-connection.controller';
import { FabricClient } from './fabric.client';
import { FABRIC_DOCTOR_CHECKS } from './fabric.doctor-checks';
import { FabricEgressContributor } from './fabric.egress';

/**
 * The fabric connection: the `/v1` client every console feature uses, its
 * admin routes, four Doctor checks, the egress declaration and the
 * "Hexactra Fabric" section of the About page. Exports
 * `FabricClient`.
 */
@Module({
  imports: [CredentialsModule],
  controllers: [FabricConnectionController],
  providers: [FabricClient, FabricConnectService, ...FABRIC_DOCTOR_CHECKS, FabricEgressContributor, FabricAboutBinding],
  exports: [FabricClient, FabricConnectService],
})
export class FabricModule {}
