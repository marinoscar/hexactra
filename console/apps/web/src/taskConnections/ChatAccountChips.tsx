// The accounts a chat may use, as small chips above the composer (E39.10, #607): "Work: read only". Nothing when the chat has none.
import { Chip, Stack } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { ProviderMark } from '../connections/ProviderMark';
import type { ConnectionSelectionView } from './model';

export function ChatAccountChips({ accounts }: { accounts: readonly ConnectionSelectionView[] | undefined | null }) {
  if (!accounts || accounts.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', mb: 0.75 }} aria-label="Accounts this chat may use" data-testid="chat-account-chips">
      {accounts.map((a) => {
        const usable = a.status === 'active';
        return (
          <Chip
            key={a.connectionId}
            size="small"
            variant="outlined"
            color={usable ? 'default' : 'warning'}
            icon={<ProviderMark provider={a.provider} fontSize="small" />}
            component={RouterLink}
            to="/settings/connections"
            clickable
            label={`${a.label}: ${usable ? (a.access === 'read_write' ? 'read and change' : 'read only') : a.status === 'paused' ? 'paused' : 'needs reconnect'}`}
          />
        );
      })}
    </Stack>
  );
}
