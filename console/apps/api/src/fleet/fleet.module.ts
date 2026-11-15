import { Module } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';

/** Fleet management over the fabric: hosts, enrollment, drain, profiles. */
@Module({
  imports: [FabricModule],
  controllers: [FleetController],
  providers: [FleetService],
  exports: [FleetService],
})
export class FleetModule {}
