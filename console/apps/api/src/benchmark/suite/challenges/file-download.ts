// file-download (E44.7, #745): a statement that is only in a downloaded file (served as an attachment, `pages.ts` `file`). Reading a
// downloaded file has no browser action yet, so the challenge `requires: ['file_download']`, is reported `unsupported` at the start
// and is never run. Its pages, its file and its grader are complete: once the agent can read a download, adding the capability to
// `AGENT_CAPABILITIES` makes it run (with a suite version bump).
import { reportedAmount } from '../compare';
import { file, html, notFound, page, type SiteRequest, type SiteResponse } from '../pages';
import { formatPrice, seeded } from '../seeded';
import type { Challenge, Check, Seed } from '../types';
import { MONTHS } from './shared';

const BRAND = 'Account statements';

export function fileDownloadPlan(seed: Seed): { account: string; statements: { month: string; file: string; cents: number }[]; target: number } {
  const g = seeded(seed, 'file-download');
  const account = g.reference('ACC');
  const start = g.int(0, 6);
  const statements = Array.from({ length: 6 }, (_, i) => ({ month: `${MONTHS[start + i]} 2030`, file: `statement-2030-${String(start + i + 1).padStart(2, '0')}.txt`, cents: g.price(50, 5000).cents }));
  return { account, statements, target: g.int(0, statements.length - 1) };
}

function handle(req: SiteRequest): SiteResponse {
  const plan = fileDownloadPlan(req.seed);
  if (req.method !== 'GET') return notFound();
  if (req.path === '') {
    return page({
      title: `Statements for ${plan.account}`,
      brand: BRAND,
      body: html`<p>Each statement is a file to download.</p><ul class="menu">${plan.statements.map((s) => html`<li><a href="${req.root}files/${s.file}" download>${s.month}</a></li>`)}</ul>`,
    });
  }
  const s = req.segments[0] === 'files' && req.segments.length === 2 ? plan.statements.find((x) => x.file === req.segments[1]) : undefined;
  if (!s) return notFound();
  return file(s.file, `Account: ${plan.account}\nStatement: ${s.month}\nClosing balance: ${formatPrice(s.cents)}\n`);
}

function grade(seed: Seed, result: string): Check[] {
  const { statements, target } = fileDownloadPlan(seed);
  return [reportedAmount('reported-balance', result, statements[target]!.cents, statements.map((s) => s.cents), formatPrice)];
}

export const fileDownload: Challenge = {
  id: 'file-download',
  title: 'Read a figure from a downloaded file',
  category: 'extraction',
  difficulty: 2,
  requires: ['file_download'],
  setup: () => ({}),
  goal: (seed, baseUrl) => {
    const p = fileDownloadPlan(seed);
    return `Open ${baseUrl}/ and report the closing balance in the ${p.statements[p.target]!.month} statement.`;
  },
  grade: ({ seed, result }) => grade(seed, result),
  site: { handle },
};
