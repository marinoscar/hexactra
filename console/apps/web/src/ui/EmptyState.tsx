import { Box, Button, Typography } from '@mui/material';
import type { ElementType, ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import type { PageAction } from './PageHeader';

export interface EmptyStateProps {
  Icon?: ElementType;
  title: string;
  body?: ReactNode;
  action?: PageAction;
}

/** What a list shows when it has nothing: "no tasks yet", "nothing waiting", "no runs match". */
export function EmptyState({ Icon, title, body, action }: EmptyStateProps) {
  const ActionIcon = action?.Icon;
  return (
    <Box role="status" sx={{ textAlign: 'center', py: { xs: 4, sm: 6 }, px: 2, color: 'text.secondary' }}>
      {Icon && <Icon aria-hidden sx={{ fontSize: 48, mb: 1, opacity: 0.7 }} />}
      <Typography variant="h6" component="p" color="text.primary">
        {title}
      </Typography>
      {body && <Typography sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>{body}</Typography>}
      {action && !action.hidden && (
        <Button
          variant="contained"
          color={action.color ?? 'primary'}
          disabled={action.disabled}
          startIcon={ActionIcon ? <ActionIcon /> : undefined}
          sx={{ mt: 2, minHeight: { xs: 44, sm: 'auto' } }}
          {...(action.to !== undefined ? { component: RouterLink, to: action.to } : {})}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </Box>
  );
}
