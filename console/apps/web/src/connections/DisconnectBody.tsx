// What Disconnect asks (E39.2): what it revokes and deletes, and which tasks, chats and deliveries use the connection.
import { Box, Typography } from '@mui/material';

import type { Connection, ConnectionUsage } from './api';
import { PROVIDER_NAME } from './words';

export function DisconnectBody({ connection: c, usedBy }: { connection: Connection; usedBy: ConnectionUsage[] }) {
  return (
    <>
      <Typography component="span" sx={{ display: 'block' }}>
        {c.provider === 'mcp' ? 'Hexactra revokes its sign-in at the server if it can, and deletes the saved sign-in and your choices about its tools. You can add it again later.' : `Hexactra revokes its access at ${PROVIDER_NAME[c.provider]} and deletes the saved sign-in. You can connect it again later.`}
      </Typography>
      {usedBy.length > 0 ? (
        <>
          <Typography component="span" sx={{ display: 'block', mt: 1 }}>
            These use it and will show &ldquo;connection removed&rdquo;:
          </Typography>
          <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
            {usedBy.map((u) => (
              <li key={`${u.kind}-${u.id}`}>{u.name}</li>
            ))}
          </Box>
        </>
      ) : (
        <Typography component="span" sx={{ display: 'block', mt: 1 }}>
          No task or chat uses it.
        </Typography>
      )}
    </>
  );
}

/** The toast after Disconnect: whether the provider or server could be asked to revoke it. */
export function disconnectedWords(c: Connection, revoked: boolean): string {
  if (revoked) return `${c.label} disconnected`;
  return c.provider === 'mcp' ? `${c.label} disconnected. The server could not be asked to revoke the sign-in.` : `${c.label} disconnected. The provider could not be asked: remove the app in your ${PROVIDER_NAME[c.provider]} account settings.`;
}
