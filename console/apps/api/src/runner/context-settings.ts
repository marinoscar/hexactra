/**
 * Context efficiency (#406): what the model is sent each round, and how much
 * of it is re-sent. Every knob comes from the run's policy snapshot
 * (`snapshot.spec.context`), never from a constant: the constants below are
 * only the platform's own caps.
 */
import { createHash } from 'node:crypto';

import type { AgentPolicySpec } from '../policies/agent-policy.schema';
import type { ScreenView } from './vision';

/** The platform's hard cap on round trips per `runTools` call. */
export const PLATFORM_MAX_CALLS_PER_CHUNK = 20;
/** `observe_elements` never lists more than this many elements. */
export const MAX_ELEMENTS = 80;
/** Characters one listed element costs on average (its JSON). */
export const CHARS_PER_ELEMENT = 75;

export type ContextSettings = AgentPolicySpec['context'];

/** How many elements `observe_elements` may list within `observationChars`. */
export function maxElementsFor(observationChars: number): number {
  return Math.max(1, Math.min(MAX_ELEMENTS, Math.floor(observationChars / CHARS_PER_ELEMENT)));
}

/** Chunks a run may need: a smaller chunk takes more of them for the same number of actions. */
export function chunkAllowance(maxActions: number, callsPerChunk: number): number {
  const base = Math.max(1, Math.ceil(maxActions / 4));
  return base * Math.ceil(PLATFORM_MAX_CALLS_PER_CHUNK / Math.max(1, Math.min(callsPerChunk, PLATFORM_MAX_CALLS_PER_CHUNK)));
}

/** A short digest of a screenshot: what the run record keeps instead of the image. */
export function shotHash(dataUrl: string): string {
  return createHash('sha256').update(dataUrl).digest('hex').slice(0, 12);
}

/**
 * The screenshots the model is shown, oldest first, the last being the
 * current one. Kept in process memory for the current job only: bytes are
 * never persisted (the run record gets {@link hashes}). After a job hop or a
 * handoff the window restarts with the current screenshot.
 *
 * Batch pruning: the window fills up to `kept` images. After that only the
 * newest slot is replaced, so the older images, and with them the prompt
 * prefix up to the last image, stay byte-identical from one chunk to the next
 * and provider prompt caching keeps hitting. Once the window has been stable
 * for `pruneBatch` chunks it is trimmed to the current screenshot alone and
 * refills. `kept` 0 turns screenshots off.
 */
export class ScreenshotWindow {
  private views: ScreenView[] = [];
  private stable = 0;

  constructor(
    private readonly kept: number,
    private readonly pruneBatch: number,
  ) {}

  get enabled(): boolean {
    return this.kept > 0;
  }

  /** Add the screenshot taken at the start of a chunk; returns the images to send. */
  push(view: ScreenView): ScreenView[] {
    if (this.kept <= 0) return [];
    if (this.views.length < this.kept) {
      this.views.push(view);
      return this.images;
    }
    if (this.stable >= this.pruneBatch) {
      this.views = [view];
      this.stable = 0;
      return this.images;
    }
    // Full: keep the older images byte for byte, replace only the newest slot.
    this.views[this.views.length - 1] = view;
    this.stable += 1;
    return this.images;
  }

  get images(): ScreenView[] {
    return [...this.views];
  }

  /** Digests of the images in the window, oldest first. */
  get hashes(): string[] {
    return this.views.map((v) => shotHash(v.dataUrl));
  }
}

/** A rough size of text in model tokens (about 4 characters each), for the measurement only. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
