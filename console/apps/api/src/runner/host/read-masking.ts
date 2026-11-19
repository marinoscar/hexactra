// ReadMasking: inputs the browser host filled from a provider (an identity detail, a saved login's password, a card field) are never read back
// (E37.6, E37.7). The run knows WHICH inputs were filled (a selector or a point, never a value) and keeps them out of everything the model
// can read back: element listings, page text, script results and screenshots.
import type { BrowserPort } from '../browser/browser-port';
import { ACTION_TIMEOUT_MS } from '../browser/browser-port';
import type { ReadMasking } from '../browser/context';
import { FILLED_MARKER, filledOn, maskElements, pageOf, scriptMayReadValues } from '../saved-identity';
import type { RunMemory } from './run-memory';

/** Which of `selectors` name an element that is one of the filled inputs (or, with `contains`, hold one). One evaluate outside `act`. */
async function matchFilled(browser: BrowserPort, selectors: string[], filled: string[], contains = false): Promise<Set<string>> {
  const equal = new Set(selectors.filter((x) => filled.includes(x)));
  if (selectors.length === 0 || filled.length === 0) return equal;
  const script = `/* hexactra:filled-among */(() => { const sels = ${JSON.stringify(selectors)}; const filled = ${JSON.stringify(filled)}; const hit = [];
        const els = filled.map((f) => { try { return document.querySelector(f); } catch (e) { return null; } }).filter(Boolean);
        for (const s of sels) { let e = null; try { e = document.querySelector(s); } catch (x) { e = null; } if (e && els.some((x) => x === e || (${contains ? 'true' : 'false'} && e.contains(x)))) hit.push(s); }
        return hit; })()`;
  try {
    const op = await browser.act({ type: 'evaluate', script, await_promise: false }, ACTION_TIMEOUT_MS);
    const v = op.state === 'succeeded' ? op.result?.value : null;
    if (!Array.isArray(v)) return equal;
    return new Set([...equal, ...v.filter((x): x is string => typeof x === 'string')]);
  } catch {
    return equal;
  }
}

export function readMasking(memory: RunMemory, browser: BrowserPort, currentUrl: () => Promise<string | null>): ReadMasking {
  /** The selectors filled from a provider on the page now on screen (a tabs read only when something was filled). */
  const filledNow = async (): Promise<string[]> => {
    if (!memory.savedIdentity?.filled?.length) return [];
    return filledOn(memory.savedIdentity, pageOf(await currentUrl()));
  };
  /** The points a card field was typed at inside an embedded frame, on the page now on screen (E37.7). */
  const cardPointsNow = async (): Promise<{ x: number; y: number }[]> => {
    const pts = memory.savedCards?.points;
    if (!pts?.length) return [];
    const page = pageOf(await currentUrl());
    return page ? pts.filter((p) => p.page === page).map((p) => ({ x: p.x, y: p.y })) : [];
  };
  return {
    filledNow,
    async maskedText(selector, filled) {
      // A read of the filled input itself, or of an element that holds one, returns the marker instead of the page's text.
      return (await matchFilled(browser, [selector], filled, true)).has(selector) ? FILLED_MARKER : null;
    },
    async maskElements(els, filled) {
      return maskElements(els, await matchFilled(browser, els.map((el) => String(el.selector)), filled));
    },
    hidesScript: (script) => scriptMayReadValues(script),
    marker: FILLED_MARKER,
    /**
     * Run `fn` (a screenshot) with an opaque box over every filled input of the page, so no picture shows a value. The boxes are in the page
     * when the pixels are read and are removed afterwards. If they cannot be drawn, nothing is captured.
     */
    async covered<T>(fn: (covered: string[]) => Promise<T>): Promise<T> {
      const filled = await filledNow();
      const points = await cardPointsNow();
      if (filled.length === 0 && points.length === 0) return fn([]);
      const cover = `/* hexactra:cover-filled */(() => { const id = '__hexactra_filled_cover__'; const old = document.getElementById(id); if (old) old.remove();
        const root = document.createElement('div'); root.id = id; root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
        const cover = (e) => { if (!e) return; const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return;
          const b = document.createElement('div'); b.textContent = 'filled'; b.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;background:#6b7280;color:#fff;font:11px/1.2 sans-serif;display:flex;align-items:center;padding:0 4px;box-sizing:border-box;overflow:hidden;';
          root.appendChild(b); };
        for (const s of ${JSON.stringify(filled)}) { let e = null; try { e = document.querySelector(s); } catch (x) { e = null; } cover(e); }
        for (const pt of ${JSON.stringify(points)}) { let e = null; try { e = document.elementFromPoint(pt.x, pt.y); } catch (x) { e = null; } cover(e); }
        document.documentElement.appendChild(root); return true; })()`;
      const uncover = `/* hexactra:uncover-filled */(() => { const e = document.getElementById('__hexactra_filled_cover__'); if (e) e.remove(); return true; })()`;
      const drawn = await browser.act({ type: 'evaluate', script: cover, await_promise: false }, ACTION_TIMEOUT_MS);
      if (drawn.state !== 'succeeded') throw new Error('the page could not be covered, so no picture was taken');
      try {
        return await fn(filled);
      } finally {
        await browser.act({ type: 'evaluate', script: uncover, await_promise: false }, ACTION_TIMEOUT_MS).catch(() => undefined);
      }
    },
    async anyCoverable() {
      return (await filledNow()).length > 0 || (await cardPointsNow()).length > 0;
    },
    async maskView(view, covered) {
      const hit = await matchFilled(browser, view.marks.map((m) => m.selector), covered);
      return { ...view, marks: view.marks.map((m) => (hit.has(m.selector) ? { ...m, text: FILLED_MARKER } : m)) };
    },
  };
}
