// "Started by" (#464): where a run came from, as a chip. An AI app shows its
// name (ChatGPT, Claude, or the client's host); a name an MCP client gave
// itself over a personal access token is marked unverified; an app an
// administrator removed keeps the name its runs recorded.
import AndroidOutlinedIcon from '@mui/icons-material/AndroidOutlined';
import ComputerOutlinedIcon from '@mui/icons-material/ComputerOutlined';
import EventRepeatOutlinedIcon from '@mui/icons-material/EventRepeatOutlined';
import ApiOutlinedIcon from '@mui/icons-material/ApiOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import SettingsSuggestOutlinedIcon from '@mui/icons-material/SettingsSuggestOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import { Chip, Tooltip } from '@mui/material';
import type { SvgIconComponent } from '@mui/icons-material';

import type { RunClient, RunOrigin } from '../aiApps/types';

export const ORIGIN_LABEL: Record<RunOrigin, string> = { web: 'Console', android: 'Android', cli: 'CLI', api: 'API', mcp: 'AI app', schedule: 'Schedule', system: 'System' };

const ORIGIN_ICON: Record<RunOrigin, SvgIconComponent> = {
  web: ComputerOutlinedIcon,
  android: AndroidOutlinedIcon,
  cli: TerminalOutlinedIcon,
  api: ApiOutlinedIcon,
  mcp: SmartToyOutlinedIcon,
  schedule: EventRepeatOutlinedIcon,
  system: SettingsSuggestOutlinedIcon,
};

/** The hosts of the hosted assistants, by their names. */
const KNOWN_HOSTS: Readonly<Record<string, string>> = { 'chatgpt.com': 'ChatGPT', 'chat.openai.com': 'ChatGPT', 'claude.ai': 'Claude', 'claude.com': 'Claude' };

/** "ChatGPT" for chatgpt.com, "Claude" for claude.ai, else the name as stored. */
export function appDisplayName(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!n) return 'AI app';
  return KNOWN_HOSTS[n.toLowerCase()] ?? n;
}

export interface StartedBy {
  label: string;
  Icon: SvgIconComponent;
  /** What the tooltip adds: the host, "unverified", "removed app". */
  detail: string | null;
}

/** How a run's origin and client read. */
export function startedBy(run: { origin?: RunOrigin | string | null; client?: RunClient | null }, opts: { removed?: boolean } = {}): StartedBy {
  const origin = (run.origin && run.origin in ORIGIN_LABEL ? run.origin : 'web') as RunOrigin;
  if (run.client?.name) {
    const label = appDisplayName(run.client.name);
    const details = [label !== run.client.name ? run.client.name : null, run.client.verified ? null : 'name given by the app itself (unverified)', opts.removed ? '(removed app)' : null].filter(Boolean);
    return { label, Icon: SmartToyOutlinedIcon, detail: details.length ? details.join(' · ') : null };
  }
  return { label: ORIGIN_LABEL[origin], Icon: ORIGIN_ICON[origin], detail: null };
}

export interface StartedByChipProps {
  run: { origin?: RunOrigin | string | null; client?: RunClient | null };
  removed?: boolean;
  size?: 'small' | 'medium';
}

/** The chip: icon and name, with a tooltip for the host or "unverified". */
export function StartedByChip({ run, removed, size = 'small' }: StartedByChipProps) {
  const s = startedBy(run, { removed });
  const chip = (
    <Chip
      size={size}
      variant="outlined"
      icon={<s.Icon fontSize="small" aria-hidden />}
      label={`${s.label}${run.client && !run.client.verified ? '?' : ''}`}
      data-testid="started-by"
      aria-label={`Started by ${s.label}${s.detail ? ` (${s.detail})` : ''}`}
      sx={{ maxWidth: '100%' }}
    />
  );
  return s.detail ? <Tooltip title={s.detail}>{chip}</Tooltip> : chip;
}
