// Masked screenshots (#539, epic E35).
//
// A screenshot kept for a run's trace must never show a password, a one-time
// code, a card number or an account number in the clear. `pageMask` runs in
// the page, before the capture, and covers every such region with an opaque
// box; `pageClearMask` removes the boxes after the capture. No unmasked trace
// image exists anywhere: the boxes are in the page when the pixels are read.
//
// What counts as sensitive text is the shared table in
// packages/contracts/sensitive-patterns.json (generated from the console's
// sensitive-patterns.js by scripts/gen-sensitive-patterns.mjs, E35.3). The
// build copies it next to the service worker, and `loadSensitivePatterns`
// reads it from there.
//
// Out of scope: text inside images, canvases and videos is not read (no OCR).
// A canvas over half the viewport is covered whole; a smaller one is not.

/** The container's element id. */
export const MASK_ID = '__hexactra_mask__';

/** Most boxes drawn; past it the whole viewport is covered and `masked` is this number. */
export const MAX_MASK_BOXES = 500;

/** The prefix of the error a masked screenshot fails with when the page cannot be masked. */
export const MASK_UNAVAILABLE = 'mask_unavailable';

/** One entry of the shared pattern file, as the page function needs it. */
export interface MaskPattern {
  id: string;
  source: string;
  flags: string;
  check: 'luhn' | 'mod97' | 'aba' | null;
}

/** The shared pattern file (only the fields the extension reads). */
export interface SensitivePatternFile {
  version: number;
  checks: string[];
  patterns: MaskPattern[];
}

const KNOWN_CHECKS = new Set(['luhn', 'mod97', 'aba']);

/**
 * Validate the shared file: every regex compiles and every check is one the
 * page function implements. Throws on anything else, so masking fails closed.
 */
export function parseSensitivePatterns(raw: unknown): MaskPattern[] {
  const file = raw as Partial<SensitivePatternFile> | null;
  if (!file || typeof file.version !== 'number' || !Array.isArray(file.patterns) || file.patterns.length === 0) {
    throw new Error('the sensitive pattern file is malformed');
  }
  return file.patterns.map((p) => {
    if (typeof p?.source !== 'string' || typeof p.flags !== 'string') throw new Error(`pattern ${p?.id} is malformed`);
    if (p.check !== null && !KNOWN_CHECKS.has(p.check)) throw new Error(`pattern ${p.id} names an unknown check ${p.check}`);
    new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`);
    return { id: String(p.id), source: p.source, flags: p.flags, check: p.check };
  });
}

let cached: MaskPattern[] | null = null;

/** Read the shared pattern file shipped with the extension (cached). */
export async function loadSensitivePatterns(): Promise<MaskPattern[]> {
  if (cached) return cached;
  const res = await fetch(chrome.runtime.getURL('sensitive-patterns.json'));
  if (!res.ok) throw new Error(`cannot read the sensitive pattern file (${res.status})`);
  cached = parseSensitivePatterns(await res.json());
  return cached;
}

/** Forget the cached patterns (tests). */
export function resetSensitivePatternsCache() {
  cached = null;
}

/**
 * Replace every pattern match in a string with bullets, applying the same
 * table and checks as the page function. Used for text the extension returns
 * next to a masked picture (the labels of marks).
 */
export function maskText(text: string, patterns: MaskPattern[]): string {
  let work = text;
  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`);
    const hits: [number, number][] = [];
    for (let m = re.exec(work); m; m = re.exec(work)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (passesCheck(p.check, m[0])) hits.push([m.index, m.index + m[0].length]);
    }
    if (!hits.length) continue;
    const parts: string[] = [];
    let at = 0;
    for (const [a, b] of hits) {
      parts.push(work.slice(at, a), '•'.repeat(b - a));
      at = b;
    }
    parts.push(work.slice(at));
    work = parts.join('');
  }
  return work;
}

