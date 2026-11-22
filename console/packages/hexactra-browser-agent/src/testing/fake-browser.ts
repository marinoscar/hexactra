// A scriptable fake of the browser, and a BrowserExt over it: what the browser tools' unit tests run on (E38.5). It answers each action type from
// a table the test fills, records every action it was sent, and never touches a network.
import { fakeRun, type FakeRun, type FakeRunOptions } from '@marinoscar/hexactra-agent/testing';
import { ScreenshotWindow } from '../context-settings';
import { type ActionOp, type BrowserPort } from '../browser-port';
import { NO_MASKING, type BrowserContext, type BrowserExt, type BrowserMemory } from '../context';
import { riskGate } from '../gates/risk-gate';
import { siteGate } from '../gates/site-gate';
import { domainAllowed } from '../policy';
import type { Screen, ScreenView, TraceShot } from '../vision';

export class FakeBrowser implements BrowserPort {
  /** Every action sent, oldest first. */
  actions: Record<string, unknown>[] = [];
  /** What each action type answers (`result` of a succeeded operation); an unlisted type succeeds with `{}`. */
  results = new Map<string, Record<string, unknown>>();
  /** What the page says about a click target: by selector, or by point as "x,y". */
  targets = new Map<string, Record<string, unknown> | null>();
  url = 'https://shop.example.test/checkout';
  /** What the surface queries list (E46.13): the page's controls, with their selector candidates. */
  surface: Record<string, unknown>[] = [];
  /** The next `act` fails with this state instead of succeeding. */
  failNext: { state: ActionOp['state']; error: string } | null = null;

  async act(action: Record<string, unknown>): Promise<ActionOp> {
    if (action.type === 'evaluate' && String(action.script).startsWith('/* hexactra:describe-target */')) {
      const where = JSON.parse(/const where = (.*);/.exec(String(action.script))![1]!) as { selector?: string; x?: number; y?: number };
      return { id: 'op', state: 'succeeded', result: { type: 'object', value: this.targets.get(where.selector ?? `${where.x},${where.y}`) ?? null } };
    }
    if (action.type === 'evaluate' && String(action.script).startsWith('/* hexactra:surface-elements */')) return { id: 'op', state: 'succeeded', result: { type: 'object', value: this.surface } };
    if (action.type === 'evaluate' && String(action.script).startsWith('/* hexactra:surface-describe */')) {
      const where = JSON.parse(/const where = (.*);/.exec(String(action.script))![1]!) as { selector?: string; x?: number; y?: number };
      const hit = this.surface.find((e) => (where.selector ? e.selector === where.selector || (e.selectors as string[] | undefined)?.includes(where.selector) : e.at === `${where.x},${where.y}`));
      return { id: 'op', state: 'succeeded', result: { type: 'object', value: hit ?? null } };
    }
    this.actions.push(action);
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return { id: 'op', state: f.state, error: f.error };
    }
    if (action.type === 'tabs') return { id: 'op', state: 'succeeded', result: this.results.get('tabs') ?? { tabs: [{ id: 1, active: true, url: this.url, title: 'Page' }] } };
    return { id: 'op', state: 'succeeded', result: this.results.get(String(action.type)) ?? {} };
  }
  async typeSecret(opts: { handoffId: string; selector: string }): Promise<ActionOp> {
    this.actions.push({ type: 'type_secret', handoff_id: opts.handoffId, selector: opts.selector });
    return { id: 'op', state: 'succeeded', result: {} };
  }
  async capture(screen: Screen): Promise<ScreenView> {
    return { screen, dataUrl: 'data:image/jpeg;base64,AAAA', width: 800, height: 600, url: this.url, title: 'Page', marks: [] };
  }
  async captureTrace(): Promise<TraceShot> {
    return { bytes: Buffer.from('x'), contentType: 'image/jpeg', masked: 0 };
  }
}

export interface FakeBrowserRunOptions extends FakeRunOptions<BrowserExt> {
  browser?: FakeBrowser;
  allowedDomains?: string[];
  confirmRisky?: boolean;
  memory?: Partial<BrowserMemory>;
}

/** A browser context over the fakes: the fake run, a fake browser, the site list and the two gates ready. */
export function fakeBrowserRun(options: FakeBrowserRunOptions = {}): FakeRun<BrowserExt> & { ctx: BrowserContext; browser: FakeBrowser; gates: [typeof siteGate, typeof riskGate] } {
  const browser = options.browser ?? new FakeBrowser();
  const allowed = options.allowedDomains ?? [];
  const ext: BrowserExt = {
    browser,
    sites: { allowed: (url) => domainAllowed(url, allowed), text: allowed.join(', ') },
    state: { labels: new Map(), marks: new Map(), view: null },
    shotWindow: new ScreenshotWindow(2, 5),
    observationChars: 4_000,
    confirmRisky: () => options.confirmRisky ?? false,
    sensitiveParams: () => [],
    masking: NO_MASKING,
    hooks: {},
    outputs: null,
  };
  const run = fakeRun<BrowserExt>({ ...options, ext });
  return { ...run, ctx: run.ctx as BrowserContext, browser, gates: [siteGate, riskGate] };
}
