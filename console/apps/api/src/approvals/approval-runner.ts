// What the runner needs of saved approvals (#555): pure, no I/O. The facts a rule
// is made from and matched on are the SERVER's: the registrable domain of the
// page the fabric reports, the gate's verdict (#550), a fixed ask topic. The
// model's words never become a host, a category, a label or a topic here.
import { ASK_TOPICS, ASK_TOPIC_PHRASES, GATE_CATEGORIES, normaliseLabel, registrableDomain, ruleSummary, type AskTopic } from './approval-match';

/** What a question may be remembered as (the question's `rememberable`). */
export interface RememberableFacts {
  kind: 'gate' | 'ask';
  host: string;
  category: string | null;
  matchKey: string;
  summary: string;
}

/** A page's registrable domain from a URL or a bare host name (the gate keeps a host, #550). Null when it has none. */
export function siteOf(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost) return null;
  return registrableDomain(/^[a-z][a-z0-9+.-]*:/i.test(urlOrHost) ? urlOrHost : `https://${urlOrHost}/`);
}

/** The topic the model named, from the fixed list; anything else is `other`, which is never rememberable. */
export function askTopicOf(raw: unknown): AskTopic {
  return typeof raw === 'string' && (ASK_TOPICS as readonly string[]).includes(raw) ? (raw as AskTopic) : 'other';
}

/**
 * What a confirmation the gate stopped may be remembered as: the page's site, the verdict's category and the
 * element's label. Null when any of them is unknown (no site, no label, a category outside the gate's list).
 */
export function gateRememberable(gate: { host: string | null; category: string | null; label: string | null } | null | undefined): RememberableFacts | null {
  if (!gate) return null;
  const host = siteOf(gate.host);
  const category = gate.category && (GATE_CATEGORIES as readonly string[]).includes(gate.category) ? gate.category : null;
  const label = (gate.label ?? '').replace(/\s+/g, ' ').trim();
  if (!host || !category || !normaliseLabel(label)) return null;
  return { kind: 'gate', host, category, matchKey: label.slice(0, 200), summary: ruleSummary({ kind: 'gate', host, label }) };
}

/** What a confirmation the agent asked on its own may be remembered as: the page's site and the topic. Null for `other` or an unknown site. */
export function askRememberable(topic: AskTopic, pageUrlOrHost: string | null | undefined): RememberableFacts | null {
  const host = siteOf(pageUrlOrHost);
  if (!host || topic === 'other') return null;
  return { kind: 'ask', host, category: null, matchKey: topic, summary: ruleSummary({ kind: 'ask', host, topic }) };
}

/**
 * The line the model reads for the current site when the owner has ask rules there, so it stops asking:
 * "On bankofamerica.com the owner does not want to be asked before: choosing dates, opening menus." Advice
 * only: a rule is applied by the server, never by this line. Gate rules are never listed.
 */
export function askTopicsLine(host: string | null, topics: readonly string[]): string | null {
  const known = [...new Set(topics)].filter((t): t is AskTopic => t !== 'other' && (ASK_TOPICS as readonly string[]).includes(t));
  if (!host || known.length === 0) return null;
  const words = known.map((t) => ASK_TOPIC_PHRASES[t].charAt(0).toLowerCase() + ASK_TOPIC_PHRASES[t].slice(1)).map(gerund);
  return `On ${host} the owner does not want to be asked before: ${words.join(', ')}. (When you ask anyway, give request_human the topic.)`;
}

/** "open menus" → "opening menus". */
function gerund(phrase: string): string {
  const [verb, ...rest] = phrase.split(' ');
  const v = verb ?? '';
  const ing = v.endsWith('e') && !v.endsWith('ee') ? `${v.slice(0, -1)}ing` : `${v}ing`;
  return [ing, ...rest].join(' ');
}

/**
 * The end-of-run sentence (#555) when gate rules let steps through: "2 steps went ahead on saved approvals:
 * Press 'Pay' on bankofamerica.com." Null when none did. Only gate uses are passed in: ask rules do not notify.
 */
export function savedApprovalsLine(uses: readonly { summary: string }[]): string | null {
  if (uses.length === 0) return null;
  const summaries = [...new Set(uses.map((u) => u.summary))];
  const n = uses.length;
  return `${n} ${n === 1 ? 'step' : 'steps'} went ahead on ${summaries.length === 1 ? 'a saved approval' : 'saved approvals'}: ${summaries.join('; ')}.`;
}

/**
 * The amount at stake in a run when the owner's inputs make one known (#555): the one value of a task parameter
 * of type `money` (#552), as a number. Unknown (null) with no such parameter, with more than one, or when the
 * value is not a plain amount. Read defensively: a run without task parameters has none.
 */
export function knownAmount(run: { inputs?: unknown; task?: { parameters?: unknown } | null }): number | null {
  const params = Array.isArray(run.task?.parameters) ? (run.task!.parameters as { key?: unknown; type?: unknown }[]) : [];
  const moneyKeys = params.filter((p) => p && p.type === 'money' && typeof p.key === 'string').map((p) => p.key as string);
  if (moneyKeys.length !== 1) return null;
  const values = run.inputs && typeof run.inputs === 'object' ? (run.inputs as { values?: Record<string, { value?: unknown }> }).values : undefined;
  const raw = values?.[moneyKeys[0]!]?.value;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).replace(/^[^\d-]+/, '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
