// The on-screen keyboard's path to a remote desktop. A phone has no physical
// keys, so the desktop page focuses a hidden text field: the on-screen keyboard
// opens, and what it types is turned into X11 keysyms for noVNC's `sendKey`.

/** X11 keysyms of the keys an on-screen keyboard sends as key events. */
export const SPECIAL_KEYSYMS: Readonly<Record<string, number>> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  End: 0xff57,
};

/**
 * What the hidden field holds between keystrokes. An on-screen keyboard sends
 * no key event for Backspace on an empty field, so the field is never empty:
 * deleting one of these characters is how a Backspace is seen.
 */
export const KEYBOARD_SENTINEL = '_'.repeat(32);

/** The X11 keysym of one typed character: Latin-1 maps to itself, the rest to the Unicode range; a line break is Return. */
export function keysymOf(char: string): number {
  if (char === '\n' || char === '\r') return SPECIAL_KEYSYMS.Enter!;
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x20 && code <= 0xff) return code;
  return 0x01000000 | code;
}

/**
 * What the remote must receive to turn the field's `previous` text into
 * `next`: how many Backspaces, then which characters. Handles a keyboard that
 * replaces the word being composed (autocorrect, swipe typing).
 */
export function keyboardDiff(previous: string, next: string): { backspaces: number; text: string } {
  let same = 0;
  const limit = Math.min(previous.length, next.length);
  while (same < limit && previous[same] === next[same]) same++;
  return { backspaces: [...previous.slice(same)].length, text: next.slice(same) };
}

/** The keysyms of a {@link keyboardDiff}, in the order to send them. */
export function diffKeysyms(previous: string, next: string): number[] {
  const { backspaces, text } = keyboardDiff(previous, next);
  return [...Array<number>(backspaces).fill(SPECIAL_KEYSYMS.Backspace!), ...[...text].map(keysymOf)];
}
