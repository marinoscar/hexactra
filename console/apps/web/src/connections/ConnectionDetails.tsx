// What an account is used for (E39.10, #607), under its row on the Connections page: what uses it (tasks, chats, deliveries, triggers), what it
// was used for lately (the operation, the time and the run: never content), and the approvals remembered for it, with a link to Saved
// approvals. Loaded when opened. The tools of an MCP connection are #606's.
import { Box, Button, Chip, Collapse, Link, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { SAVED_APPROVALS_PATH, savedApprovalHref, type ApprovalRule, type ApprovalRulesList } from '../approvals/types';
import { RelativeTime } from '../ui';
import { getConnection, type ConnectionUsage } from './api';
import { connectionActivity, type ConnectionActivityItem } from './files';

const KIND_WORDS: Record<string, string> = { task: 'Task', chat: 'Chat', delivery: 'Delivery', trigger: 'Email trigger', mail_trigger: 'Email trigger', conversation: 'Chat' };
const OPERATION_WORDS: Record<string, string> = {
  mail_search: 'Searched mail',
  mail_read: 'Read an email',
  mail_attachment_to_browser: 'Took an attachment',
  mail_draft: 'Saved a draft',
  mail_send: 'Sent an email',
  mail_modify: 'Organised mail',
  calendar_list: 'Looked at the calendar',
  calendar_free_busy: 'Checked free time',
  calendar_create_event: 'Created an event',
  calendar_update_event: 'Changed an event',
  calendar_delete_event: 'Deleted an event',
  docs_search: 'Searched files',
  docs_read: 'Read a document',
  sheet_read: 'Read a spreadsheet',
  docs_create: 'Created a document',
  docs_append: 'Added text to a document',
  sheet_append_rows: 'Added rows to a spreadsheet',
  sheet_create: 'Created a spreadsheet',
  file_upload: 'Saved a file',
  email: 'Sent a report by email',
  sheet_row: 'Added a row after a run',
  folder: 'Saved files after a run',
  webhook: 'Sent to a web address',
};

export const operationWords = (op: string): string => OPERATION_WORDS[op] ?? op.replace(/_/g, ' ');

export function ConnectionDetails({ connectionId, canReadRuns }: { connectionId: string; canReadRuns: boolean }) {
  const { api, viewer } = usePlatformHost();
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState<ConnectionUsage[] | null>(null);
  const [activity, setActivity] = useState<ConnectionActivityItem[] | null>(null);
  const [rules, setRules] = useState<ApprovalRule[] | null>(null);
  const [failed, setFailed] = useState(false);
  const canRules = viewer.hasPermission('runs:read');

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setFailed(false);
    getConnection(api, connectionId)
      .then((d) => !stale && setUsed(d.usedBy))
      .catch(() => !stale && setFailed(true));
    connectionActivity(api, connectionId)
      .then((r) => !stale && setActivity(r.items))
      .catch(() => !stale && setActivity([]));
    if (canRules) {
      api
        .get<ApprovalRulesList>('/approval-rules')
        .then((l) => !stale && setRules((l.rules ?? []).filter((r) => r.kind === 'connection' && r.host === connectionId)))
        .catch(() => !stale && setRules([]));
    }
    return () => {
      stale = true;
    };
  }, [api, connectionId, open, canRules]);

  return (
    <Box sx={{ mt: 1 }}>
      <Button size="small" onClick={() => setOpen((v) => !v)} aria-expanded={open} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
        {open ? 'Hide what it is used for' : 'What it is used for'}
      </Button>
      <Collapse in={open} unmountOnExit>
        <Stack spacing={2} sx={{ mt: 1 }} data-testid={`connection-details-${connectionId}`}>
          {failed && <Typography color="error">Could not load the details.</Typography>}
          <Box>
            <Typography variant="subtitle2" component="h3">
              Used by
            </Typography>
            {used === null ? (
              <Typography variant="body2" color="text.secondary">
                Loading…
              </Typography>
            ) : used.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Nothing uses it yet. A task or chat has to be told to.
              </Typography>
            ) : (
              <Stack component="ul" spacing={0.5} sx={{ m: 0, p: 0, listStyle: 'none' }}>
                {used.map((u) => (
                  <Box component="li" key={`${u.kind}-${u.id}`} sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Chip size="small" variant="outlined" label={KIND_WORDS[u.kind] ?? u.kind} />
                    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                      {u.name}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            )}
          </Box>
          <Box>
            <Typography variant="subtitle2" component="h3">
              Recent activity
            </Typography>
            {activity === null ? (
              <Typography variant="body2" color="text.secondary">
                Loading…
              </Typography>
            ) : activity.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Nothing yet.
              </Typography>
            ) : (
              <Stack component="ul" spacing={0.5} sx={{ m: 0, p: 0, listStyle: 'none' }}>
                {activity.map((a, i) => (
                  <Box component="li" key={`${a.at}-${i}`} data-testid="connection-activity-item" sx={{ display: 'flex', gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <Typography variant="body2" color={a.ok ? undefined : 'error'}>
                      {operationWords(a.operation)}
                      {a.ok ? '' : ' (failed)'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      <RelativeTime iso={a.at} />
                    </Typography>
                    {a.runId && canReadRuns && (
                      <Link component={RouterLink} to={`/runs/${a.runId}`} variant="caption" underline="hover">
                        The run
                      </Link>
                    )}
                  </Box>
                ))}
              </Stack>
            )}
          </Box>
          {canRules && (
            <Box>
              <Typography variant="subtitle2" component="h3">
                Approvals you saved for it
              </Typography>
              {rules === null ? (
                <Typography variant="body2" color="text.secondary">
                  Loading…
                </Typography>
              ) : rules.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  None. The agent asks each time it wants to send or change something.
                </Typography>
              ) : (
                <Stack component="ul" spacing={0.5} sx={{ m: 0, p: 0, listStyle: 'none' }}>
                  {rules.map((r) => (
                    <Box component="li" key={r.id}>
                      <Link component={RouterLink} to={savedApprovalHref(r.id)} variant="body2" underline="hover" sx={{ overflowWrap: 'anywhere' }}>
                        {r.summary}
                      </Link>
                    </Box>
                  ))}
                </Stack>
              )}
              <Link component={RouterLink} to={SAVED_APPROVALS_PATH} variant="body2" sx={{ display: 'inline-block', mt: 0.5 }}>
                Saved approvals
              </Link>
            </Box>
          )}
        </Stack>
      </Collapse>
    </Box>
  );
}
