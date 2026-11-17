import { Module } from '@nestjs/common';

import { FleetModule } from '../fleet/fleet.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

/** The Home summary (#430): one read over the user's questions, runs, schedules and the fleet. */
@Module({
  imports: [FleetModule],
  controllers: [HomeController],
  providers: [HomeService],
  exports: [HomeService],
})
export class HomeModule {}
