import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { FabricModule } from '../fabric/fabric.module';
import './hexactra-alert-kinds';
import { HexactraAlertsService } from './hexactra-alerts.service';

/** The console's alert kinds and rules, on the platform alerts slice. */
@Module({
  imports: [FabricModule, ApprovalsModule],
  providers: [HexactraAlertsService],
  exports: [HexactraAlertsService],
})
export class HexactraAlertsModule {}
