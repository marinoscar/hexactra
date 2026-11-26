// The chat orchestrator's web tools (E50.7, #977): a public fact ("what is the capital of X", "when does the museum open") is answered in the
// thread with `web_search` and `web_fetch`, with no run. The same rule as a run (`runWeb`: set up and switched on means offered; a chat is the
// owner's own, so no AI app's limit applies), the same tools of `@marinoscar/hexactra-web-agent`, the same service, ports and per-port limits;
// what they return is third-party data, wrapped as such by the tools. They run against a small context of a chat turn instead of a run.
import { defineTool, type AiDefinedTool } from '@marinoscar/platform-api/ai';
import { webTools, type WebContext, type WebExt } from '@marinoscar/hexactra-web-agent';
import { Logger } from '@nestjs/common';

import type { HostDeps } from '../runner/host/deps';
import { runWeb } from '../runner/host/web-availability';
import { bindWeb } from '../runner/host/web-port';
import { maskSensitive } from '../tasks/mask';

/** Added to the chat's instructions only when the web tools are offered: the exact sentence is quoted in docs/chat.md and the PR. */
export const WEB_CHAT_INSTRUCTIONS =
  '- A public fact (a date, a price, opening hours, a definition, which page to use) can be looked up directly with web_search, and web_fetch to read a page: answer it in the chat, no job is needed. A job on a website (signing in, filling a form, buying) or with the owner\'s accounts is a run: call start_run.';

type Deps = Pick<HostDeps, 'webSearch' | 'webFetch'> & { log?: HostDeps['log'] };

/** The context a chat turn gives a web tool: the pieces the tools touch, and nothing that writes a step (the turn's own trace records the call). */
function turnContext(c: { userId: string; orgId: string | null; conversationId: string }, web: WebExt, toolAttributes: (a: Record<string, string | number | boolean>) => void): WebContext {
  const never = new AbortController().signal;
  const ctx = {
    run: { id: c.conversationId, userId: c.userId, orgId: c.orgId, goal: '', trigger: 'chat', taskId: null, conversationId: c.conversationId },
    memory: { log: [], chunks: 0 },
    state: { seq: 0, stepCount: 0, stop: null },
    ports: { control: { abortSignal: never, requested: false, pauseRequested: false }, telemetry: { toolAttributes }, policy: { mask: (text: string) => maskSensitive(text).text } },
    ext: { web },
    preflight: async () => null,
    setActivity: async () => undefined,
    record: async () => undefined,
  };
  return ctx as unknown as WebContext;
}

/** The web tools of the owner's chat as AI tools; none when web search is not set up and switched on for them. */
export async function chatWebTools(d: Deps, c: { userId: string; orgId: string | null; conversationId: string }, toolAttributes: (a: Record<string, string | number | boolean>) => void): Promise<AiDefinedTool[]> {
  if (!d.webSearch) return [];
  const log = d.log ?? new Logger('ChatWeb');
  const on = await runWeb({ webSearch: d.webSearch, log }, { userId: c.userId, orgId: c.orgId }, null, null);
  const web = await bindWeb({ ...d, log }, { userId: c.userId, orgId: c.orgId, runId: c.conversationId, web: on, sites: null, earlierCalls: async () => 0 });
  if (!web) return [];
  const ctx = turnContext(c, web, toolAttributes);
  return webTools
    .filter((t) => !t.available || t.available(ctx))
    .map((t) => defineTool({ name: t.name, description: t.description, parameters: t.parameters as never, execute: async (args: never) => String(await t.execute(ctx, args, {})) }));
}
