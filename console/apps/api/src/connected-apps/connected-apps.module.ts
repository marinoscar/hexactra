import { Global, Module } from '@nestjs/common';

import { PoliciesModule } from '../policies/policies.module';
import { ConnectedAppsController } from './connected-apps.controller';
import { AppGrantNotifyHandler, ConnectedAppsGrantListener } from './connected-apps.jobs';
import { ConnectedAppsPreflight } from './connected-apps.preflight';
import { ConnectedAppsService } from './connected-apps.service';
import { RequestClientService } from './request-client';

/**
 * Connected AI apps (#464). Global: the services that start runs, sessions and
 * questions (tasks, runner, browser, questions, schedules, chat) read the
 * request's client context and check the app's limits through it.
 */
@Global()
@Module({
  imports: [PoliciesModule],
  controllers: [ConnectedAppsController],
  providers: [RequestClientService, ConnectedAppsService, ConnectedAppsPreflight, ConnectedAppsGrantListener, AppGrantNotifyHandler],
  exports: [RequestClientService, ConnectedAppsService],
})
export class ConnectedAppsModule {}
