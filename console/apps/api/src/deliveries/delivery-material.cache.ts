// Builds what the deliveries of one run need ONCE and keeps it for the run's other deliveries (E39.6, #603): the masked PDF, the JSON
// trace and the step pictures. A small in-process cache with a short life: a run's deliveries are sent within moments of each other, and a
// retry minutes later builds again. Bounded, so a burst of runs cannot hold much memory.
import { Injectable } from '@nestjs/common';

import { RunFilesService } from '../tasks/run-files.service';
import { RunMaterial } from './delivery-sender';

const MAX_RUNS = 16;
const TTL_MS = 10 * 60_000;

@Injectable()
export class DeliveryMaterialCache {
  private readonly entries = new Map<string, { at: number; material: RunMaterial }>();
  clock: () => number = () => Date.now();

  constructor(private readonly files: RunFilesService) {}

  forRun(userId: string, runId: string): RunMaterial {
    const now = this.clock();
    for (const [k, v] of this.entries) if (now - v.at > TTL_MS) this.entries.delete(k);
    const hit = this.entries.get(runId);
    if (hit) return hit.material;
    const material = new RunMaterial(this.files, userId, runId);
    this.entries.set(runId, { at: now, material });
    while (this.entries.size > MAX_RUNS) this.entries.delete(this.entries.keys().next().value as string);
    return material;
  }
}
