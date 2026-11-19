/**
 * What the agent sees (epic #366). A person at the computer looks at the
 * screen; the goal runner gives the model the same view: a screenshot of the
 * page with the interactive elements boxed and numbered, or of the node's
 * whole desktop, at the start of every model round.
 *
 * Platform tool outputs are text only (seam request
 * marinoscar/EnterpriseAppBase#1175), so an image travels in the next
 * round's input as an `image` content part (a `data:` URL, which every
 * provider adapter maps).
 */
import type { ActionOp } from './browser-port';

/** What `captureScreen` needs of a browser session: the action call. The fabric session satisfies it. */
export interface ActSession {
  act(sessionId: string, action: Record<string, unknown>, timeoutMs?: number, opts?: { waitForTakeover?: boolean; signal?: AbortSignal }): Promise<ActionOp>;
}

/** What it needs to fetch an image the browser host stored as an artifact. The fabric client satisfies it. */
export interface ArtifactFetcher {
  raw(method: 'GET', path: string, opts?: { retries?: number }): Promise<Response>;
}

/** An interactive element the page screenshot numbered (CSS pixels). */
export interface ScreenMark {
  n: number;
  selector: string;
  tag?: string;
  role?: string;
  text?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Screen = 'page' | 'desktop';

/** One look at a screen. */
export interface ScreenView {
  screen: Screen;
  dataUrl: string;
  width: number | null;
  height: number | null;
  url: string | null;
  title: string | null;
  marks: ScreenMark[];
}

/** The `input` of a model round: text, or one user message with the screenshots as image parts. */
export type RoundInput = string | { type: 'message'; role: 'user'; content: ({ type: 'text'; text: string } | { type: 'image'; url: string; detail: 'high' })[] }[];

/** Marks listed for the model with at most this many entries. */
export const MAX_MARKS_LISTED = 120;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The marks of a screenshot result, keeping only well-formed ones. */
export function parseMarks(raw: unknown): ScreenMark[] {
  if (!Array.isArray(raw)) return [];
  const out: ScreenMark[] = [];
  for (const m of raw as Record<string, unknown>[]) {
    const n = num(m?.n);
    const x = num(m?.x);
    const y = num(m?.y);
    const w = num(m?.w);
    const h = num(m?.h);
    if (n === null || x === null || y === null || w === null || h === null || typeof m.selector !== 'string') continue;
    out.push({ n, selector: m.selector, x, y, w, h, tag: str(m.tag) ?? undefined, role: str(m.role) ?? undefined, text: str(m.text) ?? undefined });
  }
  return out;
}

/** The center of a mark: where a person would click it. */
export function markCenter(m: ScreenMark): { x: number; y: number } {
  return { x: Math.round(m.x + m.w / 2), y: Math.round(m.y + m.h / 2) };
}

/**
 * Take a screenshot through the fabric and return it as a `data:` URL. The
 * fabric moves image bytes to its artifact store, so they are fetched by
 * handle (inline `data` is used when present).
 */
export async function captureScreen(session: ActSession, fabric: ArtifactFetcher, sessionId: string, screen: Screen): Promise<ScreenView> {
  const op = await session.act(sessionId, screen === 'page' ? { type: 'screenshot', marks: true } : { type: 'desktop_screenshot' }, 30_000);
  if (op.state !== 'succeeded') throw new Error(op.error ?? `the screenshot ${op.state}`);
  const r = op.result ?? {};
  let mime = str(r.mime) ?? 'image/jpeg';
  let base64 = str(r.data);
  if (!base64) {
    const artifactId = str(r.artifact_id);
    if (!artifactId) throw new Error('the screenshot has no image');
    const res = await fabric.raw('GET', `/v1/artifacts/${artifactId}`, { retries: 1 });
    mime = res.headers.get('content-type') ?? mime;
    base64 = Buffer.from(await res.arrayBuffer()).toString('base64');
  }
  return {
    screen,
    dataUrl: `data:${mime};base64,${base64}`,
    width: num(r.width),
    height: num(r.height),
    url: str(r.url),
    title: str(r.title),
    marks: parseMarks(r.marks),
  };
}

/** The text that comes with a screenshot: what it is and what is numbered on it. */
export function describeView(v: ScreenView): string {
  const size = v.width && v.height ? ` (${v.width}×${v.height})` : '';
  if (v.screen === 'desktop') {
    return `Attached: a screenshot of the whole desktop${size}. Coordinates are screen pixels for the desktop_* tools.`;
  }
  const lines = [
    `Attached: a screenshot of the page${size}${v.url ? ` at ${v.url}` : ''}${v.title ? ` — ${v.title}` : ''}. ` +
      'Coordinates are CSS pixels of the viewport, as click_at takes them. Numbered boxes mark interactive elements (click_mark n).',
  ];
  if (v.marks.length) {
    lines.push('Marks:');
    for (const m of v.marks.slice(0, MAX_MARKS_LISTED)) {
      const c = markCenter(m);
      const label = m.text ? ` "${m.text.slice(0, 60)}"` : '';
      lines.push(`[${m.n}] ${m.role ?? m.tag ?? 'element'}${label} at ${c.x},${c.y} — ${m.selector.slice(0, 120)}`);
    }
  }
  return lines.join('\n');
}

/**
 * A round's input, stable parts first (#406): `text` (goal, allowed sites, step
 * log), then the screenshots oldest first with the current one last, then the
 * volatile tail (what the current screenshot shows, and the budget status).
 * A prefix that does not change between rounds is what provider prompt caching
 * matches, so nothing that changes every round goes before an image.
 *
 * `views` is the window the caller chose to show: one view, several (the
 * last is the current one) or none (text only).
 */
export function roundInput(text: string, views: ScreenView | ScreenView[] | null, status = ''): RoundInput {
  const list = views === null ? [] : Array.isArray(views) ? views : [views];
  if (!list.length) return (status ? `${text}\n\n${status}` : text) as RoundInput;
  const current = list[list.length - 1]!;
  const intro = list.length > 1 ? `${text}\n\nScreenshots follow, oldest first; the last one is the current screen.` : text;
  const tail = [describeView(current), status].filter(Boolean).join('\n\n');
  return [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'text', text: intro },
        ...list.map((v) => ({ type: 'image', url: v.dataUrl, detail: 'high' })),
        { type: 'text', text: tail },
      ],
    },
  ] as RoundInput;
}

