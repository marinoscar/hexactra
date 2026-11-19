import { Typography } from '@mui/material';

/** "Signed in with: Shop login (app.example.test)" (E37.3, E37.4): the saved logins a run used, by name and site; never a username, password or code. */
export function UsedSavedLogins({ logins }: { logins?: readonly { itemName: string; origin: string; provider?: string; at?: string }[] | null }) {
  if (!logins?.length) return null;
  return (
    <Typography variant="body2" color="text.secondary" sx={{ mb: 1, overflowWrap: 'anywhere' }} data-testid="used-saved-logins">
      Signed in with: {logins.map((l) => `${l.itemName} (${l.origin.replace(/^https?:\/\//, '')})`).join(', ')}
    </Typography>
  );
}
