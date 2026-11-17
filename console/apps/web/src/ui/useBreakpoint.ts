import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';

export interface Breakpoint {
  /** Below `sm` (600 px). */
  isPhone: boolean;
  /** `sm` to below `md` (600 to 899 px). */
  isTablet: boolean;
  /** `md` (900 px) and up. */
  isDesktop: boolean;
}

/**
 * The width class of the window, from the theme's breakpoints (never the user
 * agent). Where `matchMedia` is missing (a jsdom test that did not mock it)
 * the window reads as a desktop.
 */
export function useBreakpoint(): Breakpoint {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const belowDesktop = useMediaQuery(theme.breakpoints.down('md'));
  return { isPhone, isTablet: belowDesktop && !isPhone, isDesktop: !belowDesktop };
}
