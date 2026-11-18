// @vitest-environment jsdom
//
// Masked screenshots (#539). The page functions run against fixture pages in
// jsdom, through the real capture path (handleRequest -> executeScript), with
// a small layout stub: jsdom computes no layout, so an element's box comes
// from its `data-rect="x,y,w,h"` and text is laid out on one line at 8 px per
// character from its parent's box.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MASK_ID,
  MAX_MASK_BOXES,
  maskText,
  pageMask,
  parseSensitivePatterns,
  resetSensitivePatternsCache,
} from '../src/mask';
import { MARKS_ID, handleRequest, type BridgeRequest } from '../src/remote';

const PATTERN_FILE = resolve(__dirname, '../../../packages/contracts/sensitive-patterns.json');
const RAW = JSON.parse(readFileSync(PATTERN_FILE, 'utf8'));
const PATTERNS = parseSensitivePatterns(RAW);
const CHAR = 8;

type R = { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number };
const rect = (x: number, y: number, w: number, h: number): R => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y });

function boxOf(el: Element | null): R {
  const d = el?.getAttribute?.('data-rect');
  if (!d) return rect(0, 0, 0, 0);
  const [x, y, w, h] = d.split(',').map(Number);
  return rect(x, y, w, h);
}

/** Install the layout stub in a window (the top one, or a frame's). */
function stubLayout(win: Window & typeof globalThis) {
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    return boxOf(this) as unknown as DOMRect;
  };
  win.Range.prototype.getClientRects = function (this: Range) {
    const node = this.startContainer;
    const parent = node.parentElement;
    if (!parent || node !== this.endContainer || !parent.getAttribute('data-rect')) return [] as unknown as DOMRectList;
    let before = 0;
    for (const c of Array.from(parent.childNodes)) {
      if (c === node) break;
      before += (c.textContent ?? '').length;
    }
    const p = boxOf(parent);
    const from = before + this.startOffset;
    return [rect(p.left + from * CHAR, p.top, (this.endOffset - this.startOffset) * CHAR, p.height)] as unknown as DOMRectList;
  };
}

/** The boxes drawn in the container, as `[x, y, w, h]`. */
function drawn(): number[][] {
  const c = document.getElementById(MASK_ID);
  if (!c) return [];
  return Array.from(c.children).map((b) => {
    const s = (b as HTMLElement).style;
    return [s.left, s.top, s.width, s.height].map((v) => parseFloat(v));
  });
}

let captures: { boxes: number[][]; marks: boolean }[];

function makeChrome() {
  const tab = { id: 1, windowId: 10, url: 'https://example.test/', title: 'Example', active: true, status: 'complete' };
  return {
    runtime: { getURL: vi.fn((p: string) => `chrome-extension://test/${p}`) },
    tabs: {
      get: vi.fn(async () => tab),
      query: vi.fn(async () => [tab]),
      update: vi.fn(async () => tab),
      captureVisibleTab: vi.fn(async () => {
        captures.push({ boxes: drawn(), marks: !!document.getElementById(MARKS_ID) });
        return 'data:image/jpeg;base64,QUJD';
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    // Runs the page function in this (jsdom) document, as Chrome would in the tab.
    scripting: {
      executeScript: vi.fn(async ({ func, args }: { func: (...a: unknown[]) => unknown; args: unknown[] }) => [
        { result: await func(...args) },
      ]),
    },
  };
}

let chromeMock: ReturnType<typeof makeChrome>;

beforeEach(() => {
  captures = [];
  resetSensitivePatternsCache();
  chromeMock = makeChrome();
  vi.stubGlobal('chrome', chromeMock);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => RAW })),
  );
  stubLayout(window);
  // jsdom has no hit testing; the marks only use it to skip covered elements.
  (document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;
  document.body.innerHTML = '';
});

