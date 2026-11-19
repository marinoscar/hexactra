// ApprovalPort over the saved-approvals service (#555): matched by the server (registrable domain, category, exact label), never by the model.
import type { ApprovalRule } from '@prisma/client';

import { normaliseLabel } from '../../approvals/approval-match';
import { askRememberable, askTopicOf, askTopicsLine, gateRememberable, knownAmount, siteOf } from '../../approvals/approval-runner';
import type { ApprovalPort } from '@marinoscar/hexactra-agent';
import type { HostDeps } from './deps';

export interface ApprovalContext {
  d: HostDeps;
  userId: string;
  orgId: string | null;
  run: { id: string; taskId: string | null; conversationId: string | null; inputs: unknown; task: { parameters?: unknown } | null };
  /** The URL of the active tab, as the browser host reports it; null when there is no browser or it cannot be read. */
  currentUrl: () => Promise<string | null>;
  hasBrowser: () => boolean;
}

export function approvalPort(c: ApprovalContext): ApprovalPort {
  const { d, run } = c;
  return {
    enabled: Boolean(d.approvals),
    async matchGate(target) {
      if (!d.approvals) return null;
      try {
        return await d.approvals.match(c.userId, {
          kind: 'gate',
          pageUrl: `https://${target.host}/`,
          category: target.category as never,
          matchKey: normaliseLabel(target.label),
          taskId: run.taskId ?? null,
          conversationId: run.conversationId ?? null,
          // The owner's money input (#552), never the model's words.
          amount: knownAmount({ inputs: run.inputs as never, task: run.task ? { parameters: run.task.parameters } : null }),
        });
      } catch (e) {
        d.log.warn(`run ${run.id}: could not read saved approvals: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    async matchConnection(target) {
      if (!d.approvals) return null;
      try {
        return await d.approvals.matchConnection(c.userId, { connectionId: target.connectionId, tool: target.tool, recipients: target.recipients, taskId: run.taskId ?? null, conversationId: run.conversationId ?? null });
      } catch (e) {
        d.log.warn(`run ${run.id}: could not read saved approvals: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    async matchAsk(topic, pageUrl) {
      if (!d.approvals) return null;
      return d.approvals.match(c.userId, { kind: 'ask', pageUrl, category: null, matchKey: topic, taskId: run.taskId ?? null, conversationId: run.conversationId ?? null, amount: null });
    },
    async recordUse(rule, use) {
      await d.approvals?.recordUse(rule as ApprovalRule, { runId: run.id, stepSeq: use.stepSeq, orgId: c.orgId });
    },
    rememberableGate: (gate) => gateRememberable(gate as never),
    rememberableAsk: (topic, pageUrl) => askRememberable(topic as never, pageUrl),
    topicOf: (raw) => askTopicOf(raw),
    /** The line naming the owner's ask rules for the current site (#555), or null. Best effort; never fails the run. */
    async askTopicsLine(pageUrl) {
      if (!d.approvals || !c.hasBrowser()) return null;
      try {
        const url = pageUrl ?? (await c.currentUrl());
        const topics = await d.approvals.askTopics(c.userId, { pageUrl: url, taskId: run.taskId ?? null, conversationId: run.conversationId ?? null });
        return askTopicsLine(siteOf(url), topics);
      } catch {
        return null;
      }
    },
  };
}
