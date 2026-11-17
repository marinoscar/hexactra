import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { Button, ButtonGroup, Divider, ListItemIcon, ListItemText, ListSubheader, Menu, MenuItem } from '@mui/material';
import { useId, useState } from 'react';

import { policyLine } from './format';
import type { PolicyCatalog } from './usePolicyCatalog';

export interface RunWithButtonProps {
  /** Start a run; `policyId` is set when the person chose "Run with..." a policy. */
  onRun: (policyId?: string) => void;
  catalog: Pick<PolicyCatalog, 'policies' | 'defaultId'>;
  /** The task's own policy (null follows the default), so the menu can mark it. */
  taskPolicyId?: string | null;
  label?: string;
  disabled?: boolean;
  size?: 'small' | 'medium';
}

/** Below `md` (touch widths) each part is a 44 px target. */
const TOUCH_TARGET = { minHeight: { xs: 44, md: 'auto' } } as const;

/**
 * "Run now" with a split arrow: "Run with..." a policy for this run only. The
 * choice is sent as `policyId` on `POST /api/tasks/:id/runs`. Without any
 * policy to offer it is a plain button.
 */
export function RunWithButton({ onRun, catalog, taskPolicyId, label = 'Run now', disabled, size }: RunWithButtonProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  const usual = taskPolicyId ?? catalog.defaultId;
  const builtins = catalog.policies.filter((p) => p.builtin);
  const own = catalog.policies.filter((p) => !p.builtin);

  if (catalog.policies.length === 0) {
    return (
      <Button variant="contained" size={size} disabled={disabled} onClick={() => onRun()} sx={TOUCH_TARGET}>
        {label}
      </Button>
    );
  }

  const choose = (policyId: string) => {
    setAnchor(null);
    onRun(policyId);
  };

  const item = (p: (typeof catalog.policies)[number]) => (
    <MenuItem key={p.id} onClick={() => choose(p.id)} selected={p.id === usual}>
      {p.builtin && (
        <ListItemIcon>
          <LockOutlinedIcon fontSize="small" />
        </ListItemIcon>
      )}
      <ListItemText inset={!p.builtin} primary={p.id === usual ? `${p.name} (usual)` : p.name} secondary={policyLine(p)} />
    </MenuItem>
  );

  return (
    <>
      <ButtonGroup variant="contained" size={size} disabled={disabled} aria-label="Run">
        <Button onClick={() => onRun()} sx={{ ...TOUCH_TARGET, whiteSpace: 'nowrap' }}>
          {label}
        </Button>
        <Button
          size="small"
          aria-label="Run with…"
          aria-haspopup="menu"
          aria-controls={anchor ? menuId : undefined}
          aria-expanded={anchor ? 'true' : undefined}
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ ...TOUCH_TARGET, minWidth: { xs: 44, md: 40 } }}
        >
          <ArrowDropDownIcon />
        </Button>
      </ButtonGroup>
      <Menu id={menuId} anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        <ListSubheader>Run with…</ListSubheader>
        {builtins.map(item)}
        {own.length > 0 && <Divider />}
        {own.map(item)}
      </Menu>
    </>
  );
}
