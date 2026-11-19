// BrowserPort over the fabric session of one run.
import { FabricError, type FabricClient } from '../../fabric/fabric.client';
import { BrowserAborted, BrowserError, type ActionOp, type BrowserPort } from '@marinoscar/hexactra-browser-agent/browser-port';
import { captureScreen, captureTrace, type Screen, type ScreenView, type TraceShot } from '@marinoscar/hexactra-browser-agent/vision';
import { ACTION_TIMEOUT_MS, type FabricSession } from '../fabric-session';

/** Stop ended the wait: `BrowserAborted`; any other fabric failure keeps its message; anything else is not the fabric's and passes through. */
function asBrowserError(e: unknown): unknown {
  if (e instanceof FabricError) return e.kind === 'aborted' ? new BrowserAborted(e.message) : new BrowserError(e.message);
  return e;
}

export class FabricBrowser implements BrowserPort {
  /**
   * `ensure` opens the run's browser session on first use (E39.7): a run with connections starts without one, and the first browser call
   * (an action, a typed secret, a screenshot) opens it. It throws a `BrowserError` when no browser can be had; absent, the session exists.
   */
  constructor(
    private readonly session: FabricSession,
    private readonly fabric: FabricClient,
    private readonly sessionId: () => string,
    private readonly ensure?: () => Promise<void>,
  ) {}

  hasSession(): boolean {
    return Boolean(this.sessionId());
  }

  private async ready(): Promise<string> {
    if (!this.sessionId() && this.ensure) await this.ensure();
    return this.sessionId();
  }

  async act(action: Record<string, unknown>, timeoutMs: number = ACTION_TIMEOUT_MS, opts: { signal?: AbortSignal; waitForTakeover?: boolean } = {}): Promise<ActionOp> {
    const id = await this.ready();
    try {
      return await this.session.act(id, action, timeoutMs, opts);
    } catch (e) {
      throw asBrowserError(e);
    }
  }

  async typeSecret(opts: { handoffId: string; selector: string; clear?: boolean; submit?: boolean }): Promise<ActionOp> {
    return this.session.typeSecret(await this.ready(), opts);
  }

  async capture(screen: Screen): Promise<ScreenView> {
    return captureScreen(this.session, this.fabric, await this.ready(), screen);
  }

  async captureTrace(): Promise<TraceShot> {
    return captureTrace(this.session, this.fabric, await this.ready());
  }
}
