import { Alert, Button } from '@mui/material';

export interface ErrorBannerProps {
  /** The message; `null` renders nothing. */
  error: string | null;
  onRetry?: () => void;
  onClose?: () => void;
}

/** A failed load or change, announced to assistive technology (`role="alert"`). */
export function ErrorBanner({ error, onRetry, onClose }: ErrorBannerProps) {
  if (!error) return null;
  return (
    <Alert
      severity="error"
      role="alert"
      sx={{ mb: 2, overflowWrap: 'anywhere' }}
      onClose={onClose}
      action={
        onRetry ? (
          <Button color="inherit" size="small" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      {error}
    </Alert>
  );
}
