import { Global, Module } from '@nestjs/common';

import { SkillContext } from './skill-context';
import { SkillMetrics } from './skill-metrics';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';

/**
 * Skills (#1008): the owner's playbooks, their API, and what a run or chat reads of them. Global, so the runner and the chat get
 * `SkillContext` (an optional dependency of each) without importing it, and its routes follow the others in the OpenAPI document; it
 * imports neither. No MCP tool reads or writes a skill.
 */
@Global()
@Module({
  controllers: [SkillsController],
  providers: [SkillsService, SkillMetrics, SkillContext],
  exports: [SkillsService, SkillContext],
})
export class SkillsModule {}
