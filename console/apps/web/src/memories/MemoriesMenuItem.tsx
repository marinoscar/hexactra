import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import { ListItemIcon, ListItemText, MenuItem } from '@mui/material';
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { Link as RouterLink } from 'react-router-dom';

/** "Memories" in the avatar menu (#551), for a viewer who may read them. */
export function MemoriesMenuItem({ onDone }: { onDone: () => void }) {
  const { viewer } = usePlatformHost();
  if (!viewer.hasPermission('memories:read')) return null;
  return (
    <MenuItem component={RouterLink} to="/settings/memories" onClick={onDone}>
      <ListItemIcon>
        <PsychologyOutlinedIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText>Memories</ListItemText>
    </MenuItem>
  );
}
