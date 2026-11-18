// A small MCP Apps view-side bridge (#467): the `ui/*` JSON-RPC messages a
// widget exchanges with its host over `postMessage`, as the MCP Apps
// specification (2026-01-26) defines them and the SDK's `App` sends them.
//
// Why not the SDK's `App`, as the run card uses: the SDK brings the MCP
// client's protocol layer and zod with it, 238 KB minified before a widget
// has a line of its own, and the question and tasks cards have 250 KB each
// (docs/mcp-apps.md, "The bundle"). A view needs only this:
//
//   view -> host  ui/initialize (request), ui/notifications/initialized,
//                 tools/call, ui/message, ui/open-link (requests),
//                 ui/notifications/size-changed
//   host -> view  ui/notifications/tool-input, ui/notifications/tool-result,
//                 ui/notifications/host-context-changed (notifications),
//                 ping, ui/resource-teardown (requests, answered `{}`)
//
// test/lite-host.test.ts runs it against the SDK's own host side
// (`AppBridge`), so a drift from the SDK's wire format fails a test.
import type { HostBridge, HostContextLike } from './bridge';
import { MAX_MESSAGE_CHARS } from './bridge';
import type { ToolResultLike } from './text';

/** The MCP Apps protocol revision this bridge speaks (the SDK's `LATEST_PROTOCOL_VERSION`). */
export const APPS_PROTOCOL_VERSION = '2026-01-26';

/** How messages reach the host and come back: the parent window, or a test's pair. */
export interface Port {
  post(message: unknown): void;
  /** Start delivering messages from the host; returns the function that stops. */
  listen(cb: (message: unknown) => void): () => void;
}

