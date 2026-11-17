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

export interface RunWithMenuProps {
  /** The element the menu opens from; null closes it. */
  anchorEl: HTMLElement | null;
  onClose: () => void;
  /** The chosen policy; the menu closes itself first. */
  onChoose: (policyId: string) => void;
  catalog: Pick<PolicyCatalog, 'policies' | 'defaultId'>;
  /** The policy a plain run would use (marked "usual"); the user's default when omitted. */
  usualId?: string | null;
  id?: string;
}

/** The "Run with…" menu: the built-in policies, then the user's own. `RunWithButton` and the runs list's "Run again with…" open it. */
export function RunWithMenu({ anchorEl, onClose, onChoose, catalog, usualId, id }: RunWithMenuProps) {
  const usual = usualId ?? catalog.defaultId;
  const builtins = catalog.policies.filter((p) => p.builtin);
  const own = catalog.policies.filter((p) => !p.builtin);
  const item = (p: (typeof catalog.policies)[number]) => (
    <MenuItem
      key={p.id}
      selected={p.id === usual}
      onClick={() => {
        onClose();
        onChoose(p.id);
      }}
    >
      {p.builtin && (
        <ListItemIcon>
          <LockOutlinedIcon fontSize="small" />
        </ListItemIcon>
      )}
      <ListItemText inset={!p.builtin} primary={p.id === usual ? `${p.name} (usual)` : p.name} secondary={policyLine(p)} />
    </MenuItem>
  );
  return (
    <Menu id={id} anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={onClose}>
      <ListSubheader>Run with…</ListSubheader>
      {builtins.map(item)}
      {own.length > 0 && <Divider />}
      {own.map(item)}
    </Menu>
  );
}

/**
 * "Run now" with a split arrow: "Run with..." a policy for this run only. The
 * choice is sent as `policyId` on `POST /api/tasks/:id/runs`. Without any
 * policy to offer it is a plain button.
 */
export function RunWithButton({ onRun, catalog, taskPolicyId, label = 'Run now', disabled, size }: RunWithButtonProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  if (catalog.policies.length === 0) {
    return (
      <Button variant="contained" size={size} disabled={disabled} onClick={() => onRun()}>
        {label}
      </Button>
    );
  }

  return (
    <>
      <ButtonGroup variant="contained" size={size} disabled={disabled} aria-label="Run">
        <Button onClick={() => onRun()}>{label}</Button>
        <Button
          size="small"
          aria-label="Run with…"
          aria-haspopup="menu"
          aria-controls={anchor ? menuId : undefined}
          aria-expanded={anchor ? 'true' : undefined}
          onClick={(e) => setAnchor(e.currentTarget)}
        >
          <ArrowDropDownIcon />
        </Button>
      </ButtonGroup>
      <RunWithMenu id={menuId} anchorEl={anchor} onClose={() => setAnchor(null)} onChoose={(policyId) => onRun(policyId)} catalog={catalog} usualId={taskPolicyId} />
    </>
  );
}
