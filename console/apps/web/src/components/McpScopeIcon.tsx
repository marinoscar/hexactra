// The icons the OAuth consent page shows next to the console's MCP scopes
// (#459; the scopes are registered by the API in apps/api/src/mcp/mcp.scopes.ts).
// The page passes each scope id to its `scopeIcon` slot; an unknown id gets no
// icon. Each icon says what the scope is about, never how risky it is: the
// platform's consent page marks every high-risk scope with its own warning
// icon, so a warning icon here would show twice (#460).
import type { ReactNode } from 'react';
import type { SvgIconComponent } from '@mui/icons-material';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DesktopWindowsOutlinedIcon from '@mui/icons-material/DesktopWindowsOutlined';
import EditCalendarOutlinedIcon from '@mui/icons-material/EditCalendarOutlined';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import MouseOutlinedIcon from '@mui/icons-material/MouseOutlined';
import PlayCircleOutlinedIcon from '@mui/icons-material/PlayCircleOutlined';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import RepeatOutlinedIcon from '@mui/icons-material/RepeatOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';

/** One icon per scope, in the theme's action colour. */
export const MCP_SCOPE_ICONS: Readonly<Record<string, { Icon: SvgIconComponent }>> = {
  'runs:read': { Icon: VisibilityOutlinedIcon },
  'usage:read': { Icon: InsightsOutlinedIcon },
  'runs:write': { Icon: PlayCircleOutlinedIcon },
  'tasks:write': { Icon: EditCalendarOutlinedIcon },
  'inbox:read': { Icon: InboxOutlinedIcon },
  'inbox:write': { Icon: QuestionAnswerOutlinedIcon },
  'procedures:read': { Icon: AccountTreeOutlinedIcon },
  'procedures:run': { Icon: RepeatOutlinedIcon },
  'browser:drive': { Icon: MouseOutlinedIcon },
  'browser:evaluate': { Icon: CodeOutlinedIcon },
  'desktop:control': { Icon: DesktopWindowsOutlinedIcon },
  'policies:write': { Icon: TuneOutlinedIcon },
};

/** The consent page's `scopeIcon` slot. */
export function mcpScopeIcon(scopeId: string): ReactNode {
  const entry = MCP_SCOPE_ICONS[scopeId];
  if (!entry) return null;
  const { Icon } = entry;
  return <Icon fontSize="small" color="action" data-testid={`scope-icon-${scopeId}`} aria-hidden />;
}
