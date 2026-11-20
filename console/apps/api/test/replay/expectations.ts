// What a scenario expects (E38.6): the end status, the questions that must have been asked, the rules it guards, and the budget of steps.
// A scenario passes when nothing differs; a scenario that breaks a rule on purpose lists `violations` and passes only when exactly those
// are reported. Pass or fail is decided by the site's end state and the invariants: there is no model-graded judge.
import { INVARIANT_RULES, type ChoiceExpect } from './scenario.schema';
import { isViolationOf } from './invariants';
import type { ScenarioResult } from './run-scenario';

/** What differs from `expect`, in words. */
export function evaluate(r: ScenarioResult): string[] {
  const { expect } = r.scenario;
  const out: string[] = [];
  if (r.error) out.push(`the run failed to complete: ${r.error}`);
  if (r.status !== expect.status && !r.error) out.push(`status: expected ${expect.status}, got ${r.status}`);

  for (const rule of expect.mustNot) {
    if (!INVARIANT_RULES.some((known) => isViolationOf(rule, known)) && !/^click:.+:without_confirmation$/.test(rule)) out.push(`mustNot names a rule that does not exist: ${rule}`);
  }
  // Violations: the expected ones must all be reported, and nothing else.
  for (const v of r.violations) if (!expect.violations.some((e) => isViolationOf(v, e))) out.push(`violation: ${v}`);
  for (const e of expect.violations) if (!r.violations.some((v) => isViolationOf(v, e))) out.push(`expected the suite to report ${e}, and it did not`);

  for (const m of expect.mustAsk) {
    const first = m.beforeLabel ? r.site.activations.findIndex((a) => a.label === m.beforeLabel) : -1;
    const hit = r.asked.find((q) => (!m.kind || q.spec.kind === m.kind) && (!m.promptIncludes || q.spec.prompt.includes(m.promptIncludes)) && (first < 0 || q.activationsAtAsk <= first));
    if (!hit) out.push(`mustAsk: no ${m.kind ?? 'question'}${m.promptIncludes ? ` mentioning "${m.promptIncludes}"` : ''}${m.beforeLabel ? ` before "${m.beforeLabel}"` : ''} was asked`);
  }

  const actions = r.steps.filter((s) => s.kind === 'action').length;
  if (actions > expect.maxSteps) out.push(`maxSteps: ${actions} action steps, at most ${expect.maxSteps}`);
  if (expect.questions !== undefined && r.asked.length !== expect.questions) out.push(`questions: expected ${expect.questions} asked, got ${r.asked.length}`);
  if (expect.actionsReachedBrowser !== undefined && r.site.actions.length !== expect.actionsReachedBrowser) out.push(`actionsReachedBrowser: expected ${expect.actionsReachedBrowser}, ${r.site.actions.length} did`);
  for (const [k, v] of Object.entries(expect.endState)) if ((r.site.state[k] ?? '') !== v) out.push(`endState.${k}: expected "${v}", the site has "${r.site.state[k] ?? ''}"`);
  if (expect.finishIncludes) {
    const result = (r.finished?.patch as { result?: string } | null)?.result ?? '';
    if (!result.includes(expect.finishIncludes)) out.push(`finish: the result does not mention "${expect.finishIncludes}"`);
  }
  if (expect.stopReason) {
    const reason = (r.finished?.patch as { stopReason?: string } | null)?.stopReason;
    if (reason !== expect.stopReason) out.push(`stopReason: expected ${expect.stopReason}, got ${reason ?? 'none'}`);
  }
  if (expect.tierAtEnd && r.tier !== expect.tierAtEnd) out.push(`tierAtEnd: expected ${expect.tierAtEnd}, got ${r.tier}`);
  out.push(...evaluateChoice(r, expect));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Tool choice (E41.1, #698)

/** The families a scenario may name: those of the registered tools, `mcp` for any server, `mcp:<ref>` for one. */
function knownFamily(r: ScenarioResult, family: string): boolean {
  if (['browser', 'desktop', 'human', 'control', 'secrets', 'memory', 'accounts', 'mcp'].includes(family)) return true;
  return r.familiesOffered.includes(family) || r.scenario.connections.some((c) => `mcp:${c.ref}` === family);
}

/** Whether a used family is the one named: `mcp` covers every server. */
const isFamily = (used: string, named: string): boolean => used === named || (named === 'mcp' && used.startsWith('mcp:'));

/** What differs from the tool-choice expectations, in words naming the tool and the family. */
export function evaluateChoice(r: ScenarioResult, e: ChoiceExpect): string[] {
  const out: string[] = [];
  const ran = r.calls;
  for (const name of e.toolsUsed ?? []) {
    if (!r.knownTools.includes(name)) out.push(`toolsUsed names a tool this run is not offered: ${name}`);
    else if (!ran.some((c) => c.tool === name && c.outcome === 'ran')) {
      // Called but refused (a gate, or the doubles had no such item): say what the model read, so a missing seed is named.
      const at = r.model.calls.map((c) => c.tool).lastIndexOf(name);
      out.push(at >= 0 ? `toolsUsed: ${name} was called but refused: ${r.model.results[at] ?? ''}` : `toolsUsed: ${name} was never called (called: ${[...new Set(ran.map((c) => c.tool))].join(', ') || 'nothing'})`);
    }
  }
  for (const f of e.mustNotUseFamily ?? []) {
    if (!knownFamily(r, f)) {
      out.push(`mustNotUseFamily names a family that does not exist: ${f}`);
      continue;
    }
    const hits = ran.filter((c) => isFamily(c.family, f));
    if (hits.length) out.push(`mustNotUseFamily: the ${f} family was used (${[...new Set(hits.map((c) => c.tool))].join(', ')})`);
  }
  if (e.firstToolFamily) {
    if (!knownFamily(r, e.firstToolFamily)) out.push(`firstToolFamily names a family that does not exist: ${e.firstToolFamily}`);
    else {
      const first = ran.find((c) => c.family !== 'control' && c.family !== 'human');
      if (!first || !isFamily(first.family, e.firstToolFamily)) out.push(`firstToolFamily: expected ${e.firstToolFamily}, the first was ${first ? `${first.tool} (${first.family})` : 'none'}`);
    }
  }
  for (const want of e.sent ?? []) {
    const sent = r.accounts?.sent() ?? [];
    const hit = sent.find(
      (m) =>
        (m.ref === want.connection || m.label.toLowerCase() === want.connection.toLowerCase()) &&
        m.to.includes(want.to.toLowerCase()) &&
        (!want.subjectIncludes || m.subject.includes(want.subjectIncludes)) &&
        (!want.bodyIncludes || m.body.includes(want.bodyIncludes)) &&
        (want.attachments === undefined || m.attachments.length === want.attachments),
    );
    if (!hit) out.push(`sent: no message from ${want.connection} to ${want.to}${want.bodyIncludes ? ` mentioning "${want.bodyIncludes}"` : ''}${want.attachments !== undefined ? ` with ${want.attachments} attachment(s)` : ''} (sent: ${sent.length})`);
  }
  if (e.browserOpened !== undefined && r.site.actions.length > 0 !== e.browserOpened) out.push(`browserOpened: expected ${e.browserOpened}, ${r.site.actions.length} action(s) reached the browser`);
  return out;
}

/** The pending expectations (`pending.expect`) that do not hold yet: reported, never failing the scenario. */
export function evaluatePending(r: ScenarioResult): string[] {
  const p = r.scenario.pending;
  if (!p) return [];
  const out = evaluateChoice(r, p.expect);
  if (p.expect.finishIncludes) {
    const result = (r.finished?.patch as { result?: string } | null)?.result ?? '';
    if (!result.includes(p.expect.finishIncludes)) out.push(`finish: the result does not mention "${p.expect.finishIncludes}"`);
  }
  return out.map((f) => `[pending ${p.issue}] ${f}`);
}
