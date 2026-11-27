import { useEffect, useRef } from 'react';

/**
 * Runs `apply` when `value` becomes a different object from the one it last saw, and never on mount (#1044).
 *
 * For a form that copies its props into state (an admin card's saved settings): it re-syncs after a save or a reload, but its mount
 * does not copy the props in a second time. Such a mount-time copy runs as a passive effect, so React may run it after a click that
 * came right after the form appeared, and the click is lost.
 */
export function useOnNewValue<T>(value: T, apply: (value: T) => void): void {
  const last = useRef(value);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (Object.is(last.current, value)) return;
    last.current = value;
    applyRef.current(value);
  }, [value]);
}
