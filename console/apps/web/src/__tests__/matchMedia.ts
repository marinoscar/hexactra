// A `window.matchMedia` for jsdom (which has none), answering the width
// queries MUI's breakpoints produce: `(max-width:599.95px)`, `(min-width:900px)`.
// Without it every `useMediaQuery` is false, which the kit reads as a desktop.

function matches(query: string, width: number): boolean {
  const min = /min-width:\s*([\d.]+)px/.exec(query);
  const max = /max-width:\s*([\d.]+)px/.exec(query);
  return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
}

/**
 * Makes the window `width` CSS pixels wide for `useMediaQuery` (390 a phone,
 * 768 a tablet, 1440 a desktop). Returns the function that removes the mock;
 * call it in `afterEach`.
 */
export function mockViewport(width: number): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matches(query, width),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}
