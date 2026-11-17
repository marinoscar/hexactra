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
import type { AiService } from '@marinoscar/platform-api/ai';

import type { FabricClient } from '../fabric/fabric.client';
import type { FabricSession } from './fabric-session';

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

/** The `input` of a model round. */
export type RoundInput = Parameters<ReturnType<AiService['forUser']>['runTools']>[0]['input'];

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
export async function captureScreen(session: FabricSession, fabric: FabricClient, sessionId: string, screen: Screen): Promise<ScreenView> {
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