/** A masked trace screenshot (#541): the image the trace keeps, never the model's unmasked one. */
export interface TraceShot {
  bytes: Buffer;
  contentType: string;
  /** Regions the extension covered. */
  masked: number;
}

/** Why a key moment has no picture (#541). */
export type TraceNote = 'unavailable' | 'masked_failed' | 'no_storage' | 'capped';

/** How long a trace capture may take before the run goes on without it. */
export const TRACE_CAPTURE_TIMEOUT_MS = 10_000;

/**
 * One masked screenshot of the page for the run's trace (#541): the fabric
 * `screenshot` action with `mask: true` and no marks; the extension covers
 * password and code fields and text that looks like a card, account or
 * identity number before the picture is taken. Throws `mask_unavailable`
 * (as `TraceCaptureError('masked_failed')`) when the page cannot be masked:
 * there is never an unmasked fallback.
 */
export async function captureTrace(session: ActSession, fabric: ArtifactFetcher, sessionId: string, timeoutMs = TRACE_CAPTURE_TIMEOUT_MS): Promise<TraceShot> {
  let op;
  try {
    // Bounded: a slow page or a busy host never holds the run up for more than the timeout.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('trace capture timed out')), timeoutMs);
    });
    try {
      op = await Promise.race([session.act(sessionId, { type: 'screenshot', mask: true }, timeoutMs, { waitForTakeover: false }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    throw new TraceCaptureError(/mask_unavailable/.test(e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ''}` : String(e)) ? 'masked_failed' : 'unavailable');
  }
  if (op.state !== 'succeeded') throw new TraceCaptureError(/mask_unavailable/.test(`${op.error ?? ''}`) ? 'masked_failed' : 'unavailable');
  const r = op.result ?? {};
  let mime = str(r.mime) ?? 'image/jpeg';
  let base64 = str(r.data);
  if (!base64) {
    const artifactId = str(r.artifact_id);
    if (!artifactId) throw new TraceCaptureError('unavailable');
    const res = await fabric.raw('GET', `/v1/artifacts/${artifactId}`, { retries: 1 });
    mime = res.headers.get('content-type') ?? mime;
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: mime, masked: num(r.masked) ?? 0 };
  }
  return { bytes: Buffer.from(base64, 'base64'), contentType: mime, masked: num(r.masked) ?? 0 };
}

/** A trace capture that did not produce a picture, and why. */
export class TraceCaptureError extends Error {
  constructor(readonly note: TraceNote) {
    super(`trace capture: ${note}`);
  }
}
