import { APP_SLUG } from '@app/shared';
import { PlatformHttpClient, createPlatformApiClient, type PlatformApiClient } from '@marinoscar/platform-web/core';

/** The one HTTP client: same-origin `/api`, the refresh cookie, one refresh at a time across tabs. */
export const api = new PlatformHttpClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL || '/api',
  refreshLockName: `${APP_SLUG}-auth-refresh`,
});

/** The transport packaged pages use (`PlatformWebHost.api`): the platform's adapter over the same client. */
export const platformApi = createPlatformApiClient(api);

// ---- Run export (#542, #543, #544) ----

/** What `exportRun` takes: the file's format, whether it embeds the pictures, and the PDF's paper. */
export interface RunExportOptions {
  format: 'json' | 'pdf';
  /** Embed the masked screenshots (default true). */
  screenshots?: boolean;
  /** The PDF's paper; ignored for JSON. Default: from the browser's locale. */
  paper?: 'a4' | 'letter';
}

/** A downloaded file: the bytes and the name the server chose. */
export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

/** Letter in the United States, Canada and the few others that use it; A4 elsewhere. */
export function defaultPaper(locale: string = typeof navigator === 'undefined' ? 'en-US' : navigator.language): 'a4' | 'letter' {
  const region = /[-_]([A-Za-z]{2})\b/.exec(locale)?.[1]?.toUpperCase();
  return region && ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE'].includes(region) ? 'letter' : 'a4';
}

/** `GET /runs/{id}/export`'s path and query for these options. */
export function runExportPath(id: string, { format, screenshots = true, paper }: RunExportOptions): string {
  const q = new URLSearchParams({ format, screenshots: screenshots ? 'embed' : 'none' });
  if (format === 'pdf') q.set('paper', paper ?? defaultPaper());
  return `/runs/${encodeURIComponent(id)}/export?${q.toString()}`;
}

/** The file name of a `Content-Disposition` header (`filename*=UTF-8''…`, `filename="…"`, `filename=…`), or null. */
export function filenameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  let name: string | null = null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended?.[1]) {
    try {
      name = decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
    } catch {
      name = null;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
    name = plain ? (plain[2] ?? plain[1] ?? '').trim() : null;
  }
  const safe = name?.replace(/[/\\]/g, '_').trim();
  return safe || null;
}

/**
 * Download a run's trace (JSON, #542) or report (PDF, #543) through the
 * signed-in client: the bearer token and the refresh are the session's, the
 * name is the server's `Content-Disposition`. A live run's file is partial.
 */
export async function exportRun(client: PlatformApiClient, id: string, options: RunExportOptions): Promise<DownloadedFile> {
  if (!client.getBlob) throw new Error('This client cannot download files');
  const res = await client.getBlob(runExportPath(id, options));
  const fallback = `hexactra-run-${id.slice(0, 8)}.${options.format}`;
  return { blob: res.blob, filename: filenameFromDisposition(res.headers.get('content-disposition')) ?? fallback };
}

/** Hand a downloaded file to the browser: an object URL clicked through a hidden link, revoked after the click. */
export function saveDownload({ blob, filename }: DownloadedFile): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Deferred: revoking at once can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
