// Reports of the replay suite (E38.6): the table and JUnit XML of a scripted run, and the Markdown of a live summary with its diff against
// the last saved baseline. Pure functions over results, so a spec can check them without running anything.
import type { LiveScenarioSummary, LiveSummary } from './live';
import type { ScenarioResult } from './run-scenario';

const actionSteps = (r: ScenarioResult): number => r.steps.filter((s) => s.kind === 'action').length;
const tokensOf = (r: ScenarioResult): number => r.usage.inputTokens + r.usage.outputTokens;

/** A fixed-width table of a scripted run: one row per scenario, then the totals line. */
export function resultsTable(results: ScenarioResult[]): string {
  const rows = results.map((r) => [r.pass ? 'PASS' : 'FAIL', r.scenario.name, r.status, String(actionSteps(r)), String(tokensOf(r)), String(r.asked.length), r.violations.join(', ') || '-']);
  const head = ['', 'scenario', 'status', 'steps', 'tokens', 'asked', 'violations'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  const failed = results.filter((r) => !r.pass);
  const out = [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line), '', `${results.length - failed.length} of ${results.length} scenarios passed`];
  for (const r of failed) out.push('', `FAILED: ${r.scenario.name}`, ...r.failures.map((f) => `  - ${f}`));
  return out.join('\n');
}

const xml = (s: string): string => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** JUnit XML for CI: a test case per scenario, its failures as the message. `file` names each scenario's source for the report. */
export function junitXml(results: ScenarioResult[], files: Map<string, string> = new Map(), suite = 'hexactra scenarios (scripted)'): string {
  const failures = results.filter((r) => !r.pass).length;
  const cases = results.map((r) => {
    const name = xml(r.scenario.name);
    const classname = xml(files.get(r.scenario.name) ?? 'scenario');
    const body = r.pass ? '' : `\n      <failure message="${xml(r.failures[0] ?? 'failed')}">${xml(r.failures.join('\n'))}</failure>\n    `;
    return `    <testcase classname="${classname}" name="${name}" time="0">${body}</testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="${xml(suite)}" tests="${results.length}" failures="${failures}" errors="0" skipped="0">\n${cases.join('\n')}\n  </testsuite>\n</testsuites>\n`;
}

export interface BaselineDiff {
  scenario: string;
  /** In the baseline and in this run: how the numbers moved. Null for a scenario one side lacks. */
  passRate: { before: number; after: number } | null;
  steps: { before: number; after: number } | null;
  tokens: { before: number; after: number } | null;
  costUsd: { before: number | null; after: number | null } | null;
  /** Worse than the baseline: a lower pass rate, or a violation the baseline did not have. */
  regression: boolean;
  note?: string;
}

/** What changed against the last saved baseline, per scenario. */
export function diffBaseline(current: LiveSummary, baseline: LiveSummary | null): BaselineDiff[] {
  if (!baseline) return [];
  const before = new Map(baseline.scenarios.map((s) => [s.name, s]));
  const diffs: BaselineDiff[] = current.scenarios.map((s) => {
    const b = before.get(s.name);
    if (!b) return { scenario: s.name, passRate: null, steps: null, tokens: null, costUsd: null, regression: false, note: 'new: not in the baseline' };
    const newViolations = s.violations.filter((v) => !b.violations.includes(v));
    return {
      scenario: s.name,
      passRate: { before: b.passRate, after: s.passRate },
      steps: { before: b.medianSteps, after: s.medianSteps },
      tokens: { before: b.medianTokens, after: s.medianTokens },
      costUsd: { before: b.medianCostUsd, after: s.medianCostUsd },
      regression: s.passRate < b.passRate || newViolations.length > 0,
      ...(newViolations.length ? { note: `new violations: ${newViolations.join(', ')}` } : {}),
    };
  });
  for (const b of baseline.scenarios) if (!current.scenarios.some((s) => s.name === b.name)) diffs.push({ scenario: b.name, passRate: null, steps: null, tokens: null, costUsd: null, regression: false, note: 'in the baseline, not run now' });
  return diffs;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const cost = (n: number | null): string => (n === null ? 'unknown' : `$${n.toFixed(4)}`);
const delta = (d: { before: number; after: number } | null, fmt: (n: number) => string = String): string => (d ? (d.before === d.after ? fmt(d.after) : `${fmt(d.before)} → ${fmt(d.after)}`) : '-');

function rowOf(s: LiveScenarioSummary, d: BaselineDiff | undefined): string {
  const costCell = d?.costUsd ? (d.costUsd.before === d.costUsd.after ? cost(d.costUsd.after) : `${cost(d.costUsd.before)} → ${cost(d.costUsd.after)}`) : cost(s.medianCostUsd);
  return `| ${s.name} | ${d?.passRate ? delta(d.passRate, pct) : pct(s.passRate)} (${s.passes}/${s.completed}) | ${d?.steps ? delta(d.steps) : s.medianSteps} | ${d?.tokens ? delta(d.tokens) : s.medianTokens} | ${costCell} | ${s.violations.join(', ') || '-'}${d?.regression ? ' **regression**' : ''} |`;
}

/** The Markdown summary of a live run: pass rate, median steps, tokens and cost per scenario, and the diff against the baseline. */
export function liveMarkdown(summary: LiveSummary, diffs: BaselineDiff[]): string {
  const byName = new Map(diffs.map((d) => [d.scenario, d]));
  const lines = [
    `# Live replay: tier ${summary.tier}`,
    '',
    `Generated ${summary.generatedAt}. ${summary.runsPerScenario} run(s) per scenario. Spent ${cost(summary.spentUsd)} of a ${cost(summary.capUsd)} cap${summary.capped ? ' (**the cap was reached: some scenarios did not run**)' : ''}.`,
    '',
    diffs.length ? 'Compared with the last saved baseline (before → after).' : 'No baseline saved for this tier yet: this run can become it.',
    '',
    '| scenario | pass rate | median steps | median tokens | median cost | violations |',
    '|---|---|---|---|---|---|',
    ...summary.scenarios.map((s) => rowOf(s, byName.get(s.name))),
  ];
  const notes = diffs.filter((d) => d.note);
  if (notes.length) lines.push('', ...notes.map((d) => `- ${d.scenario}: ${d.note}`));
  const regressions = diffs.filter((d) => d.regression);
  lines.push('', regressions.length ? `**${regressions.length} scenario(s) are worse than the baseline.**` : diffs.length ? 'Nothing is worse than the baseline.' : '');
  return `${lines.join('\n').trimEnd()}\n`;
}
