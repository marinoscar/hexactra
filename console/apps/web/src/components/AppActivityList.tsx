import { Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { EmptyState, ErrorBanner, ListSkeleton, RelativeTime, ResponsiveList, type Column } from '../ui';

/** One row of the AI app audit trail (`GET /api/connected-apps/activity`, `GET /api/admin/mcp/activity`, #465). */
export interface AppActivityRow {
  id: string;
  createdAt: string;
  userId: string;
  event: string;
  credentialKind: string;
  clientId: string | null;
  clientName: string | null;
  tool: string | null;
  effect: string | null;
  runId: string | null;
  taskId: string | null;
  sessionId: string | null;
  questionId: string | null;
  outcome: string;
  errorCode: string | null;
  durationMs: number;
  requestId: string | null;
  detail: Record<string, unknown> | null;
}

/** What an event that is not a tool call reads as. */
const EVENT_LABEL: Readonly<Record<string, string>> = {
  step_up: 'asked for more permission',
  rate_limited: 'refused: too many requests',
  kill_switch: 'refused: external AI apps are off',
  app_settings: 'limits changed',
  admin_disconnect: 'disconnected by an administrator',
};

const OUTCOME: Readonly<Record<string, { label: string; color: 'default' | 'success' | 'warning' | 'error' | 'info' }>> = {
  ok: { label: 'Done', color: 'success' },
  error: { label: 'Failed', color: 'error' },
  still_working: { label: 'Still working', color: 'info' },
  confirmation_required: { label: 'Needs your approval', color: 'warning' },
  refused: { label: 'Refused', color: 'warning' },
};

/** What the row did, in words: the tool (or the event) and the kept detail. */
export function activityWhat(r: AppActivityRow): string {
  const what = r.tool ?? EVENT_LABEL[r.event] ?? r.event;
  const d = r.detail ?? {};
  const extra = typeof d.host === 'string' ? ` ${d.host}` : typeof d.selector === 'string' ? ` ${d.selector}` : typeof d.goal === 'string' ? `: ${d.goal}` : typeof d.scriptLength === 'number' ? ` (script, ${d.scriptLength} characters)` : Array.isArray(d.changed) ? `: ${(d.changed as string[]).join(', ')}` : '';
  return `${what}${extra}`;
}

/** Who made the call: the app, or the client a personal access token named. */
export function activityWho(r: AppActivityRow): string {
  if (r.clientName) return r.clientName;
  if (r.credentialKind === 'pat') return 'Personal access token';
  if (r.credentialKind === 'jwt') return 'You, in the console';
  return 'An AI app';
}

function OutcomeChip({ r }: { r: AppActivityRow }) {
  const o = OUTCOME[r.outcome] ?? { label: r.outcome, color: 'default' as const };
  return <Chip size="small" color={o.color} variant="outlined" label={r.errorCode && r.outcome !== 'confirmation_required' ? `${o.label} · ${r.errorCode}` : o.label} />;
}

function Target({ r }: { r: AppActivityRow }) {
  const id = r.runId ?? r.sessionId;
  return id ? (
    <Button component={RouterLink} to={`/runs/${id}`} size="small" sx={{ minHeight: 32, px: 0.5 }}>
      {r.sessionId && !r.runId ? 'Session' : 'Run'}
    </Button>
  ) : null;
}

export interface AppActivityListProps {
  /** `GET` path without the query: `/connected-apps/activity` (own) or `/admin/mcp/activity` (everyone, an administrator). */
  path: '/connected-apps/activity' | '/admin/mcp/activity';
  /** Only this app (`clientId`). */
  clientId?: string;
  /** Show who made each call (the administrator's list of everyone). */
  showUser?: boolean;
  /** Rows per page. */
  pageSize?: number;
}

/**
 * The audit trail of external AI apps (#465), newest first, with "Load more"
 * (keyset paging). Sanitized on the server: never typed text, a script or a
 * result, only what each call did, to what, and how it ended.
 */
export function AppActivityList({ path, clientId, showUser = false, pageSize = 25 }: AppActivityListProps) {
  const { api } = usePlatformHost();
  const [rows, setRows] = useState<AppActivityRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (after: string | null) => {
      setBusy(true);
      setError(null);
      try {
        const q = new URLSearchParams({ limit: String(pageSize) });
        if (clientId) q.set('clientId', clientId);
        if (after) q.set('cursor', after);
        const page = await api.get<{ items: AppActivityRow[]; nextCursor: string | null }>(`${path}?${q}`);
        setRows((prev) => (after && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load the activity');
      } finally {
        setBusy(false);
      }
    },
    [api, path, clientId, pageSize],
  );
  useEffect(() => {
    void load(null);
  }, [load]);

  if (rows === null) return error ? <ErrorBanner error={error} onRetry={() => void load(null)} /> : <ListSkeleton />;
  if (rows.length === 0) return <EmptyState title="No activity yet" body="Each tool call an AI app makes appears here." />;

  const columns: Column<AppActivityRow>[] = [
    { key: 'when', header: 'When', width: 130, render: (r) => <RelativeTime iso={r.createdAt} /> },
    ...(showUser ? [{ key: 'user', header: 'User', width: 120, render: (r: AppActivityRow) => <Typography variant="body2" noWrap title={r.userId}>{r.userId.slice(0, 8)}</Typography> }] : []),
    { key: 'who', header: 'App', width: 160, render: (r) => activityWho(r) },
    { key: 'what', header: 'What', grow: true, render: (r) => <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{activityWhat(r)}</Typography> },
    { key: 'outcome', header: 'Outcome', width: 200, render: (r) => <OutcomeChip r={r} /> },
    { key: 'target', header: 'Run', width: 90, hideBelow: 'lg', render: (r) => <Target r={r} /> },
  ];
  const card = (r: AppActivityRow) => (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="subtitle2" sx={{ wordBreak: 'break-word', minWidth: 0 }}>
          {activityWhat(r)}
        </Typography>
        <OutcomeChip r={r} />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {activityWho(r)}
        {showUser ? ` · user ${r.userId.slice(0, 8)}` : ''} · <RelativeTime iso={r.createdAt} />
      </Typography>
      <Target r={r} />
    </Paper>
  );
  return (
    <Box>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <ResponsiveList
        aria-label="AI app activity"
        items={rows}
        columns={columns}
        renderCard={card}
        getKey={(r) => r.id}
        getLabel={(r) => activityWhat(r)}
        footer={
          cursor ? (
            <Button onClick={() => void load(cursor)} disabled={busy} sx={{ minHeight: 44, mt: 1 }}>
              Load more
            </Button>
          ) : null
        }
      />
    </Box>
  );
}
