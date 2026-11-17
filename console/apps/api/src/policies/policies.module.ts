import { Module } from '@nestjs/common';

import { ModelTiersService } from './model-tiers.service';
import { PoliciesController } from './policies.controller';
import { PoliciesService } from './policies.service';
import { PolicyModelCheck } from './policy-model-check';
import { PolicyResolver } from './policy.resolver';
import { PolicyTransferService } from './policy-transfer.service';

/**
 * Agent policies (#401): the rows and their API, the built-ins, the model pin
 * check and the resolver that picks a run's policy. The runner, the tasks and
 * the schedules import this module; it imports none of them. The AI catalogue
 * is reached lazily (`PolicyModelCheck`), so the module has no hard dependency
 * on the AI slice.
 */
@Module({
  controllers: [PoliciesController],
  providers: [PoliciesService, PolicyTransferService, PolicyModelCheck, PolicyResolver, ModelTiersService],
  exports: [PoliciesService, PolicyTransferService, PolicyResolver, PolicyModelCheck, ModelTiersService],
})
export class PoliciesModule {}
