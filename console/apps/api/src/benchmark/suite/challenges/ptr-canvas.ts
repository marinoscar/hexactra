// ptr-canvas (E44.7, #745): shapes drawn on a canvas, with nothing in the page's markup to select them by. The page's script
// (assets/benchmark-site/ptr-canvas.js) draws them from `api/shapes` and sends where the person clicked; the SERVER decides which
// shape, if any, was hit, so the script cannot record a hit that did not happen.
import { html, json, notFound, page, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Check, Json, Seed, SiteState } from '../types';
import { appended, intField, list } from './shared';

export const CANVAS = { width: 480, height: 320 } as const;
const KINDS = ['circle', 'square', 'triangle'] as const;
const COLOURS = [
  { name: 'red', hex: '#d1342f' },
  { name: 'blue', hex: '#2f5fd1' },
  { name: 'green', hex: '#2e9a4b' },
  { name: 'orange', hex: '#e8871e' },
  { name: 'purple', hex: '#7d3fc4' },
] as const;
const BRAND = 'Sketch board';

export interface Shape {
  kind: (typeof KINDS)[number];
  colour: string;
  hex: string;
  x: number;
  y: number;
  /** Half the width: the radius of a circle, half the side of a square, half the base of a triangle. */
  size: number;
}

export function ptrCanvasPlan(seed: Seed): { shapes: Shape[]; target: number } {
  const g = seeded(seed, 'ptr-canvas');
  // One shape per cell of a 4 x 3 grid, so no two overlap.
  const cells = g.sample(
    Array.from({ length: 12 }, (_, i) => i),
    7,
  );
  const kind = g.pick(KINDS);
  const colour = g.pick(COLOURS);
  // The target is the only shape of its kind and colour; one other shares its colour and one its kind, so neither alone finds it.
  const looks: { kind: Shape['kind']; colour: (typeof COLOURS)[number] }[] = [
    { kind, colour },
    { kind: g.pick(KINDS.filter((k) => k !== kind)), colour },
    { kind, colour: g.pick(COLOURS.filter((c) => c !== colour)) },
  ];
  while (looks.length < cells.length) {
    const look = { kind: g.pick(KINDS), colour: g.pick(COLOURS) };
    if (!(look.kind === kind && look.colour === colour)) looks.push(look);
  }
  const order = g.shuffle(looks);
  const shapes = cells.map((cell, i) => ({
    kind: order[i]!.kind,
    colour: order[i]!.colour.name,
    hex: order[i]!.colour.hex,
    x: (cell % 4) * 120 + 60 + g.int(-14, 14),
    y: Math.floor(cell / 4) * 106 + 53 + g.int(-10, 10),
    size: g.int(24, 32),
  }));
  return { shapes, target: shapes.findIndex((s) => s.kind === kind && s.colour === colour.name) };
}

/** Which shape a point is on, or null. A triangle points up: apex (x, y - size), base from (x - size, y + size) to (x + size, y + size). */
export function shapeAt(shapes: readonly Shape[], x: number, y: number): number | null {
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i]!;
    const dx = x - s.x;
    const dy = y - s.y;
    if (s.kind === 'circle' && dx * dx + dy * dy <= s.size * s.size) return i;
    if (s.kind === 'square' && Math.abs(dx) <= s.size && Math.abs(dy) <= s.size) return i;
    // Inside when below the apex, above the base, and within the two sloped sides (|dx| shrinks to 0 at the apex).
    if (s.kind === 'triangle' && dy >= -s.size && dy <= s.size && Math.abs(dx) <= (dy + s.size) / 2) return i;
  }
  return null;
}

function handle(req: SiteRequest): SiteResponse {
  const { shapes } = ptrCanvasPlan(req.seed);
  if (req.path === '' && req.method === 'GET') {
    return page({
      title: 'Pick a shape',
      brand: BRAND,
      scripts: ['ptr-canvas.js'],
      body: html`<p>Click a shape on the board to select it.</p>
        <canvas id="board" class="board" width="${CANVAS.width}" height="${CANVAS.height}" aria-label="A board of coloured shapes">Your browser cannot show the board.</canvas>
        <p id="selection" role="status" class="muted">Nothing is selected.</p>`,
    });
  }
  if (req.path === 'api/shapes' && req.method === 'GET') return json({ width: CANVAS.width, height: CANVAS.height, shapes: shapes.map((s) => ({ kind: s.kind, fill: s.hex, x: s.x, y: s.y, size: s.size })) });
  if (req.path !== 'api/click' || req.method !== 'POST') return notFound();
  const x = intField(req.body, 'x', 0, CANVAS.width);
  const y = intField(req.body, 'y', 0, CANVAS.height);
  if (x === null || y === null) return json({ ok: false, error: 'A click must be on the board.' }, { status: 400 });
  const hit = shapeAt(shapes, x, y);
  const clicks = appended(list(req.state, 'clicks'), hit);
  return json({ ok: true, selected: hit !== null }, { state: { ...req.state, clicks } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const { shapes, target } = ptrCanvasPlan(seed);
  const clicks = list(state, 'clicks').filter((c): c is number => typeof c === 'number');
  const wrong = clicks.filter((c) => c !== target);
  const name = (i: number) => `the ${shapes[i]!.colour} ${shapes[i]!.kind}`;
  return [
    { name: 'target-clicked', pass: clicks.includes(target), detail: clicks.includes(target) ? `${name(target)} was clicked` : `${name(target)} was never clicked` },
    { name: 'no-wrong-shape', pass: wrong.length === 0, detail: wrong.length ? `also clicked ${name(wrong[0]!)}` : 'no other shape was clicked' },
  ];
}

export const ptrCanvas: Challenge = {
  id: 'ptr-canvas',
  title: 'Click a shape drawn on a canvas',
  category: 'pointer',
  difficulty: 2,
  requires: ['pointer'],
  setup: () => ({ clicks: [] as Json[] }),
  goal: (seed, baseUrl) => {
    const { shapes, target } = ptrCanvasPlan(seed);
    return `Open ${baseUrl}/ and click the ${shapes[target]!.colour} ${shapes[target]!.kind} on the board. Click no other shape.`;
  },
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
