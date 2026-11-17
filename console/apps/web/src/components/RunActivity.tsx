import { useEffect, useState } from 'react';
import { Alert, Box, LinearProgress, Paper, Stack, Typography } from '@mui/material';

/** What a running run is doing right now (`runs.activity`, #379). Arguments are redacted by the API. */
export interface RunActivity {
  phase: 'starting' | 'looking' | 'thinking' | 'acting';
  action?: string;
  args?: Record<string, unknown>;
  reason?: string;
  startedAt: string;
  timeoutMs?: number;
}

/** After this long on one activity the page says the run may be stuck. */
export const STALL_MS = 30_000;
/** A screenshot older than this is no longer called live. */
export const FRESH_FRAME_MS = 6_000;

/** "6 s", "1 min 12 s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** How long the activity has been going; never negative (the browser's clock may lag the server's). */
export function activityElapsed(a: RunActivity, now: number): number {
  const started = Date.parse(a.startedAt);
  return Number.isNaN(started) ? 0 : Math.max(0, now - started);
}

/** The action's target in a few words: a point, a selector, a URL, a key, or a length of text. */
function target(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const parts: string[] = [];
  if (typeof args.x === 'number' && typeof args.y === 'number') parts.push(`(${args.x}, ${args.y})`);
  if (typeof args.from_x === 'number' && typeof args.to_x === 'number') parts.push(`(${String(args.from_x)}, ${String(args.from_y)}) → (${String(args.to_x)}, ${String(args.to_y)})`);
  if (typeof args.selector === 'string') parts.push(args.selector);
  if (typeof args.url === 'string') parts.push(args.url);
  if (typeof args.key === 'string') parts.push(args.key);
  if (typeof args.text_length === 'number') parts.push(`${args.text_length} characters`);
  return parts.join(' ');
}

/** The headline of the activity bar. */
export function describeActivity(a: RunActivity): string {
  switch (a.phase) {
    case 'starting':
      return 'Starting the browser';
    case 'looking':
      return 'Looking at the screen';
    case 'thinking':
      return 'Thinking about the next step';
    case 'acting': {
      const t = target(a.args);
      return `Doing: ${a.action ?? 'an action'}${t ? ` ${t}` : ''}`;
    }
  }
}

/** The stall warning, or null while the activity is within normal time. */
export function stallMessage(a: RunActivity, now: number): string | null {
  const ms = activityElapsed(a, now);
  if (ms < STALL_MS) return null;
  const took = formatDuration(ms);
  if (a.phase === 'acting') return `The agent has been waiting on the browser for ${took} (${a.action ?? 'an action'}). Take over to help it, or cancel the run.`;
  if (a.phase === 'thinking') return `The model has been thinking for ${took}.`;
  return `The agent has been ${a.phase === 'starting' ? 'starting the browser' : 'taking a screenshot'} for ${took}. Take over to check the computer, or cancel the run.`;
}

/** The caption under the live frame: how old it is, and whether the browser stopped answering. */
export function frameCaption(shotAt: number | null, failing: boolean, now: number): { text: string; stale: boolean } {
  if (shotAt === null) return { text: failing ? 'No frame yet: the browser is not answering' : 'Waiting for the first frame…', stale: failing };
  const age = Math.max(0, now - shotAt);
  if (age < FRESH_FRAME_MS && !failing) return { text: `Live · updated ${formatDuration(age)} ago`, stale: false };
  return { text: `Last frame ${formatDuration(age)} ago${failing ? ': the browser is not answering' : ''}`, stale: true };
}

/** The current time, ticking every `ms` while `enabled`. */
export function useNow(enabled: boolean, ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [enabled, ms]);
  return now;
}

/** "Doing: click_at (612, 340) — Enter the MileagePlus number · 23 s / 45 s", plus a stall warning. */
export function RunActivityBar({ activity, now }: { activity: RunActivity; now: number }) {
  const elapsed = activityElapsed(activity, now);
  const stall = stallMessage(activity, now);
  const progress = activity.timeoutMs ? Math.min(100, (elapsed / activity.timeoutMs) * 100) : null;
  return (
    <Box sx={{ mb: 2 }}>
      <Paper variant="outlined" role="status" aria-label="Now" sx={{ px: 2, py: 1.5 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
          <Typography variant="subtitle2" sx={{ flexGrow: 1, wordBreak: 'break-word' }}>
            {describeActivity(activity)}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {formatDuration(elapsed)}
            {activity.timeoutMs ? ` / ${formatDuration(activity.timeoutMs)}` : ''}
          </Typography>
        </Stack>
        {activity.reason && (
          <Typography variant="body2" color="text.secondary">
            {activity.reason}
          </Typography>
        )}
        <LinearProgress
          sx={{ mt: 1 }}
          aria-hidden
          color={stall ? 'warning' : 'primary'}
          {...(progress === null ? { variant: 'indeterminate' as const } : { variant: 'determinate' as const, value: progress })}
        />
      </Paper>
      {stall && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {stall}
        </Alert>
      )}
    </Box>
  );
}
