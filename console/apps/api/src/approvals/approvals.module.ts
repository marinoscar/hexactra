import { Module } from '@nestjs/common';

import { ApprovalMetrics } from './approval-metrics';
import { ApprovalRulesController } from './approval-rules.controller';
import { ApprovalRulesService } from './approval-rules.service';

/**
 * Saved approvals (#554): the rules, their matching and the owner's page API. The runner
 * and the question answer handler (#555) import it; it imports none of them.
 */
@Module({
  controllers: [ApprovalRulesController],
  providers: [ApprovalRulesService, ApprovalMetrics],
  exports: [ApprovalRulesService],
})
export class ApprovalsModule {}
