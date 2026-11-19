/** Cuts a string to `n` characters, with an ellipsis when it was cut. */
export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
