// A task form section that stays folded until it is used (E39.10, #607): a button with the title and a one-line summary, and the
// editor below it when open. The summary is what the owner reads without opening it.
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Box, ButtonBase, Card, CardContent, Collapse, Typography } from '@mui/material';
import { useId, type ReactNode } from 'react';

export interface CollapsedSectionProps {
  title: string;
  /** One line shown while folded (and under the title when open). */
  summary: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  anchor?: string;
  children: ReactNode;
}

export function CollapsedSection({ title, summary, open, onToggle, anchor, children }: CollapsedSectionProps) {
  const uid = useId();
  return (
    <Card variant="outlined" component="section" aria-labelledby={`${uid}-title`} id={anchor} sx={{ scrollMarginTop: 72 }}>
      <CardContent sx={{ p: { xs: 2, sm: 3 }, '&:last-child': { pb: { xs: 2, sm: 3 } } }}>
        <ButtonBase
          onClick={() => onToggle(!open)}
          aria-expanded={open}
          aria-controls={`${uid}-body`}
          sx={{ display: 'flex', width: '100%', textAlign: 'left', alignItems: 'center', gap: 1, minHeight: 44, justifyContent: 'space-between', borderRadius: 1 }}
        >
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" component="h2" id={`${uid}-title`}>
              {title}
            </Typography>
            <Typography variant="body2" color="text.secondary" data-testid={anchor ? `${anchor}-summary` : undefined} sx={{ overflowWrap: 'anywhere' }}>
              {summary}
            </Typography>
          </Box>
          {open ? <ExpandLessIcon aria-hidden /> : <ExpandMoreIcon aria-hidden />}
        </ButtonBase>
        <Collapse in={open} id={`${uid}-body`} unmountOnExit>
          <Box sx={{ mt: 2, display: 'grid', gap: 2 }}>{children}</Box>
        </Collapse>
      </CardContent>
    </Card>
  );
}
