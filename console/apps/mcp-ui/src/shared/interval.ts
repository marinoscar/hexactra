// A widget's periodic refresh (#467): one call every `everyMs` while the
// widget is visible and the tick says there is still something to follow,
// backing off 5 s, 15 s, then 60 s after errors ("Reconnecting"), and
// stopping when hidden (Page Visibility) or superseded. Calls go through the
// host; the widget never opens a connection of its own. (The run card has
// its own long-polling follower, src/poller.ts, with the same back-off.)

export const BACKOFF_MS = [5_000, 15_000, 60_000] as const;

export type IntervalStatus = 'live' | 'reconnecting' | 'hidden' | 'stopped' | 'superseded';

export interface IntervalOptions {
  everyMs: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class IntervalPoller {
  private timer: unknown = null;
  private errors = 0;
  private visible = true;
  private superseded = false;
  private running = false;
  private inFlight = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  /** `tick` refreshes once and answers whether to keep going (false: nothing left to follow). */
  constructor(
    private readonly tick: () => Promise<boolean>,
    private readonly onStatus: (s: IntervalStatus) => void,
    private readonly opts: IntervalOptions,
  ) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Start (or keep) following: the first call after `everyMs`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.errors = 0;
    this.schedule(this.opts.everyMs);
  }

  stop(): void {
    this.running = false;
    this.cancel();
    this.onStatus('stopped');
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    if (!v) {
      this.cancel();
      if (this.running) this.onStatus('hidden');
    } else if (this.running && !this.superseded) {
      this.onStatus('live');
      this.schedule(0);
    }
  }

  setSuperseded(v: boolean): void {
    if (v === this.superseded) return;
    this.superseded = v;
    if (v) {
      this.cancel();
      this.onStatus('superseded');
    } else if (this.running && this.visible) {
      this.onStatus('live');
      this.schedule(0);
    }
  }

  get active(): boolean {
    return this.running && this.visible && !this.superseded;
  }

  dispose(): void {
    this.running = false;
    this.cancel();
  }

  private cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.cancel();
    if (!this.active) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  private async run(): Promise<void> {
    if (!this.active || this.inFlight) return;
    this.inFlight = true;
    try {
      const more = await this.tick();
      if (this.errors > 0) this.onStatus('live');
      this.errors = 0;
      if (!more) {
        this.running = false;
        this.onStatus('stopped');
        return;
      }
      this.schedule(this.opts.everyMs);
    } catch {
      const wait = BACKOFF_MS[Math.min(this.errors, BACKOFF_MS.length - 1)]!;
      this.errors += 1;
      this.onStatus('reconnecting');
      this.schedule(wait);
    } finally {
      this.inFlight = false;
    }
  }
}

/** Whether the page is visible now (Page Visibility; visible when unknown). */
export function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}
