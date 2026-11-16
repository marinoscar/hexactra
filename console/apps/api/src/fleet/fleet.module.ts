import { Module } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';
import { DesktopViewerController } from './desktop-viewer.controller';
import { ViewerSessionsSweepHandler, ViewerSessionsSweepTask } from './desktop-viewer.jobs';
import { DesktopViewerService } from './desktop-viewer.service';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';
import { ViewerTicketService } from './viewer-ticket.service';
import { ViewerController } from './viewer.controller';

/** Fleet management over the fabric: hosts, enrollment, drain, profiles. */
@Module({
  imports: [FabricModule],
  controllers: [FleetController, ViewerController, DesktopViewerController],
  providers: [FleetService, ViewerTicketService, DesktopViewerService, ViewerSessionsSweepHandler, ViewerSessionsSweepTask],
  exports: [FleetService],
})
export class FleetModule {}
