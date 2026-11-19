import { Typography } from '@mui/material';

/**
 * "Filled from your saved details: Date of birth, ID number" (E37.6): the identity details a run filled, by their labels.
 * Never a value (the console never has one).
 */
export function UsedSavedIdentity({ details }: { details?: readonly { label: string; itemName?: string; origin?: string }[] | null }) {
  if (!details?.length) return null;
  const labels = [...new Set(details.map((d) => d.label))];
  return (
    <Typography variant="body2" color="text.secondary" sx={{ mb: 1, overflowWrap: 'anywhere' }} data-testid="used-saved-identity">
      Filled from your saved details: {labels.join(', ')}
    </Typography>
  );
}
