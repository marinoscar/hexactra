// The run's OpenTelemetry trace id (E38.4, #585): a copyable id under the run's details, so an engineer can find the
// run in the deployment's trace collector. No link is built: the collector's address is the deployment's business.
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { IconButton, Stack, Tooltip, Typography } from '@mui/material';

import { toast } from '../ui';

export function RunTraceId({ traceId }: { traceId: string | null | undefined }) {
  if (!traceId) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(traceId);
      toast('Copied');
    } catch {
      toast('Select the id and copy it');
    }
  };
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 1, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        Trace id
      </Typography>
      <Typography component="code" variant="caption" data-testid="run-trace-id" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere', minWidth: 0 }}>
        {traceId}
      </Typography>
      <Tooltip title="Copy the trace id">
        <IconButton onClick={() => void copy()} aria-label="Copy the trace id" size="small" sx={{ minWidth: 44, minHeight: 44 }}>
          <ContentCopyOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
