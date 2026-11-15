import { BACKGROUND_COLOR, THEME_COLOR } from '@app/shared';
import { createTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import { createShellTheme } from '@marinoscar/platform-web/shell/headless';
import { withTelemetryTokens } from '@marinoscar/platform-web/telemetry/headless';

/**
 * The hexactra brand tokens (docs/brand/README.md). The light primary and
 * background come from identity.json, so a rename still recolours the app; the
 * rest of the palette is the brand's and lives here, not in the packages.
 */
export const BRAND = {
  light: {
    primary: THEME_COLOR, // #4b4be8
    primaryLight: '#7a7af0',
    primaryDark: '#2e2ea8',
    accent: '#ff6b4a',
    accentDark: '#c2412a',
    background: BACKGROUND_COLOR, // #f6f6fb
    surface: '#ffffff',
    text: '#12131c',
    muted: '#5a5e72',
    divider: '#e3e4ef',
  },
  dark: {
    primary: '#8c8cff',
    primaryLight: '#b3b3ff',
    primaryDark: '#6262e0',
    accent: '#ff8a6e',
    accentDark: '#ff6b4a',
    background: '#0d0e17',
    surface: '#181a28',
    text: '#ecedf7',
    muted: '#a3a7bd',
    divider: '#2a2d42',
  },
} as const;

/** The wordmark and heading face; body text stays Inter (the shell's default). */
export const DISPLAY_FONT = '"Space Grotesk", "Inter", "Helvetica Neue", Arial, sans-serif';

function brandTypography(theme: Theme): Theme {
  const heading = { fontFamily: DISPLAY_FONT, fontWeight: 700, letterSpacing: '-0.01em' };
  return withTelemetryTokens(
    createTheme(theme, {
      typography: { h1: heading, h2: heading, h3: heading, h4: heading },
      components: {
        MuiAppBar: { styleOverrides: { root: { borderBottomColor: theme.palette.divider } } },
      },
    }),
  );
}

function shellTheme(mode: 'light' | 'dark'): Theme {
  const t = BRAND[mode];
  return createShellTheme(mode, {
    palette: {
      primary: { main: t.primary, light: t.primaryLight, dark: t.primaryDark, contrastText: mode === 'light' ? '#ffffff' : '#0d0e17' },
      secondary: { main: t.accent, dark: t.accentDark, contrastText: mode === 'light' ? '#12131c' : '#0d0e17' },
      background: { default: t.background, paper: t.surface },
      text: { primary: t.text, secondary: t.muted },
      divider: t.divider,
    },
    extend: brandTypography,
  });
}

/**
 * The app owns its theme: the platform shell's light and dark themes in the
 * hexactra palette, plus the telemetry tokens the packaged pages read.
 */
export const APP_THEMES = {
  light: shellTheme('light'),
  dark: shellTheme('dark'),
};
