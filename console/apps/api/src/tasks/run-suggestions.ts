// "This could have used your account" (E41.5, #702): a run that did account work in the browser (it visited a webmail, calendar or files
// site of a provider) while it had no connection of that provider for that kind of work, and the owner has such a connection the task or
// chat does not list. Information for the owner only: it is never shown to the model and it changes no setting. Computed from the run's own
// steps and snapshot, so no column is needed.
import { accountHostsVisited, type AccountService } from '@marinoscar/hexactra-browser-agent/account-hosts';

import { readSnapshotConnections } from '../policies/policy-snapshot';
import type { PrismaService } from '../prisma/prisma.service';

export interface SuggestedConnection {
  connectionId: string;
  label: string;
  provider: string;
  /** What the run did in the browser: "Google Mail". */
  site: string;
  /** Where the owner lists it: the run's task, or its chat. */
  scope: 'task' | 'chat';
  /** The line the result card and the run page show. */
  text: string;
}

const CAPS: Record<AccountService, string[]> = {
  mail: ['mail_read', 'mail_send', 'mail_modify'],
  calendar: ['calendar_read', 'calendar_write'],
  files: ['docs_read', 'docs_write'],
};

/** The owner's unlisted connections that could have done what the run did in the browser. Empty for most runs. */
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
    // (b) The owner's active connections of that provider, with the capability on, that the task or chat does not list.
    const rows = await prisma.connection.findMany({ where: { userId, provider: site.provider, status: 'active', id: { notIn: listed.map((c) => c.connectionId) } }, select: { id: true, label: true, capabilities: true }, orderBy: { label: 'asc' } });
    for (const r of rows.filter((x) => x.capabilities.some((cap) => CAPS[site.service].includes(cap)))) {
      if (out.some((o) => o.connectionId === r.id)) continue;
      out.push({
        connectionId: r.id,
        label: r.label,
        provider: site.provider,
        site: site.name,
        scope,
        text: `This used the browser for ${site.name}. You have "${r.label}" connected: allow it for this ${scope} to do this without the browser.`,
      });
    }
  }
  return out.slice(0, 5);
}
