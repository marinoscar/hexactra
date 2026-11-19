// A run step of the agent's account tools (E39.10, #607): "Read 3 emails in Work", "Sent an email from Personal to 1 person", "Added 1 row
// to a spreadsheet in Work". The step names the account by its label; the sentence is built from the tool and its masked arguments, never
// from a message body (a step holds none). The masked details stay one click away.
import { Box, Button, Typography } from '@mui/material';
import { useState } from 'react';

import { ProviderMark } from '../connections/ProviderMark';

/** The tools whose steps this reads: a closed list, the same as the API's. */
export const CONNECTION_TOOLS = [
  'mail_search',
  'mail_read',
  'mail_attachment_to_browser',
  'mail_draft',
  'mail_send',
  'mail_modify',
  'calendar_list',
  'calendar_free_busy',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'docs_search',
  'docs_read',
  'sheet_read',
  'docs_create',
  'docs_append',
  'sheet_append_rows',
  'sheet_create',
  'file_upload',
] as const;

interface StepLike {
  action: string | null;
  kind: string;
  args: Record<string, unknown> | null;
  summary: string;
  ok: boolean;
}

export function isConnectionStep(s: Pick<StepLike, 'action' | 'kind' | 'args'>): boolean {
  return s.kind === 'action' && s.action !== null && (CONNECTION_TOOLS as readonly string[]).includes(s.action) && typeof s.args?.connection === 'string';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const count = (summary: string): number | null => {
  const m = /\b(\d+)\b/.exec(summary);
  return m ? Number(m[1]) : null;
};
const quote = (v: unknown): string => (typeof v === 'string' && v ? ` “${v}”` : '');

/** The sentence for a step: what was done with which account. */
export function connectionStepLine(s: StepLike): string {
  const a = s.args ?? {};
  const label = String(a.connection ?? 'an account');
  const people = Array.isArray(a.to) ? a.to.length : Array.isArray(a.attendees) ? a.attendees.length : null;
  const n = count(s.summary);
  switch (s.action) {
    case 'mail_search':
      return n !== null && s.ok ? `Searched mail in ${label}: ${plural(n, 'message', 'messages')} found` : `Searched mail in ${label}`;
    case 'mail_read':
      return `Read an email in ${label}`;
    case 'mail_attachment_to_browser':
      return `Took an email attachment from ${label}`;
    case 'mail_draft':
      return `Saved a draft in ${label}`;
    case 'mail_send':
      return `Sent an email from ${label}${people !== null ? ` to ${plural(people, 'person', 'people')}` : ''}`;
    case 'mail_modify':
      return `Organised mail in ${label}`;
    case 'calendar_list':
      return `Looked at the calendar in ${label}`;
    case 'calendar_free_busy':
      return `Checked free time in ${label}`;
    case 'calendar_create_event':
      return `Created an event${quote(a.title)} in ${label}${people ? `, inviting ${plural(people, 'person', 'people')}` : ''}`;
    case 'calendar_update_event':
      return `Changed an event in ${label}`;
    case 'calendar_delete_event':
      return `Deleted an event in ${label}`;
    case 'docs_search':
      return `Searched files in ${label}`;
    case 'docs_read':
      return `Read a document in ${label}`;
    case 'sheet_read':
      return `Read a spreadsheet in ${label}`;
    case 'docs_create':
      return `Created a document${quote(a.title)} in ${label}`;
    case 'docs_append':
      return `Added text to a document in ${label}`;
    case 'sheet_append_rows':
      return `Added ${typeof a.rows === 'number' ? plural(a.rows, 'row', 'rows') : 'rows'} to a spreadsheet in ${label}`;
    case 'sheet_create':
      return `Created a spreadsheet${quote(a.title)} in ${label}`;
    case 'file_upload':
      return `Saved a file${quote(a.name)} in ${label}`;
    default:
      return `${s.action ?? 'Used'} with ${label}`;
  }
}

/** The step's body: the sentence, what the tool said, and the masked details on request. */
export function ConnectionStepBody({ seq, step, provider }: { seq: number; step: StepLike; provider?: string }) {
  const [open, setOpen] = useState(false);
  const line = connectionStepLine(step);
  return (
    <Box data-testid={`connection-step-${seq}`}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <ProviderMark provider={provider ?? 'google'} fontSize="small" />
        <Typography sx={{ overflowWrap: 'anywhere', color: step.ok ? undefined : 'error.main' }}>{`${seq}. ${line}${step.ok ? '' : ' (failed)'}`}</Typography>
      </Box>
      {step.summary && (
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere', ml: 3.5 }}>
          {step.summary}
        </Typography>
      )}
      <Box sx={{ ml: 3 }}>
        <Button size="small" onClick={() => setOpen((v) => !v)} aria-expanded={open} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          {open ? 'Hide details' : 'Details'}
        </Button>
        {open && (
          <Typography component="pre" variant="caption" data-testid={`connection-step-details-${seq}`} sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'monospace' }}>
            {JSON.stringify(step.args, null, 2)}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
