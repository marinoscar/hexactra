import { Box, Chip, Typography } from '@mui/material';

import { MASKED_OUTPUT, hasOutputs, missingCount, outputValueText, type RunOutput } from './model';

export interface RunOutputsProps {
  outputs: readonly RunOutput[] | null | undefined;
  /** `false`: not every output was found (a line says so). */
  complete?: boolean | null;
  /** Inside a chat card: a smaller heading and tighter rows. */
  dense?: boolean;
  sx?: object;
}

/**
 * The Outputs block of a run (E39.5, #600), on the run page and in the chat's result card: each output's label and value, a
 * missing one marked "Not found" with the reason (the agent's own words are in the result above it), a sensitive one hidden.
 * Nothing for a run without outputs. Values are page text: rendered as text, never as markup.
 */
export function RunOutputs({ outputs, complete, dense = false, sx }: RunOutputsProps) {
  if (!hasOutputs(outputs)) return null;
  const missing = missingCount(outputs);
  return (
    <Box component="section" aria-label="Outputs" data-testid="run-outputs" sx={{ mt: dense ? 1 : 2, mb: dense ? 0 : 2, ...sx }}>
      <Typography variant="subtitle2" component="h2" sx={{ mb: 0.5 }}>
        Outputs
      </Typography>
      <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(120px, max-content) 1fr' }, columnGap: 2, rowGap: { xs: 0, sm: 0.5 } }}>
        {outputs.map((o) => {
          const notFound = o.value === null && !o.ok;
          return (
            <Box key={o.key} sx={{ display: 'contents' }}>
              <Typography component="dt" variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                {o.label}
              </Typography>
              <Typography component="dd" variant="body2" sx={{ m: 0, mb: { xs: 1, sm: 0 }, overflowWrap: 'anywhere', ...(notFound ? { color: 'warning.main' } : {}) }}>
                {outputValueText(o)}
                {o.value === MASKED_OUTPUT && <Chip size="small" variant="outlined" label="Sensitive" sx={{ ml: 1, height: 20 }} />}
                {(notFound || (!o.ok && o.value === null)) && o.note && o.note !== 'Not found' && (
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    {' '}
                    · {o.note}
                  </Box>
                )}
              </Typography>
            </Box>
          );
        })}
      </Box>
      {(complete === false || missing > 0) && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {missing === 1 ? '1 output was not found' : `${missing} outputs were not found`}. The result above says why.
        </Typography>
      )}
    </Box>
  );
}
