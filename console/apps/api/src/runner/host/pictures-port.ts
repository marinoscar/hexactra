// PicturePort: the masked screenshots a run's trace keeps (#541). Best effort and bounded: no storage, the cap, a failure or a timeout leave the
// step without a picture and say why; the run goes on. Never the model's unmasked screenshot, never during a secret request.
import { buildObjectKey } from '@marinoscar/platform-api/storage';

import type { BrowserPort } from '@marinoscar/hexactra-browser-agent/browser-port';
import type { ReadMasking } from '@marinoscar/hexactra-browser-agent/context';
import { TraceCaptureError, type TraceNote, type TraceShot } from '@marinoscar/hexactra-browser-agent/vision';
import type { Picture, PicturePort } from '@marinoscar/hexactra-agent';
import { traceAllowed, traceKeyParts, type TraceMoment } from '../trace';
import type { HostDeps } from './deps';
import type { RunMemory } from './run-memory';

export interface PictureContext {
  d: HostDeps;
  userId: string;
  runId: string;
  memory: RunMemory;
  browser: BrowserPort;
  masking: ReadMasking;
  hasBrowser: () => boolean;
}

export function picturesPort(c: PictureContext): PicturePort {
  const { d } = c;
  return {
    async capture(moment): Promise<Picture> {
      if (!d.artifacts) return { note: 'no_storage' };
      if (!traceAllowed(moment as TraceMoment, c.memory.traceShots ?? 0)) return { note: 'capped' };
      if (!c.hasBrowser()) return { note: 'unavailable' };
      try {
        return { shot: await c.masking.covered(() => c.browser.captureTrace()) };
      } catch (e) {
        d.log.debug(`run ${c.runId}: no trace screenshot (${moment}): ${e instanceof TraceCaptureError ? e.note : 'unavailable'}`);
        return { note: e instanceof TraceCaptureError ? e.note : 'unavailable' };
      }
    },
    /** Store a picture and attach it to step `seq`, or record why there is none. */
    async attach(seq, moment, got) {
      let note: TraceNote | string | null = got.note ?? null;
      const shot = got.shot as TraceShot | undefined;
      if (shot && d.artifacts) {
        try {
          const key = buildObjectKey('run-traces', { userId: c.userId }, ...traceKeyParts(c.runId, seq, moment as TraceMoment, shot.contentType));
          await d.artifacts.put(key, shot.bytes, shot.contentType);
          c.memory.traceShots = (c.memory.traceShots ?? 0) + 1;
          await d.prisma.runStep.updateMany({ where: { runId: c.runId, seq }, data: { screenshotKey: key, screenshotMoment: moment, screenshotMasked: shot.masked, screenshotNote: null } });
          d.tasks.metrics.traceScreenshot(moment as never, 'stored', shot.bytes.length);
          return;
        } catch (e) {
          d.log.debug(`run ${c.runId}: could not store a trace screenshot (${moment}): ${e instanceof Error ? e.name : 'error'}`);
          note = 'unavailable';
        }
      }
      d.tasks.metrics.traceScreenshot(moment as never, note === 'unavailable' || note === 'masked_failed' ? 'failed' : 'skipped');
      await d.prisma.runStep.updateMany({ where: { runId: c.runId, seq }, data: { screenshotMoment: moment, screenshotNote: note } });
    },
  };
}
