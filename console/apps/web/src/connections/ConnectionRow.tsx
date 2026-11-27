// One row of the Connections and tools page (E39.2; E50.14, #984): the provider mark, the name, the account or address, what is on, the
// health chip from the last diagnostic, one on/off switch (Pause and Resume), a visible Test button, and a menu with the rest.
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Box, Button, Chip, FormControlLabel, IconButton, ListItem, ListItemIcon, Menu, MenuItem, Stack, Switch, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';

import { HealthChip } from '../diagnostics/HealthChip';
import type { DiagnosticSummary } from '../diagnostics/api';
import { RelativeTime, useBreakpoint } from '../ui';
import type { Connection } from './api';
import { ConnectionDetails } from './ConnectionDetails';
import { AUTH_WORDS } from './mcpWords';
import { ProviderMark } from './ProviderMark';
import { GROUPS, GROUP_NAME, STATUS_WORDS, levelOf, reasonWords } from './words';

const TOUCH = { minHeight: { xs: 44, sm: 'auto' } } as const;
const STATUS_COLOR = { active: 'success', paused: 'default', needs_reconnect: 'warning', revoked: 'error' } as const;

export interface ConnectionRowProps {
  connection: Connection;
  health: DiagnosticSummary | null;
  canWrite: boolean;
  canReadRuns: boolean;
  busy: boolean;
  onRename: () => void;
  onCapabilities: () => void;
  onDefaults: () => void;
  onTest: () => void;
  onTogglePause: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  /** MCP servers (E39.9): the tool review, and a new sign-in. */
  onTools: () => void;
  onSignIn: () => void;
}

/** What is on: the capabilities of an account, or "5 of 12 tools on" for an added tool. */
function WhatIsOn({ c }: { c: Connection }) {
  if (c.mcp) {
    return (
      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.75 }} aria-label="What it may do">
        <Chip size="small" label={`${c.mcp.tools.enabled} of ${c.mcp.tools.total} tools on`} />
        {c.mcp.tools.needsReview > 0 && <Chip size="small" color="warning" label={`${c.mcp.tools.needsReview} to review`} />}
        <Chip size="small" variant="outlined" label={AUTH_WORDS[c.mcp.auth]} />
      </Stack>
    );
  }
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.75 }} aria-label="What it may do">
      {GROUPS.map((g) => {
        const level = levelOf(c.capabilities, g);
        return level ? <Chip key={g.group} size="small" label={`${g.name}: ${level}`} /> : null;
      })}
      {c.capabilities.length === 0 && <Chip size="small" variant="outlined" label="Nothing switched on" />}
    </Stack>
  );
}

export function ConnectionRow({ connection: c, health, canWrite, canReadRuns, busy, onRename, onCapabilities, onDefaults, onTest, onTogglePause, onReconnect, onDisconnect, onTools, onSignIn }: ConnectionRowProps) {
  const { isPhone } = useBreakpoint();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = () => setAnchor(null);
  const pick = (fn: () => void) => () => {
    close();
    fn();
  };
  const reason = reasonWords(c);
  const switchable = c.status === 'active' || c.status === 'paused';
  const testable = canWrite && c.status === 'active';
  return (
    <ListItem aria-label={`Connection ${c.label}`} divider sx={{ alignItems: 'flex-start', py: 1.5, gap: 1, flexWrap: { xs: 'wrap', sm: 'nowrap' } }}>
      <ListItemIcon sx={{ minWidth: 40, mt: 0.5 }}>
        <ProviderMark provider={c.provider} />
      </ListItemIcon>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography component="span" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {c.label}
          </Typography>
          <Chip size="small" color={STATUS_COLOR[c.status]} variant={c.status === 'active' ? 'outlined' : 'filled'} label={STATUS_WORDS[c.status]} />
          {switchable && <HealthChip summary={health} />}
          {c.defaultFor.map((g) => (
            <Chip key={g} size="small" variant="outlined" color="primary" label={`Default for ${GROUP_NAME[g].toLowerCase()}`} />
          ))}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {c.mcp ? c.mcp.url : c.accountEmail}
          {c.accountName ? ` · ${c.accountName}` : ''}
        </Typography>
        <WhatIsOn c={c} />
        {reason && (
          <Typography variant="body2" color={c.status === 'needs_reconnect' ? 'warning.main' : 'text.secondary'} sx={{ mt: 0.75 }}>
            {reason}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
          {c.lastUsedAt ? <RelativeTime iso={c.lastUsedAt} prefix="Last used " /> : 'Not used yet'}
        </Typography>
        <ConnectionDetails connectionId={c.id} canReadRuns={canReadRuns} />
        {c.status === 'needs_reconnect' && canWrite && (
          <Button variant="contained" color="warning" size="small" onClick={onReconnect} disabled={busy} sx={{ mt: 1, ...TOUCH }}>
            {c.mcp ? 'Update sign-in' : 'Reconnect'}
          </Button>
        )}
      </Box>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0, width: { xs: '100%', sm: 'auto' } }}>
        {switchable && (
          <FormControlLabel
            sx={{ mr: 0, minHeight: 44 }}
            label={c.status === 'active' ? 'On' : 'Off'}
            control={<Switch checked={c.status === 'active'} disabled={!canWrite || busy} onChange={onTogglePause} slotProps={{ input: { 'aria-label': `${c.label} switched on` } }} />}
          />
        )}
        {testable &&
          (isPhone ? (
            <Tooltip title="Test">
              <IconButton aria-label={`Test ${c.label}`} onClick={onTest} sx={{ minWidth: 44, minHeight: 44 }}>
                <FactCheckOutlinedIcon />
              </IconButton>
            </Tooltip>
          ) : (
            <Button variant="outlined" size="small" onClick={onTest} aria-label={`Test ${c.label}`} startIcon={<FactCheckOutlinedIcon />} sx={{ minHeight: 36 }}>
              Test
            </Button>
          ))}
        {canWrite && (
          <IconButton aria-label={`Actions for ${c.label}`} onClick={(e) => setAnchor(e.currentTarget)} sx={{ minWidth: 44, minHeight: 44 }}>
            <MoreVertIcon />
          </IconButton>
        )}
      </Stack>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={close}>
        <MenuItem onClick={pick(onRename)}>Rename</MenuItem>
        {c.mcp && <MenuItem onClick={pick(onTools)}>Tools</MenuItem>}
        {c.mcp && c.mcp.auth !== 'none' && <MenuItem onClick={pick(onSignIn)}>Update sign-in</MenuItem>}
        {!c.mcp && c.status !== 'needs_reconnect' && <MenuItem onClick={pick(onCapabilities)}>Change what it can do</MenuItem>}
        {!c.mcp && c.status !== 'needs_reconnect' && <MenuItem onClick={pick(onDefaults)}>Make default for…</MenuItem>}
        {c.status === 'active' && <MenuItem onClick={pick(onTogglePause)}>Pause</MenuItem>}
        {c.status === 'paused' && <MenuItem onClick={pick(onTogglePause)}>Resume</MenuItem>}
        <MenuItem onClick={pick(onDisconnect)} sx={{ color: 'error.main' }}>
          Disconnect
        </MenuItem>
      </Menu>
    </ListItem>
  );
}
