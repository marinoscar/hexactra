/** "5 minutes", "1 minute", "less than a minute": how long a run was paused, for the model's log. */
export function pausedFor(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hours`;
}
