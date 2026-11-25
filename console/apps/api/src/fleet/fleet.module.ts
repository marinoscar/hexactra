import { Module } from '@nestjs/common';

import { FabricModule } from '../fabric/fabric.module';
import { DesktopViewerController } from './desktop-viewer.controller';
import { ViewerSessionsSweepHandler, ViewerSessionsSweepTask } from './desktop-viewer.jobs';
import { DesktopViewerService } from './desktop-viewer.service';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';
import { ProfileSigninController } from './profile-signin.controller';
import { ProfileSigninExpireHandler, ProfileSigninExpireTask } from './profile-signin.jobs';
import { ProfileSigninService } from './profile-signin.service';

/** Fleet management over the fabric: hosts, enrollment, drain, profiles, the remote desktop and guided profile sign-in. */
@Module({
  imports: [FabricModule],
  controllers: [FleetController, DesktopViewerController, ProfileSigninController],
  providers: [FleetService, DesktopViewerService, ViewerSessionsSweepHandler, ViewerSessionsSweepTask, ProfileSigninService, ProfileSigninExpireHandler, ProfileSigninExpireTask],
  exports: [FleetService],
})
export class FleetModule {}
