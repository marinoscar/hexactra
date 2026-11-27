// #1044: an admin card's form copies its saved settings into state again only when they change, never on mount, so a click made right
// after the card appeared is kept (the MCP card test once lost it on a slow runner).
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useOnNewValue } from '../ui/useOnNewValue';

describe('useOnNewValue', () => {
  it('does nothing on mount or for the same object, and applies a new object once', () => {
    const apply = vi.fn();
    const first = { enabled: false };
    const { rerender } = renderHook(({ v }) => useOnNewValue(v, apply), { initialProps: { v: first } });
    expect(apply).not.toHaveBeenCalled();
    rerender({ v: first });
    expect(apply).not.toHaveBeenCalled();
    const second = { enabled: true };
    rerender({ v: second });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(second);
    rerender({ v: second });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('uses the latest callback', () => {
    const a = vi.fn();
    const b = vi.fn();
    const { rerender } = renderHook(({ v, f }) => useOnNewValue(v, f), { initialProps: { v: 1, f: a } });
    rerender({ v: 2, f: b });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(2);
  });
});
