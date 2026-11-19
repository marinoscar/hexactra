// Email triggers in the CLI (E39.8, #605): `hexactra tasks triggers list <task>`. Reading only: the form that makes a trigger is in the
// web app (it picks the account and the input mapping). Nothing printed here is a subject or a body: the API holds none.
export interface MailTriggerView {
  id: string;
  taskId: string;
  connectionLabel: string | null;
  name: string;
  enabled: boolean;
  match: { from: string[]; to?: string; subjectContains?: string; textContains?: string; hasAttachment?: boolean; label?: string };
  afterStart: string;
  pollSeconds: number;
  maxRunsPerDay: number;
  status: string;
  statusReason: string | null;
  lastCheckedAt: string | null;
  runsToday: number;
}

const STATUS_WORDS: Record<string, string> = {
  ok: 'watching',
  needs_reconnect: 'account must be connected again',
  failing: 'failing',
  rate_limited: 'waiting (the provider asked to slow down)',
  connection_paused: 'account paused',
  connection_removed: 'account removed',
};

/** `when` clause in words: "from a@example.test, subject has "invoice", with an attachment". */
export function matchText(m: MailTriggerView['match']): string {
  const parts = [`from ${m.from.join(' or ')}`];
  if (m.to) parts.push(`to ${m.to}`);
  if (m.subjectContains) parts.push(`subject has "${m.subjectContains}"`);
  if (m.textContains) parts.push(`text has "${m.textContains}"`);
  if (m.hasAttachment === true) parts.push('with an attachment');
  if (m.hasAttachment === false) parts.push('without an attachment');
  return parts.join(', ');
}

export function triggerLine(t: MailTriggerView): string {
  const state = !t.enabled ? 'off' : (STATUS_WORDS[t.status] ?? t.status);
  const after = t.afterStart === 'none' ? '' : `  after: ${t.afterStart.replace('_', ' ')}`;
  return `${t.id.slice(0, 8)}  ${t.name}  [${state}]  ${t.connectionLabel ?? 'account removed'}  ${matchText(t.match)}  every ${Math.round(t.pollSeconds / 60)} min  ${t.runsToday}/${t.maxRunsPerDay} runs today${after}`;
}
