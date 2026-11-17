// The part of noVNC's RFB client the desktop page uses (@novnc/novnc ships no types).
declare module '@novnc/novnc/core/rfb.js' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean; credentials?: Record<string, string> });
    viewOnly: boolean;
    scaleViewport: boolean;
    /** Limit the canvas to its container; with `dragViewport`, a drag moves the visible part. */
    clipViewport: boolean;
    dragViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    disconnect(): void;
    sendCtrlAltDel(): void;
    /** Press and release a key by X11 keysym (ignored while view-only). */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
    focus(): void;
  }
}
