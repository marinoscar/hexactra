// Context efficiency (#406): the screenshot window, the round input order and the observation sizing.
import { chunkAllowance, maxElementsFor, ScreenshotWindow, shotHash } from '../src/runner/context-settings';
import { roundInput, type ScreenView } from '../src/runner/vision';

const view = (n: number): ScreenView => ({ screen: 'page', dataUrl: `data:image/jpeg;base64,IMG${n}`, width: null, height: null, url: null, title: null, marks: [] });
type Part = { type: string; url?: string; text?: string };
const parts = (input: unknown): Part[] => (input as { content: Part[] }[])[0]!.content;
const urls = (list: ScreenView[]) => list.map((v) => v.dataUrl);

describe('roundInput', () => {
  it('includes exactly the images it is given: two, one, or none', () => {
    const two = roundInput('Goal: x', [view(1), view(2)], 'Steps used: 3.');
    expect(parts(two).filter((p) => p.type === 'image').map((p) => p.url)).toEqual([view(1).dataUrl, view(2).dataUrl]);
    expect(parts(two)[0]!.text).toContain('oldest first');
    expect(parts(roundInput('Goal: x', view(1))).filter((p) => p.type === 'image')).toHaveLength(1);
    expect(roundInput('Goal: x', [], 'Steps used: 3.')).toBe('Goal: x\n\nSteps used: 3.');
    expect(roundInput('Goal: x', null)).toBe('Goal: x');
  });

  it('orders the stable text first, then the images, then the volatile tail', () => {
    const p = parts(roundInput('Goal: x', [view(1)], 'Steps used: 3.'));
    expect(p.map((x) => x.type)).toEqual(['text', 'image', 'text']);
    expect(p[0]!.text).toBe('Goal: x');
    expect(p[2]!.text).toMatch(/Attached: a screenshot[\s\S]*Steps used: 3\.$/);
  });
});

describe('ScreenshotWindow', () => {
  it('holds screenshotsKept images and none when it is 0', () => {
    const w = new ScreenshotWindow(2, 10);
    expect(urls(w.push(view(1)))).toEqual([view(1).dataUrl]);
    expect(w.push(view(2))).toHaveLength(2);
    expect(w.push(view(3))).toHaveLength(2);
    const off = new ScreenshotWindow(0, 10);
    expect(off.enabled).toBe(false);
    expect(off.push(view(1))).toEqual([]);
  });

  it('keeps the older images unchanged for pruneBatch chunks, then trims to the current one', () => {
    const w = new ScreenshotWindow(3, 4);
    w.push(view(1));
    w.push(view(2));
    const full = w.push(view(3));
    const anchor = urls(full).slice(0, 2);
    // pruneBatch (4) consecutive chunks: the older images are byte-identical.
    for (let i = 4; i < 8; i++) {
      const list = w.push(view(i));
      expect(urls(list).slice(0, 2)).toEqual(anchor);
      expect(list).toHaveLength(3);
      expect(list[2]).toEqual(view(i));
    }
    // Then it trims to 1 (the current screenshot) and refills.
    expect(urls(w.push(view(8)))).toEqual([view(8).dataUrl]);
    expect(w.push(view(9))).toHaveLength(2);
  });

  it('exposes digests, never the image', () => {
    const w = new ScreenshotWindow(1, 5);
    w.push(view(1));
    expect(w.hashes).toEqual([shotHash(view(1).dataUrl)]);
    expect(w.hashes[0]).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('observation and chunk sizing', () => {
  it('scales the element count with observationChars, capped at 80', () => {
    expect(maxElementsFor(6000)).toBe(80);
    expect(maxElementsFor(600)).toBe(8);
    expect(maxElementsFor(500)).toBe(6);
    expect(maxElementsFor(20_000)).toBe(80);
  });

  it('allows more chunks for a smaller chunk size', () => {
    expect(chunkAllowance(100, 20)).toBe(25);
    expect(chunkAllowance(100, 10)).toBe(50);
    expect(chunkAllowance(Number.POSITIVE_INFINITY, 10)).toBe(Number.POSITIVE_INFINITY);
  });
});
