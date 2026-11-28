import { useEffect, useState } from 'react';

/**
 * How much of the window's bottom the on-screen keyboard covers, in CSS pixels
 * (0 without the Visual Viewport API or with no keyboard). The viewport tag
 * asks the browser to resize the page for the keyboard
 * (`interactive-widget=resizes-content`), and then this is 0; a browser that
 * overlays the keyboard instead keeps the layout height, so a page that fills
 * the window (the chat, the desktop viewer) pads itself by this much.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}