/** The parent window as a port (only messages from it are read), or `null` outside a frame. */
export function windowPort(): Port | null {
  if (typeof window === 'undefined' || window.parent === window) return null;
  const parent = window.parent;
  return {
    post: (m) => parent.postMessage(m, '*'),
    listen(cb) {
      const on = (ev: MessageEvent) => {
        if (ev.source === parent) cb(ev.data);
      };
      window.addEventListener('message', on);
      return () => window.removeEventListener('message', on);
    },
  };
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A JSON-RPC error answer, as an Error. */
export class HostError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface LiteHostOptions<T extends string> {
  /** The only tools this widget may call. */
  allowed: readonly T[];
  /** Requests other than tools/call fail after this long (default 60 s). */
  timeoutMs?: number;
  /** Report the widget's size to the host as it changes (default true, as the SDK's `autoResize`). */
  autoResize?: boolean;
}

export class LiteHost<T extends string> implements HostBridge<T> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private ctx: HostContextLike | undefined;
  private results: ToolResultLike[] = [];
  private inputs: Record<string, unknown>[] = [];
  private resultCb: ((r: ToolResultLike) => void) | null = null;
  private inputCb: ((a: Record<string, unknown>) => void) | null = null;
  private readonly contextCbs: ((c: HostContextLike) => void)[] = [];
  private stop: (() => void) | null = null;
  private resize: (() => void) | null = null;

  constructor(
    private readonly info: { name: string; version: string },
    private readonly port: Port,
    private readonly opts: LiteHostOptions<T>,
  ) {}

  /** The handshake: `ui/initialize`, then `ui/notifications/initialized`. Rejects when no host answers. */
  async connect(): Promise<void> {
    this.stop = this.port.listen((m) => this.receive(m));
    const r = (await this.request('ui/initialize', { appInfo: this.info, appCapabilities: {}, protocolVersion: APPS_PROTOCOL_VERSION })) as { hostContext?: HostContextLike } | undefined;
    this.ctx = r?.hostContext ?? this.ctx;
    this.notify('ui/notifications/initialized', {});
    if (this.opts.autoResize !== false) this.resize = this.observeSize();
  }

  close(): void {
    this.stop?.();
    this.resize?.();
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error('closed'));
    }
    this.pending.clear();
  }

  async callTool(name: T, args: Record<string, unknown>): Promise<ToolResultLike> {
    if (!this.opts.allowed.includes(name)) throw new Error('not an allowed tool');
    // No time limit of its own: the server bounds every call (its deadline), and the host its own.
    return (await this.request('tools/call', { name, arguments: args }, null)) as ToolResultLike;
  }

  async openLink(url: string): Promise<void> {
    const r = (await this.request('ui/open-link', { url })) as { isError?: boolean } | undefined;
    if (r?.isError) throw new Error('the host did not open the link');
  }

  async sendMessage(text: string): Promise<void> {
    const t = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
    const r = (await this.request('ui/message', { role: 'user', content: [{ type: 'text', text: t }] })) as { isError?: boolean } | undefined;
    if (r?.isError) throw new Error('the host did not send the message');
  }

  hostContext(): HostContextLike | undefined {
    return this.ctx;
  }

  onToolResult(cb: (r: ToolResultLike) => void): void {
    this.resultCb = cb;
    for (const r of this.results.splice(0)) cb(r);
  }

  onToolInput(cb: (args: Record<string, unknown>) => void): void {
    this.inputCb = cb;
    for (const a of this.inputs.splice(0)) cb(a);
  }

  /** Every listener is called (the entry applies the theme; the widget keeps its own copy). */
  onHostContextChanged(cb: (c: HostContextLike) => void): void {
    this.contextCbs.push(cb);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number | null = this.opts.timeoutMs ?? 60_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: the host did not answer`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.port.post({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.port.post({ jsonrpc: '2.0', method, params });
  }

  private receive(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const m = raw as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (m.jsonrpc !== '2.0') return;
    const params = m.params && typeof m.params === 'object' ? (m.params as Record<string, unknown>) : {};
    if (typeof m.method === 'string' && (typeof m.id === 'number' || typeof m.id === 'string')) {
      // A request from the host: ping and teardown are answered; nothing else is offered.
      if (m.method === 'ping' || m.method === 'ui/resource-teardown') this.port.post({ jsonrpc: '2.0', id: m.id, result: {} });
      else this.port.post({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
      return;
    }
    if (typeof m.method === 'string') {
      switch (m.method) {
        case 'ui/notifications/tool-result':
          if (this.resultCb) this.resultCb(params as ToolResultLike);
          else this.results.push(params as ToolResultLike);
          return;
        case 'ui/notifications/tool-input': {
          const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
          if (this.inputCb) this.inputCb(args);
          else this.inputs.push(args);
          return;
        }
        case 'ui/notifications/host-context-changed':
          this.ctx = { ...this.ctx, ...(params as HostContextLike) };
          for (const cb of this.contextCbs) cb(params as HostContextLike);
          return;
        default:
          return;
      }
    }
    if (typeof m.id !== 'number') return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (p.timer) clearTimeout(p.timer);
    if (m.error) p.reject(new HostError(typeof m.error.code === 'number' ? m.error.code : -32603, typeof m.error.message === 'string' ? m.error.message : 'the host refused'));
    else p.resolve(m.result);
  }

  /** `ui/notifications/size-changed` whenever the page's size changes (the SDK's `setupSizeChangedNotifications`). */
  private observeSize(): (() => void) | null {
    if (typeof document === 'undefined' || typeof ResizeObserver === 'undefined' || typeof requestAnimationFrame === 'undefined') return null;
    let queued = false;
    let w = 0;
    let h = 0;
    const measure = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const root = document.documentElement;
        const prev = root.style.height;
        root.style.height = 'max-content';
        const height = Math.ceil(root.getBoundingClientRect().height);
        root.style.height = prev;
        const width = Math.ceil(window.innerWidth);
        if (width !== w || height !== h) {
          w = width;
          h = height;
          this.notify('ui/notifications/size-changed', { width, height });
        }
      });
    };
    measure();
    const o = new ResizeObserver(measure);
    o.observe(document.documentElement);
    o.observe(document.body);
    return () => o.disconnect();
  }
}
