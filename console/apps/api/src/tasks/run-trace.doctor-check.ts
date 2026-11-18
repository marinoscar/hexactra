import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { DoctorCheckRegistry, type DoctorCheck, type DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';

import { RUN_ARTIFACT_STORE, type RunArtifactStore } from './run-delete.service';

/**
 * `runs.trace_storage` in the admin Doctor (#541): whether the masked trace
 * screenshots of runs are stored. Without the storage slice none is taken;
 * steps, questions and answers are still recorded. Read-only.
 */
@Injectable()
export class RunTraceDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'runs.trace_storage';
  readonly category = 'runs';
  readonly label = 'Run screenshots';

  constructor(
    private readonly registry: DoctorCheckRegistry,
    @Optional() @Inject(RUN_ARTIFACT_STORE) private readonly artifacts?: RunArtifactStore,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    if (!this.artifacts) return { status: 'warn', detail: 'Run screenshots are not stored: storage is disabled. Steps, questions and answers are still recorded.' };
    return { status: 'pass', detail: 'Masked screenshots of the key moments of each run are stored in object storage (about 150 kB each), under runs/<userId>/<runId>/.' };
  }
}
