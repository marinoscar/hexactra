// A section of the Connections and tools page (E50.14, #984): a heading (with a smaller second name: "Added tools" beside "MCP servers"),
// one line in plain words, its own Add or Set up button, and its rows or an empty state that says what it is for and what to do.
import { Box, Button, List, Paper, Stack, Typography } from '@mui/material';
import type { ElementType, ReactNode } from 'react';

export interface SectionAction {
  label: string;
  Icon?: ElementType;
  onClick: () => void;
}

export interface ConnectionsSectionProps {
  title: string;
  /** A second, smaller name: the technical word for it. */
  aside?: string;
  explanation: ReactNode;
  action?: SectionAction | null;
  /** Shown when there are no rows; the rows go in `children`. */
  empty?: ReactNode;
  /** Content that is not a list of rows (the web search block). */
  body?: ReactNode;
  children?: ReactNode;
  id?: string;
}

export function ConnectionsSection({ title, aside, explanation, action, empty, body, children, id }: ConnectionsSectionProps) {
  const ActionIcon = action?.Icon;
  const rows = Array.isArray(children) ? children.filter(Boolean).length > 0 : Boolean(children);
  return (
    <Box component="section" aria-label={title} sx={{ mb: 3, scrollMarginTop: 80 }} id={id}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'flex-end' }, justifyContent: 'space-between', mb: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" component="h2">
            {title}
            {aside && (
              <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                {aside}
              </Typography>
            )}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {explanation}
          </Typography>
        </Box>
        {action && (
          <Button variant="outlined" onClick={action.onClick} startIcon={ActionIcon ? <ActionIcon /> : undefined} sx={{ minHeight: 44, flexShrink: 0, alignSelf: { xs: 'flex-start', sm: 'auto' } }}>
            {action.label}
          </Button>
        )}
      </Stack>
      {body ?? (
        <Paper variant="outlined">
          {rows ? <List disablePadding>{children}</List> : empty}
        </Paper>
      )}
    </Box>
  );
}

/** The empty state inside a section: what it is for and what to do. */
export function SectionEmpty({ title, body }: { title: string; body: ReactNode }) {
  return (
    <Box role="status" sx={{ p: { xs: 2, sm: 3 } }}>
      <Typography variant="subtitle1" component="p">
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
        {body}
      </Typography>
    </Box>
  );
}
