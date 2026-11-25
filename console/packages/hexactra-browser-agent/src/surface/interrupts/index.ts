// Interrupt detectors (E46.15): pure over a page snapshot, one file each.
export { detectBlocked } from './blocked';
export { detectConsent, isConsentChoice } from './consent';
export { detectOverlay } from './overlay';
export { detectSignedOut, isGoogleSignInPage } from './signed-out';
export { pageSnapshot, snapshotScript, type PageSnapshot } from './snapshot';

import { detectBlocked } from './blocked';
import { detectConsent } from './consent';
import { detectOverlay } from './overlay';
import { detectSignedOut } from './signed-out';
import type { PageSnapshot } from './snapshot';

export type Interrupt = { kind: 'blocked' } | { kind: 'consent'; choices: string[] } | { kind: 'signed_out' } | { kind: 'overlay'; close: string };

/** The interrupt on the page, most severe first, or null. */
export function detectInterrupt(p: PageSnapshot): Interrupt | null {
  if (detectBlocked(p)) return { kind: 'blocked' };
  const c = detectConsent(p);
  if (c) return { kind: 'consent', choices: c.choices };
  if (detectSignedOut(p)) return { kind: 'signed_out' };
  const o = detectOverlay(p);
  return o ? { kind: 'overlay', close: o.close } : null;
}
