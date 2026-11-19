// The fake website of a scenario (E38.6): a small state machine behind the browser port. It answers the actions the browser tools send
// (`navigate`, `elements`, `text`, `click`, `type`, ...) from the scenario's pages, keeps the site's state, and records everything the
// invariants need: which actions reached the browser, which pages were opened, which commit-class elements were activated and whether
// the owner had pressed Stop or Pause at the time. It is deterministic and never touches a network.
import type { ActionOp, BrowserPort } from '../browser/browser-port';
import type { Screen, ScreenMark, ScreenView, TraceShot } from '../browser/vision';
import type { Scenario, SiteElement, SitePage } from './scenario.schema';

export interface SiteAction {
  /** Order in which the action reached the browser (1-based). */
  n: number;
  type: string;
  url: string;
  /** The owner had pressed Stop / Pause when the action arrived (the kit's own truth, not the harness's flag). */
  afterStop: boolean;
  whilePaused: boolean;
}

export interface SiteActivation {
  n: number;
  elementId: string;
  label: string;
  commit: string | null;
  url: string;
}

export interface SiteNavigation {
  n: number;
  url: string;
  host: string;
  via: 'navigate' | 'new_tab' | 'click';
  allowed: boolean;
  /** The browser refused it (a click to a site outside the allowed ones); the run never got there. */
  blocked: boolean;
}

/** What a typed answer holds for the fabric to type: the value never passes through the harness. */
export class OwnerSecrets {
  private readonly values = new Map<string, string>();
  private readonly used = new Set<string>();
  put(handoffId: string, value: string): void {
    this.values.set(handoffId, value);
  }
  take(handoffId: string): string | null {
    if (this.used.has(handoffId) || !this.values.has(handoffId)) return null;
    this.used.add(handoffId);
    return this.values.get(handoffId)!;
  }
}

export interface SiteHooks {
  allowed(url: string): boolean;
  /** The owner's Stop / Pause as the kit knows them. */
  owner: { stopPressed: boolean; pausePressed: boolean };
  /** Called after the n-th action reached the browser (the kit presses Stop or Pause here). */
  afterAction?(n: number): void;
  /** The job dies around the click on an element with this label: `before_send` or `after_send`. */
  crash?: { when: 'before_send' | 'after_send'; label: string; die(): Promise<never> } | null;
  secrets: OwnerSecrets;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};
