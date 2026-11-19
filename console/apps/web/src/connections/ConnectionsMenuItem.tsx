import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import { ListItemIcon, ListItemText, MenuItem } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { Link as RouterLink } from 'react-router-dom';

/** "Connections" in the avatar menu (E39.2), for a viewer who may read their connections. */
export function ConnectionsMenuItem({ onDone }: { onDone: () => void }) {
  const { viewer } = usePlatformHost();
  if (!viewer.hasPermission('connections:read')) return null;
  return (
    <MenuItem component={RouterLink} to="/settings/connections" onClick={onDone}>
      <ListItemIcon>
        <LinkOutlinedIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText>Connections</ListItemText>
    </MenuItem>
  );
}
