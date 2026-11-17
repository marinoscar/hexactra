import { Container } from '@mui/material';
import type { ReactNode } from 'react';

export type PageWidth = 'narrow' | 'default' | 'wide';

const MAX_WIDTH = { narrow: 'sm', default: 'md', wide: 'lg' } as const;

export interface PageContainerProps {
  /** `narrow` (sm: forms, the inbox), `default` (md) or `wide` (lg: lists, dashboards). */
  width?: PageWidth;
  children: ReactNode;
}

/**
 * The frame of a page: a centred column of one of three widths.
 *
 * The shell's `<main>` already pads every page 24 px on each side, so the
 * container adds vertical padding only (`{ xs: 2, sm: 3, md: 4 }`): a second
 * side gutter would cost a phone 32 px of its width.
 */
export function PageContainer({ width = 'default', children }: PageContainerProps) {
  return (
    <Container maxWidth={MAX_WIDTH[width]} disableGutters sx={{ py: { xs: 2, sm: 3, md: 4 }, minWidth: 0 }}>
      {children}
    </Container>
  );
}
