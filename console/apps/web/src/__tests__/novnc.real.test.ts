// The real noVNC module, not a fake (#356): the desktop page constructs its
// RFB class, which must be a constructor after the bundler's module handling.
import RFB from '@novnc/novnc/core/rfb.js';

// jsdom has no ResizeObserver; browsers do.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

describe('noVNC', () => {
  it('is an RFB class the desktop page can construct', () => {
    expect(typeof RFB).toBe('function');
    const target = document.createElement('div');
    // An address nobody listens on: construction must work; the connection fails later.
    const r = new RFB(target, 'ws://127.0.0.1:1/websockify');
    expect(r).toBeInstanceOf(RFB);
    r.disconnect();
  });
});
