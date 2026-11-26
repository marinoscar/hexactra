// "This could have used your account" (E41.5, #702; reworded by E50.17, #987): a run that did account work in the browser (it visited a
// webmail, calendar or files site of a provider) while it had no connection of that provider able to do that kind of work. Since every
// connection the owner switched on is available to every run (E50.17), that can only be because the owner's account of that provider is
// paused, or has that capability switched off: the line says which switch to turn on, on the Connections page. Information for the owner
// only: never shown to the model, and it changes no setting. Computed from the run's own steps and snapshot, so no column is needed.
import { accountHostsVisited, type AccountService } from '@marinoscar/hexactra-browser-agent/account-hosts';

import { readSnapshotConnections } from '../policies/policy-snapshot';
import type { PrismaService } from '../prisma/prisma.service';

export interface SuggestedConnection {
  connectionId: string;
  label: string;
  provider: string;
  /** What the run did in the browser: "Google Mail". */
  site: string;
  /** Where the run came from: a task, or a chat. */
  scope: 'task' | 'chat';
  /** The switch to turn on, on the Connections page: resume the account, or switch the capability on. */
  fix: 'resume' | 'capability';
  /** The line the result card and the run page show. */
  text: string;
}

const SERVICE_WORDS: Record<AccountService, string> = { mail: 'Mail', calendar: 'Calendar', files: 'Documents' };

const CAPS: Record<AccountService, string[]> = {
  mail: ['mail_read', 'mail_send', 'mail_modify'],
  calendar: ['calendar_read', 'calendar_write'],
  files: ['docs_read', 'docs_write'],
};

/** The owner's accounts that could have done what the run did in the browser, had a switch been on. Empty for most runs. */
export async function suggestedConnections(
  prisma: PrismaService,
  userId: string,
  run: { id: string; taskId: string | null; conversationId: string | null; policySnapshot: unknown },
): Promise<SuggestedConnection[]> {
  const scope = run.taskId ? 'task' : run.conversationId ? 'chat' : null;
  if (!scope) return [];
  const steps = await prisma.runStep.findMany({ where: { runId: run.id, kind: 'action', ok: true, action: { in: ['navigate', 'new_tab'] } }, select: { args: true }, orderBy: { seq: 'asc' }, take: 500 });
  const urls = steps.map((s) => (s.args as { url?: unknown } | null)?.url).filter((u): u is string => typeof u === 'string');
  const visited = accountHostsVisited(urls);
  if (visited.length === 0) return [];
  // The connections the run listed, read defensively from its snapshot (any shape: a missing or older snapshot lists none).
  const listed = readSnapshotConnections((run.policySnapshot ?? null) as never);
  const out: SuggestedConnection[] = [];
  for (const site of visited) {
    // (a) The run had a connection of this provider able to do this kind of work: nothing to suggest.
    if (listed.some((c) => c.provider === site.provider && c.capabilities.some((cap) => CAPS[site.service].includes(cap)))) continue;
    // (b) The owner's accounts of that provider that a switch kept out of this run: paused (with the capability on), or active with it off.
    const rows = await prisma.connection.findMany({ where: { userId, provider: site.provider, status: { in: ['active', 'paused'] } }, select: { id: true, label: true, status: true, capabilities: true }, orderBy: { label: 'asc' } });
    for (const r of rows) {
      const capable = r.capabilities.some((cap) => CAPS[site.service].includes(cap));
      const fix = r.status === 'paused' ? (capable ? 'resume' : null) : capable ? null : 'capability';
      if (!fix || out.some((o) => o.connectionId === r.id)) continue;
      const what = fix === 'resume' ? `"${r.label}" is paused: resume it` : `"${r.label}" has ${SERVICE_WORDS[site.service]} switched off: switch it on`;
      out.push({ connectionId: r.id, label: r.label, provider: site.provider, site: site.name, scope, fix, text: `This used the browser for ${site.name}. ${what} in Connections and tools to do this without the browser.` });
    }
  }
  return out.slice(0, 5);
}
