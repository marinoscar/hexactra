// BrowserPort over the fabric session of one run.
import { FabricError, type FabricClient } from '../../fabric/fabric.client';
import { BrowserAborted, BrowserError, type ActionOp, type BrowserPort } from '../browser/browser-port';
import { captureScreen, captureTrace, type Screen, type ScreenView, type TraceShot } from '../browser/vision';
import { ACTION_TIMEOUT_MS, type FabricSession } from '../fabric-session';

/** Stop ended the wait: `BrowserAborted`; any other fabric failure keeps its message; anything else is not the fabric's and passes through. */
function asBrowserError(e: unknown): unknown {
  if (e instanceof FabricError) return e.kind === 'aborted' ? new BrowserAborted(e.message) : new BrowserError(e.message);
  return e;
}

export class FabricBrowser implements BrowserPort {
  constructor(
    private readonly session: FabricSession,
    private readonly fabric: FabricClient,
    private readonly sessionId: () => string,
  ) {}

  async act(action: Record<string, unknown>, timeoutMs: number = ACTION_TIMEOUT_MS, opts: { signal?: AbortSignal; waitForTakeover?: boolean } = {}): Promise<ActionOp> {
    try {
      return await this.session.act(this.sessionId(), action, timeoutMs, opts);
    } catch (e) {
      throw asBrowserError(e);
    }
  }

  async typeSecret(opts: { handoffId: string; selector: string; clear?: boolean; submit?: boolean }): Promise<ActionOp> {
    return this.session.typeSecret(this.sessionId(), opts);
  }

  capture(screen: Screen): Promise<ScreenView> {
    return captureScreen(this.session, this.fabric, this.sessionId(), screen);
  }

  captureTrace(): Promise<TraceShot> {
    return captureTrace(this.session, this.fabric, this.sessionId());
  }
}
