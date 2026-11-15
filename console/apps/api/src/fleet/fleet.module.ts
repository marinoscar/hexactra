import { Module } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';
import { ViewerTicketService } from './viewer-ticket.service';
import { ViewerController } from './viewer.controller';

/** Fleet management over the fabric: hosts, enrollment, drain, profiles. */
@Module({
  imports: [FabricModule],
  controllers: [FleetController, ViewerController],
  providers: [FleetService, ViewerTicketService],
  exports: [FleetService],
})
export class FleetModule {}
