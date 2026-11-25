import CloseIcon from '@mui/icons-material/Close';
import { Alert, Box, ButtonBase, Dialog, IconButton, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

import { fetchScanImage } from '../live';
import type { QuestionScan } from './questions';

/** How often a scan's picture is taken again while it is on screen: sign-in codes rotate within a minute or two. */
export const SCAN_REFRESH_MS = 2_000;

/** The warning every scan card shows, whatever the site (#924). It cannot be switched off. */
export function scanWarning(domain: string): string {
  return `Only scan this if you just started a sign-in to ${domain}. Scanning a code from a site you did not open can sign someone else in as you.`;
}

export const SCAN_BLUETOOTH_TEXT = 'Your phone must be near the computer running the browser, with Bluetooth on.';

/**
 * The live picture of a scan question (#924): what the owner scans or reads with their phone, taken by the server every 2 s while the card
 * is shown and never stored. Large (the full width of the card), tap for full screen. The permanent warning names the site the browser
 * reported; when the browser has moved to another site, or its address could not be read, the picture is replaced by "Do not scan".
 */
export function ScanPicture({ questionId, scan }: { questionId: string; scan: QuestionScan }) {
  const [src, setSrc] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!scan.domain) return undefined;
    let stopped = false;
    let current: string | null = null;
    const next = async () => {
      if (document.visibilityState === 'hidden') return;
      const frame = await fetchScanImage(questionId).catch(() => null);
      if (stopped) {
        if (frame?.ok) URL.revokeObjectURL(frame.url);
        return;
      }
      if (current) URL.revokeObjectURL(current);
      current = frame?.ok ? frame.url : null;
      setSrc(current);
      // A browser that left the site, or a closed request, shows why instead of a stale code.
      setRefused(frame && !frame.ok && frame.refused ? frame.message : null);
    };
    void next();
    const t = setInterval(() => void next(), SCAN_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(t);
      if (current) URL.revokeObjectURL(current);
    };
  }, [questionId, scan.domain]);

  if (!scan.domain) {
    return (
      <Alert severity="error" sx={{ mt: 2 }}>
        Hexactra could not read the page&apos;s address, so it shows no picture. Do not scan anything for this request.
      </Alert>
    );
  }
  return (
    <Box sx={{ mt: 2 }}>
      <Alert severity="warning" sx={{ overflowWrap: 'anywhere' }}>
        {scanWarning(scan.domain)}
        {scan.source === 'desktop' && (
          <>
            {' '}
            <strong>{SCAN_BLUETOOTH_TEXT}</strong>
          </>
        )}
      </Alert>
      {refused ? (
        <Alert severity="error" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
          {refused}
        </Alert>
      ) : src ? (
        <ButtonBase onClick={() => setOpen(true)} aria-label="Show the code full screen" sx={{ mt: 1, display: 'block', width: '100%', borderRadius: 1, overflow: 'hidden', border: 1, borderColor: 'divider' }}>
          <Box component="img" src={src} alt={`What to scan on ${scan.domain}`} sx={{ display: 'block', width: '100%', height: 'auto', imageRendering: 'crisp-edges' }} />
        </ButtonBase>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Taking a picture of the screen…
        </Typography>
      )}
      <Dialog open={open && Boolean(src)} onClose={() => setOpen(false)} fullScreen>
        <IconButton aria-label="Close" onClick={() => setOpen(false)} sx={{ position: 'absolute', top: 8, right: 8, bgcolor: 'background.paper' }}>
          <CloseIcon />
        </IconButton>
        {src && <Box component="img" src={src} alt={`What to scan on ${scan.domain}`} sx={{ width: '100%', height: '100%', objectFit: 'contain', bgcolor: 'common.black' }} />}
      </Dialog>
    </Box>
  );
}
