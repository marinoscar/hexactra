import { Module } from '@nestjs/common';

import { MemoriesController } from './memories.controller';
import { MemoriesService } from './memories.service';
import { MemoryMetrics } from './memory-metrics';

/**
 * Memories (#551): the owner's saved facts, their API and export. The chat
 * and the runner (#553) import this module to read them; it imports none of
 * them.
 */
@Module({
  controllers: [MemoriesController],
  providers: [MemoriesService, MemoryMetrics],
  exports: [MemoriesService],
})
export class MemoriesModule {}
