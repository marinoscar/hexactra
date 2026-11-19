// A webhook delivery's signing secret, shown once (E39.10, #607; the API is E39.6): it cannot be read again.
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import { useState } from 'react';

import type { CreatedSecret } from './sync';

export function DeliverySecretsDialog({ secrets, onClose }: { secrets: CreatedSecret[]; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(secret);
    } catch {
      setCopied(null);
    }
  };
  return (
    <Dialog open={secrets.length > 0} fullWidth maxWidth="sm" aria-labelledby="delivery-secret-title">
      <DialogTitle id="delivery-secret-title">Copy your signing {secrets.length === 1 ? 'secret' : 'secrets'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Alert severity="warning">This is the only time {secrets.length === 1 ? 'it is' : 'they are'} shown. The receiver uses {secrets.length === 1 ? 'it' : 'each'} to check that a message really came from Hexactra.</Alert>
          {secrets.map((s) => (
            <Box key={s.secret}>
              <Typography variant="body2" color="text.secondary">
                For {s.host}
              </Typography>
              <Typography component="code" data-testid="signing-secret" sx={{ display: 'block', fontFamily: 'monospace', overflowWrap: 'anywhere', my: 0.5 }}>
                {s.secret}
              </Typography>
              <Button size="small" onClick={() => void copy(s.secret)} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
                {copied === s.secret ? 'Copied' : 'Copy'}
              </Button>
            </Box>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={onClose} sx={{ minHeight: { xs: 44, sm: 'auto' } }}>
          I copied {secrets.length === 1 ? 'it' : 'them'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
