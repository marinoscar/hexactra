import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import { ListItemIcon, ListItemText, MenuItem } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { Link as RouterLink } from 'react-router-dom';

/** "Secrets" in the avatar menu (#593), for a viewer who may read their secrets settings. */
export function SecretsMenuItem({ onDone }: { onDone: () => void }) {
  const { viewer } = usePlatformHost();
  if (!viewer.hasPermission('secrets:read')) return null;
  return (
    <MenuItem component={RouterLink} to="/settings/secrets" onClick={onDone}>
      <ListItemIcon>
        <KeyOutlinedIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText>Secrets</ListItemText>
    </MenuItem>
  );
}