const withoutQuery = (url: string): string => url.replace(/[?#].*$/, '');

const ok = (result: Record<string, unknown> = {}): ActionOp => ({ id: 'op', state: 'succeeded', result });
const failed = (error: string): ActionOp => ({ id: 'op', state: 'failed', error });

export class SiteBrowser implements BrowserPort {
  url: string;
  state: Record<string, string>;
  readonly actions: SiteAction[] = [];
  readonly activations: SiteActivation[] = [];
  readonly navigations: SiteNavigation[] = [];
  private readonly history: string[] = [];
  private n = 0;

  constructor(
    private readonly scenario: Scenario,
    private readonly hooks: SiteHooks,
  ) {
    this.url = scenario.site.start;
    this.state = { ...scenario.site.state };
  }

  private page(url = this.url): SitePage {
    return this.scenario.site.pages[withoutQuery(url)] ?? { title: 'Not found', text: 'There is nothing at this address.', elements: [] };
  }

  private fill(text: string): string {
    return text.replace(/\{\{state\.([\w-]+)\}\}/g, (_m, k: string) => this.state[k] ?? '');
  }

  private element(selector: string): SiteElement | null {
    return this.page().elements.find((e) => e.selector === selector) ?? null;
  }

  private facts(el: SiteElement): Record<string, unknown> {
    return { label: this.fill(el.label), role: el.role ?? null, tag: el.tag, inputType: el.type ?? (el.tag === 'button' && el.formAction ? 'submit' : null), formAction: el.formAction ?? null };
  }

  /** Where a click, an effect or a navigation goes: records it, refuses a site outside the allowed ones. Returns the answer's blocked list. */
  private go(target: string, via: SiteNavigation['via']): { blocked: Array<{ host: string; at: string }> } {
    const absolute = /^[a-z]+:\/\//i.test(target) ? target : new URL(target, this.url).toString();
    const allowed = this.hooks.allowed(absolute);
    // The browser itself refuses a top-level navigation a click causes to a site outside the list (#508); an action the harness let through
    // (`navigate`, `new_tab`) is the harness's to have refused, so it goes ahead here and the invariant names it.
    const blocked = via === 'click' && !allowed;
    this.navigations.push({ n: this.n, url: absolute, host: hostOf(absolute), via, allowed, blocked });
    if (blocked) return { blocked: [{ host: hostOf(absolute), at: new Date(0).toISOString() }] };
    this.history.push(this.url);
    this.url = absolute;
    return { blocked: [] };
  }

  private activate(el: SiteElement): { blocked: Array<{ host: string; at: string }> } {
    this.activations.push({ n: this.n, elementId: el.id, label: this.fill(el.label), commit: el.commit ?? null, url: this.url });
    const effect = (el.on ?? []).find((e) => Object.entries(e.when ?? {}).every(([k, v]) => (this.state[k] ?? '') === v));
    if (!effect) return { blocked: [] };
    for (const [k, v] of Object.entries(effect.set ?? {})) this.state[k] = this.fill(v);
    return effect.goto ? this.go(effect.goto, 'click') : { blocked: [] };
  }

  async act(action: Record<string, unknown>): Promise<ActionOp> {
    const type = String(action.type);
    // What the server asks the page itself (the gate's reads) is not an action of the agent.
    if (type === 'evaluate' && String(action.script).startsWith('/* hexactra:describe-target */')) {
      const where = JSON.parse(/const where = (.*);/.exec(String(action.script))![1]!) as { selector?: string; x?: number; y?: number };
      const el = where.selector ? this.element(where.selector) : this.byPoint(where.x ?? 0, where.y ?? 0);
      return ok({ type: 'object', value: el ? this.facts(el) : null });
    }
    if (type === 'tabs') return ok({ tabs: [{ id: 1, active: true, url: this.url, title: this.page().title }] });
    this.n += 1;
    this.actions.push({ n: this.n, type, url: this.url, afterStop: this.hooks.owner.stopPressed, whilePaused: this.hooks.owner.pausePressed });
    try {
      return await this.perform(action, type);
    } finally {
      this.hooks.afterAction?.(this.n);
    }
  }

  private byPoint(x: number, y: number): SiteElement | null {
    const marks = this.marks();
    const hit = marks.find((m) => x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h);
    return hit ? this.element(hit.selector) : null;
  }

  private async perform(action: Record<string, unknown>, type: string): Promise<ActionOp> {
    switch (type) {
      case 'navigate':
      case 'new_tab': {
        if (typeof action.url !== 'string' || !action.url) return ok({});
        this.go(action.url, type === 'navigate' ? 'navigate' : 'new_tab');
        return ok({ url: this.url, title: this.page().title });
      }
      case 'back': {
        const previous = this.history.pop();
        if (previous) this.url = previous;
        return ok({ url: this.url, title: this.page().title });
      }
      case 'elements':
        return ok({
          elements: this.page().elements.map((e) => ({
            selector: e.selector,
            tag: e.tag,
            text: this.fill(e.label),
            ...(e.type ? { type: e.type } : {}),
            ...(e.role ? { role: e.role } : {}),
            ...(e.secret || !this.state[e.id] ? {} : { value: this.state[e.id] }),
          })),
        });
      case 'text': {
        if (typeof action.selector === 'string') {
          const el = this.element(action.selector);
          if (!el) return failed(`No element matches ${action.selector}`);
          return ok({ text: `${this.fill(el.label)}${this.state[el.id] ? `: ${el.secret ? '••••••' : this.state[el.id]}` : ''}` });
        }
        const page = this.page();
        const typed = page.elements.filter((e) => this.state[e.id] && !e.secret).map((e) => `${this.fill(e.label)}: ${this.state[e.id]}`);
        return ok({ text: [this.fill(page.text), ...typed].join('\n') });
      }
      case 'click':
      case 'click_at': {
        const el = type === 'click' ? this.element(String(action.selector)) : this.byPoint(Number(action.x), Number(action.y));
        if (!el) return failed(`No element matches ${type === 'click' ? String(action.selector) : `the point ${action.x},${action.y}`}`);
        const crash = this.hooks.crash;
        const dies = crash && this.fill(el.label) === crash.label;
        if (dies && crash.when === 'before_send') await crash.die();
        const { blocked } = this.activate(el);
        if (dies && crash.when === 'after_send') await crash.die();
        return { ...ok({}), ...(blocked.length ? { navigation_blocked: blocked } : {}) };
      }
      case 'type': {
        const el = this.element(String(action.selector));
        if (!el) return failed(`No element matches ${String(action.selector)}`);
        this.state[el.id] = String(action.text ?? '');
        return ok({});
      }
      case 'wait_for':
        return this.element(String(action.selector)) ? ok({}) : failed(`timed out waiting for ${String(action.selector)}`);
      default:
        // press, key, type_keys, scroll, hover, drag, evaluate, activate_tab, desktop actions: accepted, with no effect on the site.
        return ok({});
    }
  }

  async typeSecret(opts: { handoffId: string; selector: string }): Promise<ActionOp> {
    const value = this.hooks.secrets.take(opts.handoffId);
    if (value === null) throw new Error('secret_unavailable');
    this.n += 1;
    this.actions.push({ n: this.n, type: 'type_secret', url: this.url, afterStop: this.hooks.owner.stopPressed, whilePaused: this.hooks.owner.pausePressed });
    try {
      const el = this.element(opts.selector);
      if (!el) return failed(`No element matches ${opts.selector}`);
      this.state[el.id] = value;
      return ok({});
    } finally {
      this.hooks.afterAction?.(this.n);
    }
  }

  private marks(): ScreenMark[] {
    return this.page().elements.map((e, i) => ({ n: i + 1, selector: e.selector, tag: e.tag, role: e.role ?? undefined, text: this.fill(e.label), x: 10, y: 40 + i * 50, w: 160, h: 30 }));
  }

  async capture(screen: Screen): Promise<ScreenView> {
    // A synthetic picture: one transparent pixel. The marks are real, so click_mark works.
    return { screen, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', width: 800, height: 600, url: this.url, title: this.page().title, marks: this.marks() };
  }

  async captureTrace(): Promise<TraceShot> {
    return { bytes: Buffer.from('x'), contentType: 'image/png', masked: 0 };
  }
}
