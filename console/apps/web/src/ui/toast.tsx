import { Alert, Snackbar } from '@mui/material';
import { useSyncExternalStore } from 'react';

export interface ToastMessage {
  id: number;
  message: string;
  severity: 'success' | 'info' | 'warning' | 'error';
}

let current: ToastMessage | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: ToastMessage | null) {
  current = next;
  for (const listener of listeners) listener();
}

/**
 * Shows a short confirmation ("Task created") that outlives the page that
 * raised it: call it, then navigate. `ToastHost` (mounted once, in the shell)
 * renders it; without a host nothing shows and nothing fails.
 */
export function toast(message: string, severity: ToastMessage['severity'] = 'success'): void {
  set({ id: nextId++, message, severity });
}

/** Clears the toast (tests). */
export function dismissToast(): void {
  set(null);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The one snackbar `toast()` fills. It sits above the phone's bottom navigation. */
export function ToastHost() {
  const value = useSyncExternalStore(subscribe, () => current);
  return (
    <Snackbar
      key={value?.id}
      open={value !== null}
      autoHideDuration={4000}
      onClose={(_, reason) => {
        if (reason !== 'clickaway') dismissToast();
      }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      sx={{ bottom: { xs: 'calc(72px + env(safe-area-inset-bottom))', sm: 24 } }}
    >
      {value ? (
        <Alert severity={value.severity} variant="filled" role="status" onClose={dismissToast} sx={{ width: '100%' }}>
          {value.message}
        </Alert>
      ) : undefined}
    </Snackbar>
  );
}
