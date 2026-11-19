import { Box, Typography } from '@mui/material';

/** A run's parameter value as `GET /runs/{id}` returns it (#552): masked, with where it came from. */
export interface RunInput {
  key: string;
  label: string;
  value: string;
  source: 'provided' | 'default' | 'memory' | 'asked' | 'schedule';
}

/** Where a value came from, in words. */
export const SOURCE_TEXT: Record<RunInput['source'], string> = {
  provided: 'you entered',
  asked: 'you entered',
  default: 'saved value',
  memory: 'from a memory',
  schedule: 'schedule',
};

/**
 * The Inputs block under a run's goal (#556): each parameter's label, its
 * value masked as the API returns it, and where it came from. Nothing for a
 * run without parameters. A sensitive value is never stored: the API says
 * "[provided at run time]".
 */
export function RunInputs({ inputs }: { inputs: readonly RunInput[] | null | undefined }) {
  if (!inputs || inputs.length === 0) return null;
  return (
    <Box component="section" aria-label="Inputs" sx={{ mb: 2 }}>
      <Typography variant="subtitle2" component="h2" sx={{ mb: 0.5 }}>
        Inputs
      </Typography>
      <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(120px, max-content) 1fr' }, columnGap: 2, rowGap: { xs: 0, sm: 0.5 } }}>
        {inputs.map((i) => (
          <Box key={i.key} sx={{ display: 'contents' }}>
            <Typography component="dt" variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {i.label}
            </Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0, mb: { xs: 1, sm: 0 }, overflowWrap: 'anywhere' }}>
              {i.value}{' '}
              <Box component="span" sx={{ color: 'text.secondary' }}>
                · {SOURCE_TEXT[i.source] ?? i.source}
              </Box>
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
