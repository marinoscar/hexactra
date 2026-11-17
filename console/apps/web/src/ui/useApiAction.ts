import { useCallback, useState } from 'react';

export interface ApiAction {
  /**
   * Runs `fn` as the action `key`: `busy` is the key while it runs, a failure
   * is caught and stored in `error`. Resolves to what `fn` returned, or
   * `undefined` when it failed; it never rejects.
   */
  run: <T>(key: string, fn: () => Promise<T>, fallback?: string) => Promise<T | undefined>;
  /** The key of the action in progress, or null. */
  busy: string | null;
  /** The message of the last failure, or null. */
  error: string | null;
  clearError: () => void;
  /** For a failure outside `run` (a load) that should show in the same banner. */
  setError: (message: string | null) => void;
}

/**
 * One change at a time, with its busy key and its error: what a page's
 * buttons need around an API call.
 *
 * @param defaultFallback - the message of a failure that carries none.
 */
export function useApiAction(defaultFallback = 'The change failed'): ApiAction {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T>(key: string, fn: () => Promise<T>, fallback?: string): Promise<T | undefined> => {
      setBusy(key);
      setError(null);
      try {
        return await fn();
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : (fallback ?? defaultFallback));
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [defaultFallback],
  );
  const clearError = useCallback(() => setError(null), []);
  return { run, busy, error, clearError, setError };
}
