// The Knowledge Graph's capture (E46.5, #779): the harness's ObserverPort bound for a run whose effective mode is `learn` or `reuse`. For
// each tool call it writes one `kg_traces` row: each argument's provenance (`bindArguments`, never a value unless a safe literal), the state
// after the call (host and path, the stall detector's view digest, a result shape) and whether it worked. Outside the step transaction and
// best effort: a failed write is logged and counted, and the run goes on exactly as without it. With the mode `off` nothing is bound.
import type { Logger } from '@nestjs/common';
import type { ObserverPort, ToolCallObservation } from '@marinoscar/hexactra-agent';
import { bindArguments, defaultIsSensitive, hostAndPath, resultShapeOf, type EarlierResult, type PostState, type TraceParameter } from '@marinoscar/hexactra-kgraph';
import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../../prisma/prisma.service';
import { maskSensitive } from '../../../tasks/mask';
import { readRunInputs } from '../../../tasks/task-params.schemas';

/** Earlier results kept in memory for provenance (never stored): the newest 30, each clipped. */
const EARLIER_KEPT = 30;
const EARLIER_CHARS = 20_000;

/** The console's sensitive check: its pattern table (the one the trace masking uses) or the package's default. */
export const consoleIsSensitive = (value: string): boolean => maskSensitive(value).text !== value || defaultIsSensitive(value);

export interface KgraphObserverInput {
  prisma: Pick<PrismaService, 'kgTrace'>;
  log: Pick<Logger, 'warn'>;
  userId: string;
  runId: string;
  goal: string;
  /** `runs.inputs`: the parameter values the run was given (sensitive ones are never in it). */
  inputs: unknown;
}

export class KgraphObserver implements ObserverPort {
  private readonly earlier: EarlierResult[] = [];
  private readonly parameters: TraceParameter[];
  failures = 0;

  constructor(private readonly i: KgraphObserverInput) {
    const inputs = readRunInputs(i.inputs);
    this.parameters = Object.entries(inputs?.values ?? {}).map(([key, v]) => ({ key, value: v.value, sensitive: false }));
  }

  async toolCall(o: ToolCallObservation): Promise<void> {
    const bindings = bindArguments(o.args, { goal: this.i.goal, parameters: this.parameters, earlier: this.earlier, isSensitive: consoleIsSensitive });
    const post = postStateOf(o);
    this.earlier.push({ seq: o.seq, text: o.resultText.slice(0, EARLIER_CHARS) });
    if (this.earlier.length > EARLIER_KEPT) this.earlier.shift();
    try {
      await this.i.prisma.kgTrace.create({
        data: { userId: this.i.userId, runId: this.i.runId, seq: o.seq, tool: o.tool.slice(0, 64), family: o.family.slice(0, 200), commits: o.commits, bindings: bindings as unknown as Prisma.InputJsonValue, post: post as Prisma.InputJsonValue, ok: o.ok, outcome: o.outcome },
      });
    } catch (err) {
      this.failures++;
      this.i.log.warn(`run ${this.i.runId}: kgraph trace not written: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
}

/** The state after a call: host and path of the last URL a step saw, the view digest, and for an API family the result's shape. */
export function postStateOf(o: ToolCallObservation): PostState {
  const post: PostState = {};
  const last = [...o.steps].reverse().find((s) => s.url || s.contentHash);
  const at = hostAndPath(last?.url ?? null);
  if (at) {
    post.host = at.host;
    post.path = at.path;
  }
  if (last?.contentHash) post.viewDigest = last.contentHash;
  if (o.family === 'accounts' || o.family.startsWith('mcp:')) post.resultShape = resultShapeOf(o.resultText);
  return post;
}
