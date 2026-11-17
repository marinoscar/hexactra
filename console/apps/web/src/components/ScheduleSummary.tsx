import { Box, Typography } from '@mui/material';

import type { PolicyCatalog } from '../policies/usePolicyCatalog';
import { RelativeTime, useProfileTimeZone } from '../ui';

/** What the row reads: a `GET /schedules` row or a schedule of a task's `summary`. */
export interface ScheduleSummaryData {
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt?: string | null;
  consecutiveFailures?: number;
  /** The expression in words, from the API; the expression itself shows when it is missing. */
  description?: string;
  policyId?: string | null;
}

export interface ScheduleSummaryProps {
  schedule: ScheduleSummaryData;
  /** Names the policy override; without it an override reads "policy: unavailable". */
  catalog?: Pick<PolicyCatalog, 'byId'>;
  /** Default: the profile time zone of the signed-in user. */
  profileTimezone?: string;
  /** False leaves out when it runs next (or "Paused"), for a list that has its own "Next run" column; default true. */
  showNext?: boolean;
}

/** Failed scheduled runs in a row from which the row warns (the API notifies the owner at the same count). */
export const FAILING_AFTER = 3;

/**
 * One schedule, read-only: what it means in words, its zone when that is not
 * the profile's, its policy override, when it runs next (or "Paused") and a
 * warning once it has failed three times in a row.
 */
export function ScheduleSummary({ schedule: s, catalog, profileTimezone, showNext = true }: ScheduleSummaryProps) {
  const displayZone = useProfileTimeZone();
  const profile = profileTimezone ?? displayZone;
  const failures = s.consecutiveFailures ?? 0;
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {s.description || <Box component="span" sx={{ fontFamily: 'monospace' }}>{s.cron}</Box>}
        {s.timezone !== profile && ` · ${s.timezone}`}
        {s.policyId && ` · policy: ${catalog?.byId(s.policyId)?.name ?? 'unavailable'}`}
      </Typography>
      {(showNext || failures >= FAILING_AFTER) && (
        <Typography variant="caption" color="text.secondary" component="div">
          {showNext && (!s.enabled ? 'Paused' : s.nextRunAt ? <RelativeTime iso={s.nextRunAt} prefix="next " /> : 'Not scheduled yet')}
          {failures >= FAILING_AFTER && (
            <Box component="span" sx={{ color: 'warning.main', fontWeight: 500 }}>
              {showNext && ' · '}
              {failures} failed in a row
            </Box>
          )}
        </Typography>
      )}
    </Box>
  );
}