function passesCheck(check: MaskPattern['check'], s: string): boolean {
  const digits = s.replace(/\D/g, '');
  if (check === 'luhn') {
    if (digits.length < 2) return false;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let n = digits.charCodeAt(digits.length - 1 - i) - 48;
      if (i % 2 === 1) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
    }
    return sum % 10 === 0;
  }
  if (check === 'mod97') {
    const iban = s.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
    const moved = iban.slice(4) + iban.slice(0, 4);
    let rem = 0;
    for (const ch of moved) {
      const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
      for (const c of v) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
    }
    return rem === 1;
  }
  if (check === 'aba') {
    if (digits.length !== 9) return false;
    const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += w[i] * (digits.charCodeAt(i) - 48);
    return sum % 10 === 0;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Page functions. These run inside the page via chrome.scripting.executeScript
// and must be self-contained (no closures over module scope).

/**
 * Cover the sensitive regions of the viewport with opaque boxes, in the top
 * document and every same-origin frame it can reach. Returns `{ masked }`, the
 * number of boxes, or `{ __error }` (prefixed `mask_unavailable`) when the
 * page cannot be masked; the caller must not capture then.
 */
export function pageMask(patterns: MaskPattern[], maskId: string, maxBoxes: number) {
  const FAIL = 'mask_unavailable';
  try {
    document.getElementById(maskId)?.remove();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!(vw > 0 && vh > 0)) return { __error: `${FAIL}: the page has no viewport` };
    if (!document.documentElement) return { __error: `${FAIL}: the page has no document` };

    type Box = { x: number; y: number; w: number; h: number };
    type Clip = { l: number; t: number; r: number; b: number };
    const boxes: Box[] = [];
    let overflow = false;
    const viewport: Clip = { l: 0, t: 0, r: vw, b: vh };

    const SENSITIVE_AUTOCOMPLETE = /^(one-time-code|cc-number|cc-csc|cc-exp.*|current-password|new-password)$/i;
    const SENSITIVE_NAME = /otp|passcode|cvv|cvc|ssn|routing|account.?number|card.?number/i;
    // Inputs whose value is text a person typed or the page filled.
    const TEXT_TYPES = new Set(['', 'text', 'email', 'tel', 'search', 'url', 'number']);
    const SKIP_TEXT_PARENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'OPTION', 'TITLE']);

    const compiled = patterns.map((p) => ({
      re: new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`),
      check: p.check,
    }));

    const passes = (check: string | null, s: string): boolean => {
      const digits = s.replace(/\D/g, '');
      if (check === 'luhn') {
        if (digits.length < 2) return false;
        let sum = 0;
        for (let i = 0; i < digits.length; i++) {
          let n = digits.charCodeAt(digits.length - 1 - i) - 48;
          if (i % 2 === 1) {
            n *= 2;
            if (n > 9) n -= 9;
          }
          sum += n;
        }
        return sum % 10 === 0;
      }
      if (check === 'mod97') {
        const iban = s.replace(/\s/g, '').toUpperCase();
        if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
        const moved = iban.slice(4) + iban.slice(0, 4);
        let rem = 0;
        for (const ch of moved) {
          const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
          for (const c of v) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
        }
        return rem === 1;
      }
      if (check === 'aba') {
        if (digits.length !== 9) return false;
        const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
        let sum = 0;
        for (let i = 0; i < 9; i++) sum += w[i] * (digits.charCodeAt(i) - 48);
        return sum % 10 === 0;
      }
      return true;
    };

    /**
     * The character ranges of `text` that match a pattern, applying the table
     * in order; a match is replaced with bullets before the next pattern runs,
     * as the console does, so a later pattern never re-matches it.
     */
    const sensitiveRanges = (text: string): [number, number][] => {
      let work = text;
      const out: [number, number][] = [];
      for (const { re, check } of compiled) {
        re.lastIndex = 0;
        const hits: [number, number][] = [];
        for (let m = re.exec(work); m; m = re.exec(work)) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          if (passes(check, m[0])) hits.push([m.index, m.index + m[0].length]);
        }
        if (!hits.length) continue;
        const parts: string[] = [];
        let at = 0;
        for (const [a, b] of hits) {
          out.push([a, b]);
          parts.push(work.slice(at, a), '•'.repeat(b - a));
          at = b;
        }
        parts.push(work.slice(at));
        work = parts.join('');
      }
      return out;
    };

    const intersect = (a: Clip, b: Clip): Clip => ({
      l: Math.max(a.l, b.l),
      t: Math.max(a.t, b.t),
      r: Math.min(a.r, b.r),
      b: Math.min(a.b, b.b),
    });
    const area = (c: Clip) => Math.max(0, c.r - c.l) * Math.max(0, c.b - c.t);

    /** Add a box for a rect in a frame (offset `ox`, `oy` from the top viewport), clipped to `clip`. */
    const add = (rect: { left: number; top: number; right: number; bottom: number }, ox: number, oy: number, clip: Clip) => {
      // One pixel of margin, so antialiased edges of the glyphs are covered too.
      const c = intersect(
        { l: rect.left + ox - 1, t: rect.top + oy - 1, r: rect.right + ox + 1, b: rect.bottom + oy + 1 },
        clip,
      );
      if (c.r - c.l <= 0 || c.b - c.t <= 0) return;
      if (boxes.length >= maxBoxes) {
        overflow = true;
        return;
      }
      boxes.push({ x: c.l, y: c.t, w: c.r - c.l, h: c.b - c.t });
    };

    const hidden = (el: Element, win: Window) => {
      const style = win.getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden';
    };

    const sensitiveInput = (el: HTMLInputElement) => {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'password') return true;
      const ac = (el.getAttribute('autocomplete') || '').trim().split(/\s+/);
      if (ac.some((t) => SENSITIVE_AUTOCOMPLETE.test(t))) return true;
      for (const attr of ['name', 'id', 'aria-label']) {
        const v = el.getAttribute(attr);
        if (v && SENSITIVE_NAME.test(v)) return true;
      }
      return false;
    };

    const scan = (doc: Document, ox: number, oy: number, clip: Clip, depth: number) => {
      const win = doc.defaultView;
      if (!win || !doc.documentElement) return;
      const root = doc.body || doc.documentElement;

      // Inputs: a sensitive field whatever it holds, any other text field
      // when its value matches a pattern. The whole field is covered.
      for (const el of Array.from(doc.querySelectorAll('input, textarea'))) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.bottom + oy <= clip.t || r.top + oy >= clip.b || r.right + ox <= clip.l || r.left + ox >= clip.r) continue;
        if (hidden(el, win)) continue;
        let cover = false;
        if (el.tagName === 'INPUT') {
          const input = el as HTMLInputElement;
          const type = (input.getAttribute('type') || '').toLowerCase();
          if (sensitiveInput(input)) cover = true;
          else if (TEXT_TYPES.has(type) && input.value) cover = sensitiveRanges(input.value).length > 0;
        } else {
          const ta = el as HTMLTextAreaElement;
          if (ta.value) cover = sensitiveRanges(ta.value).length > 0;
        }
        if (cover) add(r, ox, oy, clip);
      }

      // Text: the document's text nodes joined with a space (so a label in
      // one cell is context for the number in the next), matched once, and
      // each match covered by the rects of exactly its characters.
      const segs: { node: Text; start: number; end: number }[] = [];
      let text = '';
      const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        const parent = n.parentElement;
        if (!parent || SKIP_TEXT_PARENTS.has(parent.tagName)) continue;
        if (parent.closest(`#${maskId}`)) continue;
        const data = n.data;
        if (!data || !/\S/.test(data)) continue;
        if (text.length) text += ' ';
        segs.push({ node: n, start: text.length, end: text.length + data.length });
        text += data;
      }
      if (segs.length) {
        const range = doc.createRange();
        let si = 0;
        const ranges = sensitiveRanges(text).sort((a, b) => a[0] - b[0]);
        for (const [a, b] of ranges) {
          if (overflow) break;
          while (si < segs.length && segs[si].end <= a) si++;
          for (let k = si; k < segs.length && segs[k].start < b; k++) {
            const s = segs[k];
            const from = Math.max(a, s.start) - s.start;
            const to = Math.min(b, s.end) - s.start;
            if (to <= from) continue;
            range.setStart(s.node, from);
            range.setEnd(s.node, to);
            for (const rect of Array.from(range.getClientRects())) {
              if (rect.width <= 0 || rect.height <= 0) continue;
              add(rect, ox, oy, clip);
            }
          }
        }
        range.detach?.();
      }

      // Frames, plugins and canvases.
      for (const el of Array.from(doc.querySelectorAll('iframe, frame, embed, object, canvas'))) {
        if (overflow) return;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const onScreen = intersect({ l: r.left + ox, t: r.top + oy, r: r.right + ox, b: r.bottom + oy }, clip);
        if (area(onScreen) <= 0) continue;
        if (hidden(el, win)) continue;
        const tag = el.tagName;
        if (tag === 'CANVAS') {
          // No OCR: a canvas over half the viewport is covered whole.
          if (area(onScreen) > (vw * vh) / 2) add(r, ox, oy, clip);
          continue;
        }
        let inner: Document | null = null;
        if (tag === 'IFRAME' || tag === 'FRAME') {
          try {
            inner = (el as HTMLIFrameElement).contentDocument;
          } catch {
            inner = null;
          }
        }
        if (inner && inner.documentElement && depth < 8) {
          const f = el as HTMLIFrameElement;
          const fx = r.left + ox + f.clientLeft;
          const fy = r.top + oy + f.clientTop;
          const innerClip = intersect(clip, {
            l: fx,
            t: fy,
            r: fx + (f.clientWidth || r.width),
            b: fy + (f.clientHeight || r.height),
          });
          scan(inner, fx, fy, innerClip, depth + 1);
          continue;
        }
        // A cross-origin frame or a plugin (a PDF viewer): its content cannot
        // be read. Covered whole, unless it is the page: then nothing useful
        // is left to capture, and the masked screenshot fails.
        if (area(onScreen) >= 0.9 * vw * vh) {
          throw new Error(`a ${tag === 'IFRAME' || tag === 'FRAME' ? 'cross-origin frame' : 'plugin'} fills the viewport`);
        }
        add(r, ox, oy, clip);
      }
    };

    scan(document, 0, 0, viewport, 0);

    let drawn = boxes;
    if (overflow) drawn = [{ x: 0, y: 0, w: vw, h: vh }];
    const container = document.createElement('div');
    container.id = maskId;
    container.setAttribute('aria-hidden', 'true');
    container.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    for (const b of drawn) {
      const box = document.createElement('div');
      box.style.cssText = `all:initial;position:fixed;display:block;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;background:#111;opacity:1;`;
      container.appendChild(box);
    }
    if (drawn.length) document.documentElement.appendChild(container);
    return { masked: overflow ? maxBoxes : boxes.length };
  } catch (e) {
    document.getElementById(maskId)?.remove();
    return { __error: `${FAIL}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Remove the mask container. */
export function pageClearMask(maskId: string) {
  document.getElementById(maskId)?.remove();
  return {};
}

/**
 * Resolve after the next animation frame has been produced, so the boxes are
 * painted before the capture. A hidden tab produces no frames, so a short
 * timer ends the wait as well.
 */
export function pageNextFrame() {
  return new Promise<Record<string, never>>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve({});
      }
    };
    try {
      requestAnimationFrame(() => requestAnimationFrame(finish));
    } catch {
      // No frames in this context; the timer ends the wait.
    }
    setTimeout(finish, 100);
  });
}
