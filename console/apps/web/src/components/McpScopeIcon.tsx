// The icons the OAuth consent page shows next to the console's MCP scopes
// (#459; the scopes are registered by the API in apps/api/src/mcp/mcp.scopes.ts).
// The page passes each scope id to its `scopeIcon` slot; an unknown id gets no
// icon. The two high-risk scopes (running JavaScript in signed-in pages,
// controlling the whole desktop) get a warning icon in the warning colour.
import type { ReactNode } from 'react';
import type { SvgIconComponent } from '@mui/icons-material';
import EditCalendarOutlinedIcon from '@mui/icons-material/EditCalendarOutlined';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import MouseOutlinedIcon from '@mui/icons-material/MouseOutlined';
import PlayCircleOutlinedIcon from '@mui/icons-material/PlayCircleOutlined';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

/** One icon per scope; `warning` paints it in the theme's warning colour. */
export const MCP_SCOPE_ICONS: Readonly<Record<string, { Icon: SvgIconComponent; warning?: true }>> = {
  'runs:read': { Icon: VisibilityOutlinedIcon },
  'runs:write': { Icon: PlayCircleOutlinedIcon },
  'tasks:write': { Icon: EditCalendarOutlinedIcon },
  'inbox:read': { Icon: InboxOutlinedIcon },
  'inbox:write': { Icon: QuestionAnswerOutlinedIcon },
  'browser:drive': { Icon: MouseOutlinedIcon },
  'browser:evaluate': { Icon: WarningAmberIcon, warning: true },
  'desktop:control': { Icon: WarningAmberIcon, warning: true },
  'policies:write': { Icon: TuneOutlinedIcon },
};

/** The consent page's `scopeIcon` slot. */
export function mcpScopeIcon(scopeId: string): ReactNode {
  const entry = MCP_SCOPE_ICONS[scopeId];
  if (!entry) return null;
  const { Icon, warning } = entry;
  return <Icon fontSize="small" color={warning ? 'warning' : 'action'} data-testid={`scope-icon-${scopeId}`} aria-hidden />;
}
