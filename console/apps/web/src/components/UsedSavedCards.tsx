import { Alert, Box, Typography } from '@mui/material';

import type { UsedSavedCardEntry } from '../types/runs';

/** "Visa ending 4242": the brand and the last four digits, nothing more of the card. */
export function cardWords(c: Pick<UsedSavedCardEntry, 'brand' | 'last4'>): string {
  const brand = (c.brand ?? '').trim();
  const name = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : 'Card';
  return c.last4 ? `${name} ending ${c.last4}` : name;
}

/**
 * "Paid with Visa ending 4242 at shop.example.com: 42.50 USD" (E37.7): the saved cards a run typed, with the amount the agent declared
 * before paying and the one it read on the confirmation page, and a warning when they differ. Never a number, an expiry or a code (the
 * console never has one).
 */
export function UsedSavedCards({ cards }: { cards?: readonly UsedSavedCardEntry[] | null }) {
  if (!cards?.length) return null;
  return (
    <Box sx={{ mb: 1 }} data-testid="used-saved-cards">
      {cards.map((c, i) => (
        <Box key={`${c.merchant}-${c.at}-${i}`} sx={{ mb: 0.5 }}>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            Paid with {cardWords(c)} at {c.merchant}: {c.declaredAmount} {c.currency}
            {c.confirmedAmount && !c.mismatch ? ` (the confirmation page says ${c.confirmedAmount} ${c.currency})` : ''}
            {!c.confirmedAmount ? ' (the amount on the confirmation page was not read)' : ''}
          </Typography>
          {c.mismatch && c.confirmedAmount && (
            <Alert severity="warning" variant="outlined" sx={{ mt: 0.5, overflowWrap: 'anywhere' }} data-testid="card-mismatch">
              The amount charged at {c.merchant} ({c.confirmedAmount} {c.currency}) differs from the {c.declaredAmount} {c.currency} the agent declared. Check the order and your card statement.
            </Alert>
          )}
        </Box>
      ))}
    </Box>
  );
}
