import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckIcon from '@mui/icons-material/Check';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ComputerIcon from '@mui/icons-material/ComputerOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import PolicyIcon from '@mui/icons-material/TuneOutlined';
import SettingsIcon from '@mui/icons-material/SettingsOutlined';
import { Box, Chip, Divider, Drawer, IconButton, Link, List, ListItemButton, ListItemIcon, ListItemText, ListSubheader, Popover, Stack, Switch, Tooltip, Typography, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { usePlatformHost } from '@marinoscar/platform-web/core';

import { usePolicyCatalog } from '../policies/usePolicyCatalog';
import { machineState, type FleetHost } from '../types/fleet';
import { useFleetHosts } from './MachinePicker';
import { SAFE_AREA_BOTTOM } from '../ui';

/** The run choices the composer offers: the agent policy and the machine. */
export interface ChatRunChoice {
  /** `null` follows the owner's default policy. */
  policyId: string | null;
  /** `null` is any available machine. */
  hostId: string | null;
  hostFallback: boolean;
}

export interface ChatOptionsProps extends ChatRunChoice {
  /** Only what changed. */
  onChange: (change: Partial<ChatRunChoice>) => void;
  /** Open every setting of the chat (the settings dialog). */
  onOpenSettings?: () => void;
  disabled?: boolean;
}

type View = 'root' | 'policy' | 'machine';

const ROW = { minHeight: 48 } as const;

/** A machine's name for a chip or a row, with its state when it is not online. */
function hostLabel(hosts: readonly FleetHost[], hostId: string | null): string {
  if (!hostId) return 'Any machine';
  const host = hosts.find((h) => h.id === hostId);
  return host?.name ?? hostId.slice(0, 8);
}

/**
 * The options of the chat composer (#713), as in ChatGPT: a "+" button that
 * opens the agent policy, the machine and every chat setting, and two chips
 * that show (and change) the policy and the machine the next run uses. From
 * `sm` the options are a popover; on a phone they are a bottom sheet.
 */
export function ChatOptions({ policyId, hostId, hostFallback, onChange, onOpenSettings, disabled = false }: ChatOptionsProps) {
  const { viewer } = usePlatformHost();
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const canPickPolicy = viewer.hasPermission('agent_policies:read');
  const catalog = usePolicyCatalog({ withTiers: false });
  const hosts = useFleetHosts();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [view, setView] = useState<View>('root');
  const open = anchor !== null;

  const openAt = (el: HTMLElement, v: View) => {
    setView(v);
    setAnchor(el);
  };
  const close = () => setAnchor(null);

  const fallbackPolicy = catalog.byId(catalog.defaultId);
  const chosenPolicy = policyId ? catalog.byId(policyId) : fallbackPolicy;
  const policyLabel = policyId ? (chosenPolicy?.name ?? 'Unavailable policy') : `Default${fallbackPolicy ? ` (${fallbackPolicy.name})` : ''}`;
  const policyChip = policyId ? (chosenPolicy?.name ?? 'Policy') : (fallbackPolicy?.name ?? 'Default policy');
  const machine = hostLabel(hosts, hostId);
  const chosenHost = hostId ? hosts.find((h) => h.id === hostId) : undefined;
  const hostOffline = chosenHost !== undefined && machineState(chosenHost) !== 'online';

  const pickPolicy = (next: string | null) => {
    close();
    if (next !== policyId) onChange({ policyId: next });
  };
  const pickHost = (next: string | null) => {
    close();
    if (next !== hostId) onChange({ hostId: next });
  };

  const header = (title: string) => (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', px: 0.5, pt: 0.5 }}>
      <IconButton aria-label="Back" onClick={() => setView('root')} sx={{ width: 44, height: 44 }}>
        <ArrowBackIcon fontSize="small" />
      </IconButton>
      <Typography variant="subtitle2" component="h2">
        {title}
      </Typography>
    </Stack>
  );
  const check = (on: boolean) => <ListItemIcon sx={{ minWidth: 32 }}>{on ? <CheckIcon fontSize="small" color="primary" /> : null}</ListItemIcon>;

  let content: ReactNode;
  if (view === 'policy') {
    const builtins = catalog.policies.filter((p) => p.builtin);
    const own = catalog.policies.filter((p) => !p.builtin);
    content = (
      <>
        {header('Agent policy')}
        <List dense aria-label="Agent policy" sx={{ pt: 0 }}>
          <ListItemButton sx={ROW} selected={policyId === null} onClick={() => pickPolicy(null)}>
            {check(policyId === null)}
            <ListItemText primary={`Default${fallbackPolicy ? ` (${fallbackPolicy.name})` : ''}`} secondary="Your default policy" />
          </ListItemButton>
          {builtins.length > 0 && <ListSubheader sx={{ lineHeight: '32px' }}>Built-in</ListSubheader>}
          {builtins.map((p) => (
            <ListItemButton key={p.id} sx={ROW} selected={policyId === p.id} onClick={() => pickPolicy(p.id)}>
              {check(policyId === p.id)}
              <ListItemText primary={p.name} />
              <LockOutlinedIcon fontSize="inherit" sx={{ color: 'text.secondary' }} aria-hidden />
            </ListItemButton>
          ))}
          {own.length > 0 && <ListSubheader sx={{ lineHeight: '32px' }}>Your policies</ListSubheader>}
          {own.map((p) => (
            <ListItemButton key={p.id} sx={ROW} selected={policyId === p.id} onClick={() => pickPolicy(p.id)}>
              {check(policyId === p.id)}
              <ListItemText primary={p.name} />
            </ListItemButton>
          ))}
        </List>
        <Box sx={{ px: 2, pb: 1.5 }}>
          <Link component={RouterLink} to="/settings/agent-policies" variant="body2" onClick={close}>
            Manage policies
          </Link>
        </Box>
      </>
    );
  } else if (view === 'machine') {
    content = (
      <>
        {header('Machine')}
        <List dense aria-label="Machine" sx={{ pt: 0 }}>
          <ListItemButton sx={ROW} selected={hostId === null} onClick={() => pickHost(null)}>
            {check(hostId === null)}
            <ListItemText primary="Any available machine" secondary="Home machines first" />
          </ListItemButton>
          {hosts.map((h) => {
            const state = machineState(h);
            return (
              <ListItemButton key={h.id} sx={ROW} selected={hostId === h.id} onClick={() => pickHost(h.id)}>
                {check(hostId === h.id)}
                <ListItemText primary={h.name} secondary={state} />
                <Box component="span" aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: state === 'online' ? 'success.main' : 'text.disabled' }} />
              </ListItemButton>
            );
          })}
          {hostId && !chosenHost && hosts.length > 0 && (
            <ListItemButton sx={ROW} selected>
              {check(true)}
              <ListItemText primary={hostId.slice(0, 8)} secondary="Not in your fleet" />
            </ListItemButton>
          )}
        </List>
        {hostId && (
          <>
            <Divider />
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 2, py: 1 }}>
              <Typography variant="body2" sx={{ flex: 1 }} id="chat-options-fallback">
                If it is unavailable, use another available machine
              </Typography>
              <Switch checked={hostFallback} disabled={disabled} onChange={(e) => onChange({ hostFallback: e.target.checked })} slotProps={{ input: { 'aria-labelledby': 'chat-options-fallback' } }} />
            </Stack>
          </>
        )}
      </>
    );
  } else {
    content = (
      <List aria-label="Chat options" sx={{ py: 0.5 }}>
        {canPickPolicy && (
          <ListItemButton sx={ROW} onClick={() => setView('policy')}>
            <ListItemIcon sx={{ minWidth: 40 }}>
              <PolicyIcon />
            </ListItemIcon>
            <ListItemText primary="Agent policy" secondary={policyLabel} />
            <ChevronRightIcon sx={{ color: 'text.secondary' }} aria-hidden />
          </ListItemButton>
        )}
        <ListItemButton sx={ROW} onClick={() => setView('machine')}>
          <ListItemIcon sx={{ minWidth: 40 }}>
            <ComputerIcon />
          </ListItemIcon>
          <ListItemText primary="Machine" secondary={hostId && hostOffline && chosenHost ? `${machine} (${machineState(chosenHost)})` : machine === 'Any machine' ? 'Any available machine' : machine} />
          <ChevronRightIcon sx={{ color: 'text.secondary' }} aria-hidden />
        </ListItemButton>
        {onOpenSettings && (
          <>
            <Divider sx={{ my: 0.5 }} />
            <ListItemButton
              sx={ROW}
              onClick={() => {
                close();
                onOpenSettings();
              }}
            >
              <ListItemIcon sx={{ minWidth: 40 }}>
                <SettingsIcon />
              </ListItemIcon>
              <ListItemText primary="All chat settings" secondary="Sites, purchases, saved logins, accounts" />
            </ListItemButton>
          </>
        )}
      </List>
    );
  }

  const chipSx = { maxWidth: { xs: 128, sm: 200 }, height: 32, borderRadius: 4, '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } } as const;

  return (
    <>
      <Tooltip title="Chat options">
        <Box component="span">
          <IconButton aria-label="Chat options" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={(e) => openAt(e.currentTarget, 'root')} sx={{ width: 40, height: 40 }}>
            <AddIcon />
          </IconButton>
        </Box>
      </Tooltip>
      {canPickPolicy && (
        <Chip
          icon={<PolicyIcon fontSize="small" />}
          label={policyChip}
          variant="outlined"
          size="small"
          disabled={disabled}
          onClick={(e) => openAt(e.currentTarget, 'policy')}
          aria-label={`Agent policy: ${policyLabel}`}
          sx={chipSx}
        />
      )}
      <Chip
        icon={<ComputerIcon fontSize="small" />}
        label={machine}
        variant="outlined"
        size="small"
        color={hostOffline ? 'warning' : 'default'}
        disabled={disabled}
        onClick={(e) => openAt(e.currentTarget, 'machine')}
        aria-label={`Machine: ${machine}`}
        sx={chipSx}
      />
      {isPhone ? (
        <Drawer anchor="bottom" open={open} onClose={close} slotProps={{ paper: { 'aria-label': 'Chat options', sx: { borderTopLeftRadius: 16, borderTopRightRadius: 16, pb: SAFE_AREA_BOTTOM, maxHeight: '80dvh' } } }}>
          <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: 'divider', mx: 'auto', mt: 1 }} aria-hidden />
          {content}
        </Drawer>
      ) : (
        <Popover
          open={open}
          anchorEl={anchor}
          onClose={close}
          anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{ paper: { 'aria-label': 'Chat options', sx: { width: 340, maxHeight: '70vh', borderRadius: 3, mt: -1 } } }}
        >
          {content}
        </Popover>
      )}
    </>
  );
}
