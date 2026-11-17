/**
 * The alert rule kinds that read recent runs (`stop_reason`, `cost_usd`,
 * tokens) over their `windowHours`. Run retention (#422) never deletes a run
 * younger than the longest window of an enabled rule of these kinds. Add a
 * kind here when it reads `runs`. Ids are those of `HEXACTRA_ALERT_KINDS`
 * (hexactra-alert-kinds.ts checks they match); kept apart from that file so
 * reading them registers nothing.
 */
export const RUN_READING_ALERT_KINDS = ['hexactra_run_budget', 'hexactra_run_stalled', 'hexactra_run_cost'] as const;
