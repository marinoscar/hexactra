// Live updates of the run card (#466): it asks the server through the host
// (`app.callServerTool`) and never opens a connection of its own.
//
// - `run_card_poll` (an app-only tool, `visibility: ["app"]`, so polling is
//   not a model tool call) with `since` = the last cursor: `wait_s` 25 while
//   nothing moves; while the run is running and the card is visible, 5 s
//   with a screenshot (at most one picture every 5 s).
// - A host that refuses `run_card_poll` before it ever answered (a client on
//   a revision that lists no app-only tool): `run_wait` with `since` and
//   `wait_s` 25, plus `run_status { screenshot: true, steps: 0 }` at most
//   every 5 s while running.
// - Stops when the run is finished, when the card is hidden (Page
//   Visibility; it resumes when shown), when a newer card of the same run
//   takes over, and after 30 minutes ("Paused updating").
// - Errors back off 5 s, 15 s, then 60 s, and say "Reconnecting".
import type { HostBridge } from './bridge';
import { TERMINAL, snapshotOf, type Snapshot } from './model';

export const LONG_WAIT_S = 25;
export const SHOT_EVERY_MS = 5_000;
export const MAX_POLLING_MS = 30 * 60_000;
export const BACKOFF_MS = [5_000, 15_000, 60_000] as const;
/** The least time between two calls, whatever the server answered. */
export const MIN_GAP_MS = 1_000;

export type PollStatus = 'live' | 'reconnecting' | 'paused' | 'hidden' | 'stopped' | 'superseded';

export interface PollerEvents {
  snapshot(s: Snapshot): void;
  status(s: PollStatus): void;
}

export interface PollerOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class Poller {
  private runId: string;
  private cursor: string | null;
  private runStatus: string;
  private started = 0;
  private lastShot = 0;
  private lastCall = 0;
  private errors = 0;
  private mode: 'poll' | 'fallback' = 'poll';
  private pollOk = false;
  private timer: unknown = null;
  private inFlight = false;
  private visible = true;
  private superseded = false;
  private paused = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(
    private readonly host: HostBridge,
    first: Snapshot,
    private readonly events: PollerEvents,
    opts: PollerOptions = {},
  ) {
    this.runId = first.progress.run_id;
    this.cursor = first.progress.cursor || null;
    this.runStatus = first.progress.status;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    if (first.image) this.lastShot = this.now();
  }

  /** Start (or restart after "Paused updating"): a fresh 30-minute window. */
  start(): void {
    this.started = this.now();
    this.paused = false;
    this.stopped = false;
    this.errors = 0;
    this.schedule(0);
  }

  /** Follow another run in this card (after "Run again"). */
  follow(s: Snapshot): void {
    this.runId = s.progress.run_id;
    this.cursor = s.progress.cursor || null;
    this.runStatus = s.progress.status;
    this.start();
  }

  /** A result the card got some other way (Stop, the host's own push): it moves the cursor too. */
  observe(s: Snapshot): void {
    if (s.progress.run_id !== this.runId) return;
    this.cursor = s.progress.cursor || this.cursor;
    this.runStatus = s.progress.status;
    if (TERMINAL.has(this.runStatus)) this.halt('stopped');
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible) {
      this.cancelTimer();
      this.events.status('hidden');
    } else if (!this.stopped && !this.paused && !this.superseded) {
      this.events.status('live');
      this.schedule(0);
    }
  }

  setSuperseded(superseded: boolean): void {
    if (superseded === this.superseded) return;
    this.superseded = superseded;
    if (superseded) {
      this.cancelTimer();
      this.events.status('superseded');
    } else if (!this.stopped && !this.paused) {
      this.events.status('live');
      this.schedule(0);
    }
  }

  dispose(): void {
    this.stopped = true;
    this.cancelTimer();
  }

  /** Whether a poll is due now (for tests). */
  get active(): boolean {
    return !this.stopped && !this.paused && !this.superseded && this.visible;
  }

  private halt(status: PollStatus): void {
    this.cancelTimer();
    if (status === 'paused') this.paused = true;
    else this.stopped = true;
    this.events.status(status);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    if (!this.active || TERMINAL.has(this.runStatus)) return;
    const gap = Math.max(ms, this.lastCall + MIN_GAP_MS - this.now(), 0);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, gap);
  }

  private async tick(): Promise<void> {
    if (!this.active || this.inFlight) return;
    if (TERMINAL.has(this.runStatus)) return this.halt('stopped');
    if (this.now() - this.started >= MAX_POLLING_MS) return this.halt('paused');
    this.inFlight = true;
    this.lastCall = this.now();
    const runId = this.runId;
    try {
      const snap = this.mode === 'poll' ? await this.viaPoll() : await this.viaFallback();
      if (runId !== this.runId) return; // the card moved on to another run meanwhile
      if (this.errors > 0) this.events.status('live');
      this.errors = 0;
      this.cursor = snap.progress.cursor || this.cursor;
      this.runStatus = snap.progress.status;
      this.events.snapshot(snap);
      if (TERMINAL.has(this.runStatus)) return this.halt('stopped');
      this.schedule(0);
    } catch {
      if (runId !== this.runId) return;
      if (this.mode === 'poll' && !this.pollOk) {
        // The host or server does not offer the app-only tool: follow with the model-visible ones.
        this.mode = 'fallback';
        this.schedule(0);
        return;
      }
      const wait = BACKOFF_MS[Math.min(this.errors, BACKOFF_MS.length - 1)]!;
      this.errors += 1;
      this.events.status('reconnecting');
      this.schedule(wait);
    } finally {
      this.inFlight = false;
    }
  }

  private shotDue(): boolean {
    return this.runStatus === 'running' && this.visible && this.now() - this.lastShot >= SHOT_EVERY_MS;
  }

  private args(waitS: number, screenshot: boolean): Record<string, unknown> {
    return { run_id: this.runId, wait_s: waitS, screenshot, ...(this.cursor ? { since: this.cursor } : {}) };
  }

  private async viaPoll(): Promise<Snapshot> {
    const running = this.runStatus === 'running';
    const shot = running && this.shotDue();
    const r = await this.host.callTool('run_card_poll', this.args(running ? SHOT_EVERY_MS / 1000 : LONG_WAIT_S, shot));
    const s = snapshotOf(r);
    if (!s) throw new Error('run_card_poll answered no progress');
    this.pollOk = true;
    if (shot) this.lastShot = this.now();
    return s;
  }

  private async viaFallback(): Promise<Snapshot> {
    if (this.shotDue()) {
      const r = await this.host.callTool('run_status', { run_id: this.runId, steps: 0, screenshot: true });
      const s = snapshotOf(r);
      if (!s) throw new Error('run_status answered no progress');
      this.lastShot = this.now();
      // run_status has no `since`: keep the cursor the waits use.
      return { ...s, progress: { ...s.progress, cursor: this.cursor ?? s.progress.cursor } };
    }
    const running = this.runStatus === 'running';
    const r = await this.host.callTool('run_wait', this.args(running ? SHOT_EVERY_MS / 1000 : LONG_WAIT_S, false));
    const s = snapshotOf(r);
    if (!s) throw new Error('run_wait answered no progress');
    return s;
  }
}
