// Classification of a repair (E46.17): `sensitive` changes wait for the owner; everything else is `structural` and promotes after a clean
// run. Pure. A change is sensitive when it touches what the graph must never widen on its own: commits, sites, accounts, secrets, recipients.
import type { ProcedureVersion, Step, Tool } from '../schema';
import { isApiFamily } from '../validate/validate';
import type { StepChange } from './diff';

export type SensitiveReason = 'commit_step' | 'commit_args' | 'new_site' | 'account' | 'secret_ref' | 'recipient' | 'judge_feeds_commit';

export interface Classification {
  changeClass: 'structural' | 'sensitive';
  reasons: { reason: SensitiveReason; step?: string; detail: string }[];
}

/** Arguments that name who or where something goes: a recipient or a destination. */
export const RECIPIENT_ARG = /^(to|cc|bcc|recipient|recipients|email|emails|phone|phone_number|sheet|sheetid|sheet_id|spreadsheetid|spreadsheet_id|documentid|document_id|docid|doc_id|fileid|file_id|folderid|folder_id|webhook|channel|destination|calendarid|calendar_id|connectionid|connection_id|connection)(\.|$)/i;

const isCommit = (s: Step | undefined, tools: Map<string, Tool>) => Boolean(s && (s.commitClass || (s.kind === 'call' && tools.get(s.tool)?.commits)));

export function classifyRepair(prev: ProcedureVersion, next: ProcedureVersion, changes: readonly StepChange[], catalogue: readonly Tool[]): Classification {
  const tools = new Map(catalogue.map((t) => [t.name, t]));
  const reasons: Classification['reasons'] = [];
  const add = (reason: SensitiveReason, detail: string, step?: string) => reasons.push({ reason, detail, ...(step ? { step } : {}) });
  for (const c of changes) {
    const s = c.after ?? c.before!;
    if ((c.kind === 'inserted' || c.kind === 'removed' || c.kind === 'retargeted') && (isCommit(c.before, tools) || isCommit(c.after, tools))) add('commit_step', `${c.kind} a step that sends or pays`, s.id);
    if (c.kind === 'rebound' && isCommit(c.after, tools)) add('commit_args', `changes ${c.args!.join(', ')} of a step that sends or pays`, s.id);
    if (c.kind === 'relocated' && isCommit(c.after, tools)) {
      const eb = c.before?.element ? prev.elements.find((e) => e.id === c.before!.element) : undefined;
      const ea = c.after?.element ? next.elements.find((e) => e.id === c.after!.element) : undefined;
      if (!eb || !ea || eb.role !== ea.role || eb.label !== ea.label) add('commit_args', 'moves a step that sends or pays to a different control', s.id);
    }
    if (c.kind === 'rebound') for (const a of c.args!) if (RECIPIENT_ARG.test(a)) add('recipient', `changes the recipient or destination "${a}"`, s.id);
    const after = c.after;
    if ((c.kind === 'inserted' || c.kind === 'retargeted') && after?.kind === 'call') {
      const t = tools.get(after.tool);
      if (t && isApiFamily(t.family) && !prev.steps.some((p) => p.kind === 'call' && p.tool === after.tool)) add('account', `uses ${t.family === 'accounts' ? 'an account tool' : 'an added tool'} it did not use before (${after.tool})`, s.id);
      for (const [a, b] of Object.entries(after.args)) if (RECIPIENT_ARG.test(a) && b.kind !== 'parameter') add('recipient', `sends to a new "${a}"`, s.id);
    }
  }
  const before = new Set(prev.sites.map((x) => x.domain));
  for (const site of next.sites) if (!before.has(site.domain)) add('new_site', `adds the site ${site.domain}`);
  const accountKey = (v: ProcedureVersion) => new Set(v.accounts.map((x) => `${x.provider}:${x.connectionId}`));
  const accBefore = accountKey(prev);
  for (const k of accountKey(next)) if (!accBefore.has(k)) add('account', 'adds a connected account');
  const refsBefore = new Set(prev.secretRefs.map((r) => `${r.kind}:${r.label}`));
  for (const r of next.secretRefs) if (!refsBefore.has(`${r.kind}:${r.label}`)) add('secret_ref', `uses the saved ${r.kind} "${r.label}"`);
  // A judge whose answer reaches a commit-class step is new: the model would decide part of a send.
  const judgeFeedsCommit = (v: ProcedureVersion) => new Set(v.steps.flatMap((s) => (s.kind === 'call' && isCommit(s, tools) && Object.values(s.args).some((b) => b.kind === 'judge') ? [s.tool] : [])));
  const jBefore = judgeFeedsCommit(prev);
  for (const t of judgeFeedsCommit(next)) if (!jBefore.has(t)) add('judge_feeds_commit', `lets a model call decide part of ${t}`);
  return { changeClass: reasons.length ? 'sensitive' : 'structural', reasons };
}
