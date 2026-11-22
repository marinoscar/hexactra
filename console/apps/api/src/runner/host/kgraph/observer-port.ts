// The Knowledge Graph's capture (E46.5, #779): the harness's ObserverPort bound for a run whose effective mode is `learn` or `reuse`. For
// each tool call it writes one `kg_traces` row: each argument's provenance (`bindArguments`, never a value unless a safe literal), the state
// after the call (host and path, the stall detector's view digest, a result shape) and whether it worked. Outside the step transaction and
// best effort: a failed write is logged and counted, and the run goes on exactly as without it. With the mode `off` nothing is bound.
import { randomUUID } from 'node:crypto';

import type { Logger } from '@nestjs/common';
import type { ObserverPort, ToolCallObservation } from '@marinoscar/hexactra-agent';
import { bindArguments, defaultIsSensitive, elementId, hostAndPath, registrableDomain, resultShapeOf, type EarlierResult, type PostState, type TraceParameter } from '@marinoscar/hexactra-kgraph';
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
  prisma: Pick<PrismaService, 'kgTrace'> & Partial<Pick<PrismaService, 'kgNode'>>;
  log: Pick<Logger, 'warn'>;
  userId: string;
  runId: string;
  goal: string;
  /** `runs.inputs`: the parameter values the run was given (sensitive ones are never in it). */
  inputs: unknown;
  /** The page's fingerprint of the element a click or type acted on (E46.13), or null. Never a typed value. */
  capture?(tool: string, args: unknown): Promise<NonNullable<PostState['element']> | null>;
}

/** Tools whose element is fingerprinted for the surface graph. */
export const ELEMENT_TOOLS = new Set(['click', 'type_text', 'click_mark', 'click_at', 'select_option']);

export class KgraphObserver implements ObserverPort {
  private readonly earlier: EarlierResult[] = [];
  private readonly parameters: TraceParameter[];
  /** The last page host a call showed (a step's URL, or the URL a navigate was sent to): the site of a click that reports none. */
  private lastHost: string | null = null;
  failures = 0;

  constructor(private readonly i: KgraphObserverInput) {
    const inputs = readRunInputs(i.inputs);
    this.parameters = Object.entries(inputs?.values ?? {}).map(([key, v]) => ({ key, value: v.value, sensitive: false }));
  }

  /** The owner's surface graph keeps each element once (E46.13): every procedure that references it reads the same, possibly repaired, fingerprint. */
  private async shareElement(host: string, fp: NonNullable<PostState['element']>): Promise<void> {
    try {
      const id = elementId(`site:${registrableDomain(host)}`, fp);
      const prisma = this.i.prisma as unknown as SharedElementStore;
      await prisma.kgNode.upsert({ where: { userId_type_key: { userId: this.i.userId, type: 'Element', key: id } }, create: { id: `kgn-${randomUUID()}`, userId: this.i.userId, type: 'Element', key: id, label: (fp.name ?? fp.role ?? 'element').slice(0, 200), props: { ...fp, site: registrableDomain(host) } as never }, update: {} });
    } catch {
      this.failures++;
    }
  }

  async toolCall(o: ToolCallObservation): Promise<void> {
    const bindings = bindArguments(o.args, { goal: this.i.goal, parameters: this.parameters, earlier: this.earlier, isSensitive: consoleIsSensitive });
    const post = postStateOf(o);
    if (post.host) this.lastHost = post.host;
    else if (o.tool === 'navigate' && o.ok) this.lastHost = hostAndPath(String((o.args as { url?: unknown })?.url ?? ''))?.host ?? this.lastHost;
    if (o.ok && o.outcome === 'ran' && this.i.capture && ELEMENT_TOOLS.has(o.tool)) {
      const fp = await this.i.capture(o.tool, o.args).catch(() => null);
      if (fp) {
        post.element = fp;
        // The element's site: the page's host when the step reported it, else the last one seen (no path: no location check is written).
        if (!post.host && this.lastHost) post.host = this.lastHost;
        if (post.host) await this.shareElement(post.host, fp);
      }
    }
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

export interface SharedElementStore {
  kgNode: Pick<PrismaService['kgNode'], 'upsert'>;
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
