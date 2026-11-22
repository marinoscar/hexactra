// A modal that covers the target and has exactly one close control (E46.15). Two or more controls it cannot tell apart: not dismissed.
import type { PageSnapshot } from './snapshot';

const CLOSE = /^(close|×|x|dismiss|no thanks|not now|maybe later|skip)$/i;

export function detectOverlay(p: PageSnapshot): { close: string } | null {
  const dialogs = new Set(p.elements.filter((e) => e.role === 'dialog' || e.role === 'alertdialog').map((e) => e.name ?? ''));
  const closes = p.elements.filter((e) => e.name !== null && CLOSE.test(e.name.trim()) && (e.anchor !== null || dialogs.size > 0));
  return closes.length === 1 ? { close: closes[0]!.selector } : null;
}
