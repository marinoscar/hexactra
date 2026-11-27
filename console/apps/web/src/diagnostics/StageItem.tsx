// One stage of a diagnostic report (E50.14, #984): an icon and a word for its status, what it checks, and (expanded) the remedy from the
// shared table, who must act, the facts of its `data` and a link where the remedy has one. Everything is rendered as text.
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutlineOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { Box, Button, Chip, CircularProgress, Collapse, Link, ListItem, Stack, Typography } from '@mui/material';
import { forwardRef, useId, type ElementType } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import type { DiagnosticStage, StageStatus } from './api';
import { RECONNECT_CODES, STATUS_WORDS, WHO_WORDS, facts, providerConsoleUrl, remedyOf, stageTitle } from './words';

const ICON: Record<StageStatus, ElementType> = { pass: CheckCircleOutlineIcon, warn: WarningAmberIcon, fail: ErrorOutlineIcon, skipped: RemoveCircleOutlineIcon };
const COLOR: Record<StageStatus, 'success' | 'warning' | 'error' | 'disabled'> = { pass: 'success', warn: 'warning', fail: 'error', skipped: 'disabled' };

/** What the panel can offer next to a remedy. */
export interface StageActions {
  /** The reconnect flow of a connection (a new sign-in). */
  onReconnect?: () => void;
  /** The tool review of an MCP server. */
  onReviewTools?: () => void;
  /** Where the administrator fixes it (a settings card), shown to a viewer who can open it. */
  adminHref?: string;
  /** Where the owner fixes it (the Connections and tools page), when the panel is elsewhere. */
  settingsHref?: string;
  /** The provider, for a link to its own console (Google, Microsoft). */
  provider?: string;
  /** The viewer may open Administration. */
  canAdmin?: boolean;
}

const TOUCH = { minHeight: { xs: 44, sm: 36 } } as const;

function Remedy({ stage, actions }: { stage: DiagnosticStage; actions: StageActions }) {
  const remedy = remedyOf(stage);
  const list = facts(stage);
  const reconnect = actions.onReconnect && (RECONNECT_CODES.has(stage.code ?? '') || RECONNECT_CODES.has(stage.remedy ?? ''));
  const tools = actions.onReviewTools && ['tool_list', 'tool_changes', 'enabled_tools', 'offered_cap'].includes(stage.id) && stage.status !== 'pass';
  const consoleUrl = remedy?.link === 'provider_console' && actions.canAdmin && actions.provider ? providerConsoleUrl(actions.provider, stage) : null;
  return (
    <Stack spacing={1} sx={{ pl: 4.5, pr: 1, pb: 1.5 }}>
      {remedy && (
        <>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {remedy.title}
          </Typography>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {remedy.remedy}
          </Typography>
          {stage.status !== 'pass' && stage.status !== 'skipped' && (
            <Typography variant="body2" color="text.secondary">
              Who can fix it: {WHO_WORDS[remedy.who]}
            </Typography>
          )}
        </>
      )}
      {!remedy && stage.code && (
        <Typography variant="body2" color="text.secondary">
          Code {stage.code}
        </Typography>
      )}
      {list.length > 0 && (
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }} aria-label="Facts">
          {list.map((f, i) => (
            <Chip key={i} size="small" variant="outlined" label={f} sx={{ maxWidth: '100%' }} />
          ))}
        </Stack>
      )}
      {(reconnect || tools || consoleUrl || (remedy?.link === 'admin' && actions.canAdmin && actions.adminHref) || (remedy?.link === 'settings' && !reconnect && actions.settingsHref)) && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {reconnect && (
            <Button size="small" variant="contained" onClick={actions.onReconnect} sx={TOUCH}>
              Reconnect
            </Button>
          )}
          {tools && (
            <Button size="small" variant="outlined" onClick={actions.onReviewTools} sx={TOUCH}>
              Review tools
            </Button>
          )}
          {remedy?.link === 'admin' && actions.canAdmin && actions.adminHref && (
            <Button size="small" variant="outlined" component={RouterLink} to={actions.adminHref} sx={TOUCH}>
              Open the setting
            </Button>
          )}
          {remedy?.link === 'settings' && !reconnect && actions.settingsHref && (
            <Button size="small" variant="outlined" component={RouterLink} to={actions.settingsHref} sx={TOUCH}>
              Open Connections and tools
            </Button>
          )}
          {consoleUrl && (
            <Link href={consoleUrl} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ alignSelf: 'center', py: 1 }}>
              {actions.provider === 'google' ? 'Open the Google Cloud console' : 'Open the Microsoft Entra admin center'}
            </Link>
          )}
        </Stack>
      )}
    </Stack>
  );
}

export interface StageItemProps {
  stage: DiagnosticStage;
  expanded: boolean;
  onToggle: () => void;
  actions: StageActions;
}

/** A finished stage: the row is a button that shows its remedy and facts. */
export const StageItem = forwardRef<HTMLLIElement, StageItemProps>(function StageItem({ stage, expanded, onToggle, actions }, ref) {
  const Icon = ICON[stage.status];
  const id = useId();
  return (
    <ListItem ref={ref} disablePadding divider sx={{ display: 'block' }} data-testid={`stage-${stage.id}`} data-status={stage.status}>
      <Button
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={id}
        color="inherit"
        fullWidth
        sx={{ justifyContent: 'flex-start', textAlign: 'left', textTransform: 'none', py: 1.25, px: 1, minHeight: 44, gap: 1.5 }}
        endIcon={expanded ? <ExpandLessIcon aria-hidden /> : <ExpandMoreIcon aria-hidden />}
      >
        <Icon color={COLOR[stage.status]} aria-hidden />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" component="span" sx={{ display: 'block', fontWeight: 500, overflowWrap: 'anywhere' }}>
            {stageTitle(stage.id)}
          </Typography>
          <Typography variant="caption" component="span" color={stage.status === 'fail' ? 'error.main' : stage.status === 'warn' ? 'warning.main' : 'text.secondary'}>
            {STATUS_WORDS[stage.status]}
          </Typography>
        </Box>
      </Button>
      <Collapse in={expanded} id={id} unmountOnExit>
        <Remedy stage={stage} actions={actions} />
      </Collapse>
    </ListItem>
  );
});

/** A stage while the request runs: a spinner on the current one, "Waiting" on the next ones. */
export function PendingStageItem({ id, current }: { id: string; current: boolean }) {
  return (
    <ListItem divider sx={{ gap: 1.5, px: 1, py: 1.25, minHeight: 44 }} data-testid={`stage-${id}`} data-status={current ? 'running' : 'waiting'}>
      {current ? <CircularProgress size={20} aria-hidden /> : <HourglassEmptyIcon color="disabled" aria-hidden />}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" component="span" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
          {stageTitle(id)}
        </Typography>
        <Typography variant="caption" component="span" color="text.secondary">
          {current ? 'Checking…' : 'Waiting'}
        </Typography>
      </Box>
    </ListItem>
  );
}
