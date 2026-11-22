// What the interrupt detectors read (E46.15): the page's URL, title, a bounded slice of its visible text and its controls. In memory only:
// nothing of it is stored.
import { ACTION_TIMEOUT_MS, type BrowserPort } from '../../browser-port';
import { pageElements, type PageElement } from '../index';

export interface PageSnapshot {
  url: string | null;
  title: string;
  text: string;
  elements: PageElement[];
  /** Selectors of frames on the page (a CAPTCHA frame is one). */
  frames: string[];
}

export function snapshotScript(): string {
  return `/* hexactra:surface-snapshot */(() => ({ url: location.href, title: document.title.slice(0, 300), text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 4000), frames: Array.from(document.querySelectorAll('iframe')).slice(0, 20).map((f) => (f.getAttribute('src') || f.getAttribute('title') || '').slice(0, 200)) }))()`;
}

export async function pageSnapshot(browser: BrowserPort): Promise<PageSnapshot | null> {
  try {
    const op = await browser.act({ type: 'evaluate', script: snapshotScript(), await_promise: false }, ACTION_TIMEOUT_MS);
    const v = (op.state === 'succeeded' ? op.result?.value : null) as Record<string, unknown> | null;
    if (!v) return null;
    return { url: typeof v.url === 'string' ? v.url : null, title: String(v.title ?? '').slice(0, 300), text: String(v.text ?? '').slice(0, 4000), frames: Array.isArray(v.frames) ? v.frames.map(String).slice(0, 20) : [], elements: (await pageElements(browser)) ?? [] };
  } catch {
    return null;
  }
}
