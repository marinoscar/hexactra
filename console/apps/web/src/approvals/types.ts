// Saved approvals (#554): the shapes `/api/approval-rules` answers, and the
// pure helpers the page uses (grouping, the limit text, narrowing checks).

export type ApprovalRuleKind = 'gate' | 'ask';

/** The Saved approvals page's route. */
export const SAVED_APPROVALS_PATH = '/settings/approvals';
/** Where a step allowed by a saved approval links to (#555 sets `args.approval.ruleId` on the step). */
export function savedApprovalHref(ruleId: string): string {
  return `${SAVED_APPROVALS_PATH}#rule-${ruleId}`;
}

export interface ApprovalRule {
  id: string;
  kind: ApprovalRuleKind;
  host: string;
  category: string | null;
  matchKey: string;
  summary: string;
  taskId: string | null;
  taskName: string | null;
  conversationId: string | null;
  maxAmount: number | null;
  expiresAt: string | null;
  enabled: boolean;
  createdFromQuestionId: string | null;
  useCount: number;
  lastUsedAt: string | null;
  lastUsedRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRulesList {
  paused: boolean;
  rules: ApprovalRule[];
}

/** The categories that move money or delete something: shown in the warning colour. */
export const RISKY_CATEGORIES: readonly string[] = ['payment', 'purchase', 'send', 'delete'];
/** The categories an amount limit makes sense for. */
export const AMOUNT_CATEGORIES: readonly string[] = ['payment', 'purchase', 'send'];

/** The chip of a rule: its gate category, or "Question" for an ask. */
export function categoryLabel(r: Pick<ApprovalRule, 'kind' | 'category'>): string {
  if (r.kind === 'ask') return 'Question';
  const c = r.category ?? 'submit';
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/** Rules grouped by site, sites in alphabetical order, each site's rules newest first (as the API sends them). */
export function groupBySite(rules: readonly ApprovalRule[]): { host: string; rules: ApprovalRule[] }[] {
  const map = new Map<string, ApprovalRule[]>();
  for (const r of rules) map.set(r.host, [...(map.get(r.host) ?? []), r]);
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([host, list]) => ({ host, rules: list }));
}

/** "$50.00" for an amount limit. */
export function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The rule's limits in words: "up to $50.00 · only in the task Zelle to Paula · until Dec 31, 2026", or "No limits". */
export function limitsText(r: ApprovalRule, formatDate: (iso: string) => string = (iso) => new Date(iso).toLocaleDateString()): string {
  const parts: string[] = [];
  if (r.maxAmount !== null) parts.push(`up to ${money(r.maxAmount)}`);
  if (r.taskId) parts.push(r.taskName ? `only in the task ${r.taskName}` : 'only in one task');
  if (r.conversationId) parts.push('only in one chat');
  if (r.expiresAt) parts.push(`until ${formatDate(r.expiresAt)}`);
  return parts.length > 0 ? parts.join(' · ') : 'No limits';
}

/** "Used 4 times" / "Used once" / "Never used". */
export function usesText(r: Pick<ApprovalRule, 'useCount'>): string {
  if (r.useCount === 0) return 'Never used';
  return r.useCount === 1 ? 'Used once' : `Used ${r.useCount} times`;
}

/** What the limit dialog may send: only fields that narrow. */
export interface LimitDraft {
  maxAmount: string;
  /** `yyyy-mm-dd`, or empty. */
  expiresOn: string;
  taskId: string;
}

export function toLimitDraft(r: ApprovalRule): LimitDraft {
  return { maxAmount: r.maxAmount === null ? '' : String(r.maxAmount), expiresOn: r.expiresAt ? r.expiresAt.slice(0, 10) : '', taskId: r.taskId ?? '' };
}

/**
 * The patch a draft makes, or the reason it cannot be sent. A limit can be set or tightened, never
 * loosened: the server refuses a wider patch too (`RULE_CANNOT_WIDEN`); this says so before sending.
 */
export function limitPatch(r: ApprovalRule, d: LimitDraft): { patch: Record<string, unknown> } | { error: string; field: keyof LimitDraft } {
  const patch: Record<string, unknown> = {};
  const amount = d.maxAmount.trim();
  if (amount === '') {
    if (r.maxAmount !== null) return { error: 'An amount limit cannot be removed. Answer a new request to make a looser rule.', field: 'maxAmount' };
  } else {
    const n = Number(amount.replace(/^\$/, '').replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) return { error: 'Enter an amount greater than zero.', field: 'maxAmount' };
    if (r.maxAmount !== null && n > r.maxAmount) return { error: `The limit can only go down from ${money(r.maxAmount)}.`, field: 'maxAmount' };
    if (r.maxAmount === null || n < r.maxAmount) patch.maxAmount = Math.round(n * 100) / 100;
  }
  if (d.expiresOn === '') {
    if (r.expiresAt) return { error: 'The end date cannot be removed.', field: 'expiresOn' };
  } else if (!r.expiresAt || d.expiresOn !== r.expiresAt.slice(0, 10)) {
    const at = new Date(`${d.expiresOn}T23:59:59`);
    if (Number.isNaN(at.getTime())) return { error: 'Enter a date.', field: 'expiresOn' };
    if (r.expiresAt && at.getTime() > new Date(r.expiresAt).getTime()) return { error: 'The end date can only move earlier.', field: 'expiresOn' };
    if (!r.expiresAt || at.getTime() < new Date(r.expiresAt).getTime()) patch.expiresAt = at.toISOString();
  }
  if (d.taskId === '') {
    if (r.taskId) return { error: 'The task limit cannot be removed.', field: 'taskId' };
  } else if (r.taskId && d.taskId !== r.taskId) {
    return { error: 'The task limit cannot be changed.', field: 'taskId' };
  } else if (!r.taskId) {
    patch.taskId = d.taskId;
  }
  return { patch };
}