const req = (action: BridgeRequest['action']): BridgeRequest => ({
  type: 'request',
  id: 'op-1',
  action,
  deadline_ms: Date.now() + 5_000,
});

const shoot = (extra: Partial<{ marks: boolean; mask: boolean }> = { mask: true }) =>
  handleRequest(req({ type: 'screenshot', ...extra }));

describe('masked screenshots (#539)', () => {
  it('covers a password field before the capture and removes the box after', async () => {
    document.body.innerHTML = '<input type="password" value="hunter2" data-rect="10,10,200,30">';
    const r = await shoot();
    expect(r).toMatchObject({ ok: true, result: { masked: 1, mime: 'image/jpeg', data: 'QUJD' } });
    expect(captures).toEqual([{ boxes: [[9, 9, 202, 32]], marks: false }]);
    expect(document.getElementById(MASK_ID)).toBeNull();
  });

  it('covers sensitive fields by autocomplete, name, id and aria-label, whatever they hold', async () => {
    document.body.innerHTML = `
      <input autocomplete="one-time-code" data-rect="0,0,50,20">
      <input autocomplete="cc-exp-month" data-rect="0,30,50,20">
      <input name="cvv" data-rect="0,60,50,20">
      <input id="routingNumber" data-rect="0,90,50,20">
      <input aria-label="Account number" data-rect="0,120,50,20">
      <input name="city" value="Springfield" data-rect="0,150,50,20">`;
    const r = await shoot();
    expect(r.result).toMatchObject({ masked: 5 });
    expect(captures[0].boxes.map((b) => b[1])).toEqual([-1, 29, 59, 89, 119].map((y) => Math.max(0, y)));
  });

  it('covers only the characters of a card number in a paragraph', async () => {
    const text = 'Paid with 4242 4242 4242 4242 on Monday';
    document.body.innerHTML = `<p data-rect="20,100,600,18">${text}</p>`;
    const r = await shoot();
    expect(r.result).toMatchObject({ masked: 1 });
    const start = text.indexOf('4242');
    const len = '4242 4242 4242 4242'.length;
    expect(captures[0].boxes).toEqual([[20 + start * CHAR - 1, 99, len * CHAR + 2, 20]]);
    // The words around it stay visible: the box starts after "Paid with " and ends before " on Monday".
    expect(captures[0].boxes[0][0]).toBeGreaterThan(20 + 9 * CHAR);
    expect(captures[0].boxes[0][0] + captures[0].boxes[0][2]).toBeLessThan(20 + text.indexOf(' on') * CHAR + 2);
  });

  it('covers an account number in a table cell, with its label in the cell before', async () => {
    document.body.innerHTML = `
      <table><tbody><tr>
        <td data-rect="0,200,120,20">Account number</td>
        <td data-rect="130,200,120,20">12345678</td>
      </tr></tbody></table>`;
    const r = await shoot();
    expect(r.result).toMatchObject({ masked: 1 });
    expect(captures[0].boxes).toEqual([[129, 199, 8 * CHAR + 2, 22]]);
  });

  it('covers an input holding an email address', async () => {
    document.body.innerHTML = '<input type="email" value="person.a@example.test" data-rect="10,300,240,28">';
    const r = await shoot();
    expect(r.result).toMatchObject({ masked: 1 });
    expect(captures[0].boxes).toEqual([[9, 299, 242, 30]]);
  });

  it('leaves "ending 0659" uncovered', async () => {
    document.body.innerHTML = '<p data-rect="0,0,400,20">Checking ending 0659</p>';
    const r = await shoot();
    expect(r).toMatchObject({ ok: true, result: { masked: 0 } });
    expect(captures[0].boxes).toEqual([]);
  });

  it('gives masked: 0 on a page with nothing sensitive and leaves no container behind', async () => {
    document.body.innerHTML = `
      <h1 data-rect="0,0,400,30">Order 42 shipped</h1>
      <p data-rect="0,40,400,20">Total $1,234.56, 3 items, see order 2026-11-18.</p>
      <input value="hello" data-rect="0,80,100,20">`;
    const r = await shoot();
    expect(r).toMatchObject({ ok: true, result: { masked: 0 } });
    expect(captures).toEqual([{ boxes: [], marks: false }]);
    expect(document.getElementById(MASK_ID)).toBeNull();
  });

  it('removes the container when the capture throws', async () => {
    document.body.innerHTML = '<input type="password" data-rect="10,10,200,30">';
    chromeMock.tabs.captureVisibleTab.mockImplementationOnce(async () => {
      expect(document.getElementById(MASK_ID)).not.toBeNull();
      throw new Error('capture failed');
    });
    const r = await shoot();
    expect(r.ok).toBe(false);
    expect(r.result).toBeUndefined();
    expect(document.getElementById(MASK_ID)).toBeNull();
  });

  it('only covers regions inside the viewport', async () => {
    document.body.innerHTML = `
      <input type="password" data-rect="10,${innerHeight + 50},200,30">
      <input type="password" data-rect="${innerWidth - 50},10,200,30">`;
    const r = await shoot();
    expect(r.result).toMatchObject({ masked: 1 });
    expect(captures[0].boxes).toEqual([[innerWidth - 51, 9, 51, 32]]);
  });

  it('covers the whole viewport past 500 boxes and reports 500', async () => {
    document.body.innerHTML = Array.from({ length: 600 }, (_, i) => `<input type="password" data-rect="${i % 100},${Math.floor(i / 100) * 40},5,5">`).join('');
    const r = await shoot();
    expect(r.result).toMatchObject({ masked: MAX_MASK_BOXES });
    expect(captures[0].boxes).toEqual([[0, 0, innerWidth, innerHeight]]);
  });

  it('covers a canvas over half the viewport, not a small one', async () => {
    document.body.innerHTML = `
      <canvas data-rect="0,0,${innerWidth},${innerHeight * 0.75}"></canvas>
      <canvas data-rect="0,0,40,40"></canvas>`;
    const r = await shoot();
    expect(r.result).toMatchObject({ masked: 1 });
  });

  it('masks inside a same-origin frame, offset by the frame', async () => {
    document.body.innerHTML = '<iframe data-rect="100,100,500,300"></iframe>';
    const frame = document.querySelector('iframe')!;
    const inner = frame.contentDocument!;
    stubLayout(frame.contentWindow as Window & typeof globalThis);
    inner.body.innerHTML = '<input type="password" data-rect="10,10,100,20">';
    const r = await shoot();
    expect(r.result).toMatchObject({ masked: 1 });
    expect(captures[0].boxes).toEqual([[109, 109, 102, 22]]);
  });

  it('covers a cross-origin frame that is part of the page with one box', async () => {
    document.body.innerHTML = '<iframe data-rect="50,50,300,200"></iframe>';
    Object.defineProperty(document.querySelector('iframe')!, 'contentDocument', { get: () => null });
    const r = await shoot();
    expect(r.result).toMatchObject({ masked: 1 });
    expect(captures[0].boxes).toEqual([[49, 49, 302, 202]]);
  });

  it('fails with mask_unavailable, and no image, when a cross-origin frame fills the viewport', async () => {
    document.body.innerHTML = `<iframe data-rect="0,0,${innerWidth},${innerHeight}"></iframe>`;
    Object.defineProperty(document.querySelector('iframe')!, 'contentDocument', { get: () => null });
    const r = await shoot();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^mask_unavailable: a cross-origin frame fills the viewport/);
    expect(r.result).toBeUndefined();
    expect(chromeMock.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(document.getElementById(MASK_ID)).toBeNull();
  });

  it('fails with mask_unavailable, and no image, on a page that cannot be scripted', async () => {
    chromeMock.scripting.executeScript.mockRejectedValue(new Error('Cannot access a chrome:// URL'));
    const r = await shoot();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^mask_unavailable: cannot act on this page: Cannot access a chrome:\/\/ URL/);
    expect(r.result).toBeUndefined();
    expect(chromeMock.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('fails with mask_unavailable when the page function throws', async () => {
    chromeMock.scripting.executeScript
      .mockImplementationOnce(async () => [{ result: { width: 800, height: 600, dpr: 1 } }])
      .mockImplementationOnce(async () => [{ error: { message: 'boom' } }] as never);
    const r = await shoot();
    expect(r).toMatchObject({ ok: false, error: 'mask_unavailable: boom' });
    expect(chromeMock.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('fails with mask_unavailable when the pattern file cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const r = await shoot();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^mask_unavailable: cannot read the sensitive pattern file/);
    expect(chromeMock.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('draws marks and mask together and removes both', async () => {
    document.body.innerHTML = `
      <input type="password" value="hunter2" style="opacity:1" data-rect="10,10,200,30">
      <button style="opacity:1" data-rect="10,60,80,30">Sign in</button>`;
    const r = await shoot({ marks: true, mask: true });
    expect(r.ok).toBe(true);
    const result = r.result as { masked: number; marks: { text: string }[] };
    expect(result.masked).toBe(1);
    expect(result.marks.length).toBeGreaterThan(0);
    // The password's value is not a mark label next to a masked picture.
    expect(JSON.stringify(result.marks)).not.toContain('hunter2');
    expect(captures).toEqual([{ boxes: [[9, 9, 202, 32]], marks: true }]);
    expect(document.getElementById(MASK_ID)).toBeNull();
    expect(document.getElementById(MARKS_ID)).toBeNull();
  });

  it('does not mask, nor report masked, without mask', async () => {
    document.body.innerHTML = '<input type="password" value="hunter2" data-rect="10,10,200,30">';
    const r = await shoot({});
    expect(r.ok).toBe(true);
    expect(r.result).not.toHaveProperty('masked');
    expect(captures).toEqual([{ boxes: [], marks: false }]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the pattern table in the extension', () => {
  it('reads every pattern of the shared file', () => {
    expect(PATTERNS.map((p) => p.id)).toEqual(RAW.patterns.map((p: { id: string }) => p.id));
  });

  it('refuses a file it cannot apply', () => {
    expect(() => parseSensitivePatterns({ version: 1, patterns: [] })).toThrow();
    expect(() => parseSensitivePatterns({ version: 1, patterns: [{ id: 'x', source: '\\d', flags: 'g', check: 'crc' }] })).toThrow(/unknown check/);
    expect(() => parseSensitivePatterns({ version: 1, patterns: [{ id: 'x', source: '(', flags: 'g', check: null }] })).toThrow();
  });

  it('applies the checks: Luhn, ABA and mod-97', () => {
    expect(maskText('card 4242 4242 4242 4242', PATTERNS)).toBe('card •••••••••••••••••••');
    // Fails Luhn, and is neither a phone number nor a run of 9 digits.
    expect(maskText('card 4242 4242 4242 4241', PATTERNS)).toBe('card 4242 4242 4242 4241');
    expect(maskText('routing 011000015', PATTERNS)).toBe('routing •••••••••');
    const iban = 'GB82 WEST 1234 5698 7654 32';
    expect(maskText(`IBAN ${iban}`, PATTERNS)).toBe(`IBAN ${'•'.repeat(iban.length)}`);
    expect(maskText('ending 0659', PATTERNS)).toBe('ending 0659');
  });

  it('pageMask reports an error, never throws, on a broken pattern', () => {
    const r = pageMask([{ id: 'bad', source: '(', flags: 'g', check: null }], MASK_ID, 10);
    expect(r).toMatchObject({ __error: expect.stringMatching(/^mask_unavailable: /) });
    expect(document.getElementById(MASK_ID)).toBeNull();
  });
});
