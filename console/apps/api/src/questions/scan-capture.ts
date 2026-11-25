// The picture of a scan question (#924): what the owner scans or reads on the node's screen. Captured by the SERVER through the fabric,
// on request, and never stored: no row, no artifact the console keeps, no trace image (the run's trace keeps its masked picture as for any
// question). The page's address is read from the browser at every capture and compared with the one the question was opened on, so a page
// that moved to another site never shows its code on the owner's card.
import { registrableDomain } from '../approvals/approval-match';
import { FabricError, type FabricClient } from '../fabric/fabric.client';
import { FabricSession } from '../runner/fabric-session';
import type { QuestionScan, ScanSource } from './questions.contract';

/** How long one capture may take. */
const CAPTURE_TIMEOUT_MS = 15_000;

/** A page's site as the card names it: its registrable domain, or the host itself for a page without one (an IP, `localhost`); null otherwise. */
export function scanDomain(url: string | null | undefined): string | null {
  const d = registrableDomain(url);
  if (d) return d;
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase() || null : null;
  } catch {
    return null;
  }
}

function originOf(url: string | null | undefined): string | null {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Why there is no picture: the code the endpoint answers with and the sentence the card shows. */
export class ScanCaptureError extends Error {
  constructor(
    readonly code: 'SCAN_PAGE_CHANGED' | 'SCAN_PAGE_UNKNOWN' | 'SCAN_CAPTURE_FAILED',
    message: string,
  ) {
    super(message);
  }
}

interface Shot {
  url: string | null;
  artifactId: string;
}

/** A plain screenshot of the session's active tab (no marks, no mask): allowed while a handoff waits (#525). */
async function pageShot(fabric: FabricClient, sessionId: string): Promise<Shot> {
  const op = await new FabricSession(fabric).act(sessionId, { type: 'screenshot' }, CAPTURE_TIMEOUT_MS, { waitForTakeover: false });
  const artifactId = op.result?.artifact_id;
  if (op.state !== 'succeeded' || typeof artifactId !== 'string') throw new ScanCaptureError('SCAN_CAPTURE_FAILED', op.error ?? `The screenshot ${op.state}`);
  const url = typeof op.result?.url === 'string' ? op.result.url : null;
  return { url, artifactId };
}

/** The scan's facts when the question opens: the source asked for, and the address the browser reports now. Never throws: an unreadable page gives null. */
export async function scanFacts(fabric: FabricClient, sessionId: string | null, source: ScanSource): Promise<QuestionScan> {
  if (!sessionId) return { source, domain: null, origin: null };
  try {
    const { url } = await pageShot(fabric, sessionId);
    return { source, domain: scanDomain(url), origin: originOf(url) };
  } catch {
    return { source, domain: null, origin: null };
  }
}

/**
 * One fresh picture for the card: the page, or the node's desktop for Chrome's own passkey window. Refused when the question's address is
 * unknown, or when the tab is no longer on that site (a redirect, a new page): the owner must never be shown another site's code.
 */
export async function captureScan(fabric: FabricClient, sessionId: string, scan: QuestionScan): Promise<{ bytes: Buffer; mime: string; domain: string }> {
  if (!scan.domain) throw new ScanCaptureError('SCAN_PAGE_UNKNOWN', "Hexactra could not read the page's address, so it shows no picture. Do not scan anything for this request.");
  try {
    const page = await pageShot(fabric, sessionId);
    const now = scanDomain(page.url);
    if (now !== scan.domain) {
      throw new ScanCaptureError('SCAN_PAGE_CHANGED', `The browser is no longer on ${scan.domain}. Do not scan anything for this request.`);
    }
    let artifactId = page.artifactId;
    if (scan.source === 'desktop') {
      const op = await new FabricSession(fabric).act(sessionId, { type: 'desktop_screenshot' }, CAPTURE_TIMEOUT_MS, { waitForTakeover: false });
      const id = op.result?.artifact_id;
      if (op.state !== 'succeeded' || typeof id !== 'string') throw new ScanCaptureError('SCAN_CAPTURE_FAILED', op.error ?? `The desktop screenshot ${op.state}`);
      artifactId = id;
    }
    const res = await fabric.raw('GET', `/v1/artifacts/${artifactId}`, { retries: 0 });
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'image/jpeg', domain: scan.domain };
  } catch (e) {
    if (e instanceof ScanCaptureError) throw e;
    if (e instanceof FabricError) throw new ScanCaptureError('SCAN_CAPTURE_FAILED', e.message);
    throw e;
  }
}
