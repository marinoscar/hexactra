import { Box, Checkbox, FormControlLabel, Stack, Typography } from '@mui/material';
import { useId } from 'react';

import type { Capability } from './api';
import { GROUPS, type GroupDef } from './words';

/**
 * The switches of one account: for Mail, Calendar and Documents, "Read" and "Write" (Send, for mail), each with one line on what
 * the agent could do. Write (and Mail's Organize) needs read: ticking either ticks Read, and unticking Read unticks them. `granted` marks the ones the
 * provider already allows, so the owner can see which need a new consent.
 */
export function CapabilityPicker({ value, onChange, granted, providerName }: { value: readonly Capability[]; onChange: (next: Capability[]) => void; granted?: readonly Capability[]; providerName?: string }) {
  const id = useId();
  const set = (cap: Capability, on: boolean, g: GroupDef) => {
    const next = new Set(value);
    if (on) {
      next.add(cap);
      if (cap === g.write || cap === g.modify) next.add(g.read);
    } else {
      next.delete(cap);
      if (cap === g.read) {
        next.delete(g.write);
        if (g.modify) next.delete(g.modify);
      }
    }
    onChange([...next]);
  };
  const needsConsent = (cap: Capability) => granted !== undefined && !granted.includes(cap);
  return (
    <Stack spacing={2} role="group" aria-label="What this account may do">
      {GROUPS.map((g) => (
        <Box key={g.group}>
          <Typography variant="subtitle2" component="h3" id={`${id}-${g.group}`}>
            {g.name}
          </Typography>
          <Stack aria-labelledby={`${id}-${g.group}`} role="group">
            {([[g.read, 'Read', g.readWords], [g.write, g.group === 'mail' ? 'Send' : 'Write', g.writeWords], ...(g.modify && g.modifyWords ? [[g.modify, 'Organize', g.modifyWords] as const] : [])] as readonly (readonly [Capability, string, string])[]).map(([cap, name, words]) => (
              <FormControlLabel
                key={cap}
                sx={{ alignItems: 'flex-start', ml: 0, minHeight: { xs: 44, sm: 'auto' } }}
                control={<Checkbox checked={value.includes(cap)} onChange={(e) => set(cap, e.target.checked, g)} sx={{ py: 0.5 }} slotProps={{ input: { 'aria-label': `${g.name}: ${name.toLowerCase()}` } }} />}
                label={
                  <Box>
                    <Typography component="span" sx={{ fontWeight: 500 }}>
                      {name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" component="span" sx={{ display: 'block' }}>
                      {words}
                      {value.includes(cap) && needsConsent(cap) ? ` ${providerName ?? 'The provider'} will ask for this permission.` : ''}
                    </Typography>
                  </Box>
                }
              />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}
