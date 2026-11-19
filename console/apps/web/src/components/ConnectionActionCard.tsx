// What the owner is asked to approve when the agent uses one of their accounts (E39.10, #607): the card the SERVER built from the validated
// call, never from model text. An email shows From, To, Subject and a preview of the body with "Show all"; an event the title, the time, the
// attendees and "They will be notified"; a row the file and the cells. Plain text only: nothing here renders HTML.
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import { useState } from 'react';

import { ProviderMark } from '../connections/ProviderMark';
import type { QuestionAction } from './questions';

const TOOL_WORDS: Record<string, string> = {
  mail_send: 'send an email',
  mail_modify: 'organise your mail',
  calendar_create_event: 'create an event',
  calendar_update_event: 'change an event',
  calendar_delete_event: 'delete an event',
  docs_create: 'create a document',
  docs_append: 'add to a document',
  sheet_append_rows: 'add a row to a spreadsheet',
  sheet_create: 'create a spreadsheet',
  file_upload: 'save a file',
};

/** "send an email" for a tool the card knows; the tool's own name otherwise. */
export const toolWords = (tool: string): string => TOOL_WORDS[tool] ?? tool.replace(/_/g, ' ');

/** Whether a calendar call will email people: the server's attendees line says so in words. */
export function notifiesPeople(a: QuestionAction): boolean {
  if (!a.tool.startsWith('calendar_')) return false;
  return a.lines.some((l) => /will be emailed|the event's attendees|@/.test(l.value) && l.label.startsWith('Attendees') && !/will not be emailed|^no one$|^none$/.test(l.value.trim()));
}

export function ConnectionActionCard({ action }: { action: QuestionAction }) {
  const [all, setAll] = useState(false);
  return (
    <Paper variant="outlined" data-testid="connection-action-card" sx={{ p: 1.5, mt: 1.5, minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
        <ProviderMark provider="google" fontSize="small" />
        <Typography variant="subtitle2" component="h3" sx={{ overflowWrap: 'anywhere' }}>
          {`${action.connectionLabel}: ${toolWords(action.tool)}`}
        </Typography>
      </Stack>
      <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'max-content 1fr' }, columnGap: 2, rowGap: { xs: 0.25, sm: 0.75 } }}>
        {action.lines.map((l, i) => (
          <Box key={`${l.label}-${i}`} sx={{ display: 'contents' }}>
            <Typography component="dt" variant="body2" color="text.secondary" sx={{ mt: { xs: 0.75, sm: 0 } }}>
              {l.label}
            </Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
              {l.value}
            </Typography>
          </Box>
        ))}
      </Box>
      {notifiesPeople(action) && (
        <Alert severity="warning" variant="outlined" sx={{ mt: 1 }} data-testid="notify-warning">
          They will be notified.
        </Alert>
      )}
      {action.body && (
        <Box sx={{ mt: 1 }}>
          <Button size="small" onClick={() => setAll((v) => !v)} aria-expanded={all} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
            {all ? 'Hide' : 'Show all'}
          </Button>
          {all && (
            <Typography component="pre" variant="body2" data-testid="action-body" sx={{ m: 0, mt: 0.5, p: 1, bgcolor: 'action.hover', borderRadius: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', maxHeight: 320, overflow: 'auto' }}>
              {action.body}
            </Typography>
          )}
        </Box>
      )}
    </Paper>
  );
}
