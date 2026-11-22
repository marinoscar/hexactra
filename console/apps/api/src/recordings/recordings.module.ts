import { Module } from '@nestjs/common';

import { TasksModule } from '../tasks/tasks.module';
<<<<<<< HEAD
import { RecordingLinkController, RunRecordingController } from './recordings.controller';
=======
>>>>>>> origin/main
import { RecordingsFinalizeHandler, RecordingsFinalizeTask } from './recordings.jobs';
import { RecordingsService } from './recordings.service';

/** Run recordings (epic #755, docs/recordings.md): the finalize job, and (E45.5, E45.6) playback and retention. */
@Module({
  imports: [TasksModule],
<<<<<<< HEAD
  controllers: [RunRecordingController, RecordingLinkController],
=======
>>>>>>> origin/main
  providers: [RecordingsService, RecordingsFinalizeHandler, RecordingsFinalizeTask],
  exports: [RecordingsService],
})
export class RecordingsModule {}
