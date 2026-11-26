/**
 * What the fabric reports after typing into a code field split into
 * one-character boxes (E49.1, #958; read by the agent since E49.2, #959). The
 * report holds counts only, never the value:
 * - `{ boxes, filled, method }`: every box holds its character;
 * - `{ gone: true }`: the page moved on by itself after the last character (a site that submits on the last digit).
 * A plain field reports nothing (`{}`), and the tools keep their old text for it.
 */
export function codeBoxesNote(result: Record<string, unknown> | undefined): string | null {
  if (!result) return null;
  if (result.gone === true) return 'the page moved on after the last character';
  const boxes = typeof result.boxes === 'number' ? result.boxes : 0;
  return boxes > 1 ? `into ${boxes} code boxes` : null;
}

/** The fabric's error when the boxes refused the code (`the code field has 6 boxes and took 1 of 6 characters`). */
export function isCodeBoxesRefusal(error: string | undefined): boolean {
  return !!error && /^the code field has \d+ boxes and took \d+ of \d+ characters/.test(error);
}

/** Said after a refused code: the value is used up, and a new one is asked for only when the page says so. */
export const CODE_BOXES_REFUSED_HINT = 'Look at the page: ask the person for a new code only if the page says this one was wrong or has expired.';
