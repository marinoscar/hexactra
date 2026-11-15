import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';

import { DISPLAY_FONT } from '../theme';

/** The Trace mark's path (docs/brand/hexactra-mark.svg), on a 120-unit grid. */
const TRACE_PATH = 'M60 60V108L18.4 84V36L60 12L101.6 36V84L80 96.5';

/** The Trace mark alone: one line drawing a hexagon from its starting point. */
export function BrandMark({ size = 28 }: { size?: number }) {
  const theme = useTheme();
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} aria-hidden="true" focusable="false">
      <path d={TRACE_PATH} fill="none" stroke={theme.palette.primary.main} strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={60} cy={60} r={13} fill={theme.palette.secondary.main} />
    </svg>
  );
}

/** The app bar brand: the mark and the lowercase wordmark. The product name stays the accessible name. */
export function BrandLogo({ label }: { label: string }) {
  return (
    <Box component="span" role="img" aria-label={label} sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      <BrandMark />
      <Box
        component="span"
        aria-hidden="true"
        sx={{ fontFamily: DISPLAY_FONT, fontWeight: 700, fontSize: '1.3rem', letterSpacing: '-0.02em', lineHeight: 1, color: 'text.primary' }}
      >
        hexactra
      </Box>
    </Box>
  );
}
