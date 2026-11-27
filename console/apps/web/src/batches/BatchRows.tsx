import { Box, Link, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { StatusChip } from '../ui';
import { itemChipStatus, valuesLine, type BatchItem } from './model';

const WRAP = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 } as const;
const TAP = { display: 'inline-flex', alignItems: 'center', minHeight: { xs: 44, sm: 'auto' } } as const;

/** A batch's rows with a status chip each and, once a row has a run, **Open run** (E51.1). Every value is rendered as text. */
export function BatchRows({ items, showResult = false }: { items: readonly BatchItem[]; showResult?: boolean }) {
  return (
    <Box component="ol" aria-label="Rows" sx={{ listStyle: 'none', m: 0, p: 0 }}>
      {items.map((item) => (
        <Box component="li" key={item.seq} data-row={item.seq} sx={{ py: 0.75, borderTop: 1, borderColor: 'divider', '&:first-of-type': { borderTop: 0 } }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', minWidth: 0 }}>
            <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0, minWidth: 20, pt: 0.25 }}>
              {item.seq}
            </Typography>
            <Box sx={{ flex: 1, ...WRAP }}>
              <Typography variant="body2" sx={WRAP}>
                {valuesLine(item)}
              </Typography>
              {showResult && item.result && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ...WRAP }}>
                  {item.result}
                </Typography>
              )}
              {item.runId && (
                <Link component={RouterLink} to={`/runs/${item.runId}`} variant="body2" underline="hover" sx={TAP}>
                  Open run
                </Link>
              )}
            </Box>
            <StatusChip status={itemChipStatus(item)} />
          </Stack>
        </Box>
      ))}
    </Box>
  );
}
