// The words a run that ended carries as its result when the model did not say any.

/** The result of a run its owner stopped: what the last completed step was, masked. */
export function stoppedResult(log: readonly string[], mask: (text: string) => string): string {
  const last = [...log].reverse().find((l) => /^\d+\. /.test(l));
  if (!last) return 'Stopped by the owner before any step was completed.';
  return `Stopped by the owner. The last completed step was: ${mask(last.length > 400 ? `${last.slice(0, 399)}…` : last)}`;
}

/** How many of a run's last log lines a wrap-up without words reports. */
const NO_REPORT_LINES = 5;

/** The result of a wrap-up where the model called no `finish` (#540): the run's own last steps, masked. */
export function noReportResult(log: readonly string[], mask: (text: string) => string): string {
  const last = log.filter((l) => /^\d+\. /.test(l)).slice(-NO_REPORT_LINES);
  const lines = (last.length ? last : log.slice(-NO_REPORT_LINES)).map((l) => mask(l.length > 400 ? `${l.slice(0, 399)}…` : l));
  return lines.length ? `Stopped before the agent could report. Last steps:\n${lines.join('\n')}` : 'Stopped before the agent could report.';
}
