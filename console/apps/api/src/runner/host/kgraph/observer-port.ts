// The Knowledge Graph's capture (E46.5, #779): the harness's ObserverPort bound for a run whose effective mode is `learn` or `reuse`. For
// each tool call it writes one `kg_traces` row: each argument's provenance (`bindArguments`, never a value unless a safe literal), the state
// after the call (host and path, the stall detector's view digest, a result shape) and whether it worked. Outside the step transaction and
// best effort: a failed write is logged and counted, and the run goes on exactly as without it. With the mode `off` nothing is bound.
// E46.36: an everyday run (a chat or one-off run with `kgraph.everyday` on) binds the same observer with `surfaceOnly`: it records the
// surface graph exactly as a learn run does (the shared Element nodes, masked labels) and, per call, one `RunSurface` node (the tool, the
// page's host and path, the element's fingerprint) for the site-fact derive step. It writes no trace row, so nothing is ever compiled.
// #922: the database writes are off the run's critical path. `toolCall` does its in-memory work at once and queues its writes on a serial,
// bounded queue; the run store calls `flush()` before the run finishes or pauses (so before the compile job is queued). Only the element
// fingerprint stays live: it reads the page, which is gone afterwards. A learn or reuse run whose capture lost a write is never compiled.
import { randomUUID } from 'node:crypto';

import type { Logger } from '@nestjs/common';
import type { ObserverPort, ToolCallObservation } from '@marinoscar/hexactra-agent';
import { bindArguments, defaultIsSensitive, elementId, hostAndPath, registrableDomain, resultShapeOf, type EarlierResult, type PostState, type TraceParameter } from '@marinoscar/hexactra-kgraph';
import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../../prisma/prisma.service';
import { maskSensitive } from '../../../tasks/mask';
import { abortableSleep, isConsentChoice } from '@marinoscar/hexactra-browser-agent/surface';
import { signInRecipe, type SiteMemory } from './interrupts';
import { readRunInputs } from '../../../tasks/task-params.schemas';

/** The kg_nodes type of one call's surface in an everyday run (E46.36): key `<runId>:<seq>`, removed once the derive step read it. */
export const RUN_SURFACE_NODE = 'RunSurface';

/** What a `RunSurface` node holds: names, a host and path, and a masked fingerprint. Never an argument value or page text. */
export interface RunSurfaceProps {
  tool?: string;
  family?: string;
  host?: string;
  path?: string;
  element?: PostState['element'];
}

/** Earlier results kept in memory for provenance (never stored): the newest 30, each clipped. */
const EARLIER_KEPT = 30;
const EARLIER_CHARS = 20_000;

/** The console's sensitive check: its pattern table (the one the trace masking uses) or the package's default. */
export const consoleIsSensitive = (value: string): boolean => maskSensitive(value).text !== value || defaultIsSensitive(value);

export interface KgraphObserverInput {
  prisma: Pick<PrismaService, 'kgTrace'> & Partial<Pick<PrismaService, 'kgNode'>>;
  /** `log` (when present) gets the per-run capture summary of `flush()`; `warn` gets failures. */
  log: Pick<Logger, 'warn'> & Partial<Pick<Logger, 'log'>>;
  userId: string;
  runId: string;
  goal: string;
  /** `runs.inputs`: the parameter values the run was given (sensitive ones are never in it). */
  inputs: unknown;
  /** The page's fingerprint of the element a click or type acted on (E46.13), or null. Never a typed value. */
  capture?(tool: string, args: unknown): Promise<NonNullable<PostState['element']> | null>;
  /** An everyday run (E46.36): only the surface is recorded (shared elements and one `RunSurface` node per call); no trace row, no site memory. */
  surfaceOnly?: boolean;
}

/** At most this many writes wait in a run's queue; beyond it a write is dropped and counted (#922). */
export const CAPTURE_QUEUE_LIMIT = 1000;

/** How long `flush()` waits for the queue before it gives up: the run's finish is never held longer; the late writes count as lost (#922). */
export const CAPTURE_FLUSH_TIMEOUT_MS = 30_000;

/** The `CompileRejection` label of a run whose capture lost a write: its trace has a gap, so it is never compiled (#922). */
export const CAPTURE_INCOMPLETE = 'capture incomplete';

/** Tools whose element is fingerprinted for the surface graph. */
export const ELEMENT_TOOLS = new Set(['click', 'type_text', 'click_mark', 'click_at', 'select_option']);

export class KgraphObserver implements ObserverPort {
  private readonly earlier: EarlierResult[] = [];
  private readonly parameters: TraceParameter[];
  /** The last page host a call showed (a step's URL, or the URL a navigate was sent to): the site of a click that reports none. */
  private lastHost: string | null = null;
  /** The element fingerprinted just before the call (the page as the model saw it). */
  private pending: { tool: string; fp: NonNullable<PostState['element']> | null } | null = null;
  failures = 0;
  /** The serial write queue (#922): its tail, how many writes wait, and what the flush reports. */
  private tail: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private written = 0;
  private writeMs = 0;
  private flushed = false;

  constructor(private readonly i: KgraphObserverInput) {
    const inputs = readRunInputs(i.inputs);
    this.parameters = Object.entries(inputs?.values ?? {}).map(([key, v]) => ({ key, value: v.value, sensitive: false }));
  }

  /** Queues one write after the earlier ones; the call that queued it does not wait (#922). Over the bound, the write is dropped and counted. */
  private enqueue(write: () => Promise<void>): void {
    if (this.pendingWrites >= CAPTURE_QUEUE_LIMIT) {
      this.failures++;
      return;
    }
    this.pendingWrites++;
    this.tail = this.tail.then(async () => {
      const started = Date.now();
      try {
        await write();
        this.written++;
      } catch {
        this.failures++;
      } finally {
        this.writeMs += Date.now() - started;
        this.pendingWrites--;
      }
    });
  }

  /**
   * Waits for every queued write (#922), then reports the run's capture in one log line. A learn or reuse run that lost a write gets a
   * `CompileRejection` (`capture incomplete`), which the compile job treats as done: a trace with a gap never becomes a procedure. Never throws.
   * Called again (a pause, then the finish of a resumed job's observer) it waits for what was queued since and reports once more.
   */
  async flush(timeoutMs = CAPTURE_FLUSH_TIMEOUT_MS): Promise<void> {
    // The deadline is the replay code's one sanctioned wait (pacing.ts), cancelled as soon as the queue drains.
    const deadline = new AbortController();
    const drained = await Promise.race([this.tail.then(() => true, () => true), abortableSleep(timeoutMs, deadline.signal).then(() => false)]);
    deadline.abort();
    if (!drained) this.failures += Math.max(1, this.pendingWrites);
    const summary = `run ${this.i.runId}: kgraph capture: ${this.written} writes, ${this.failures} failed, ${this.writeMs} ms writing off the run's path`;
    if (this.failures > 0 || !this.i.log.log) this.i.log.warn(summary);
    else if (this.written > 0) this.i.log.log(summary);
    if (this.failures === 0 || this.i.surfaceOnly || this.flushed) return;
    this.flushed = true;
    try {
      const prisma = this.i.prisma as unknown as { kgNode: Pick<PrismaService['kgNode'], 'upsert'> };
      await prisma.kgNode.upsert({ where: { userId_type_key: { userId: this.i.userId, type: 'CompileRejection', key: this.i.runId } }, create: { id: `kgr-${randomUUID()}`, userId: this.i.userId, type: 'CompileRejection', key: this.i.runId, label: CAPTURE_INCOMPLETE, props: { failures: this.failures } as never }, update: {} });
    } catch (err) {
      this.i.log.warn(`run ${this.i.runId}: kgraph capture-incomplete mark not written: ${err instanceof Error ? err.name : 'error'}`);
    }
  }

  /** The owner's surface graph keeps each element once (E46.13): every procedure that references it reads the same, possibly repaired, fingerprint. */
  private async shareElement(host: string, fp: NonNullable<PostState['element']>): Promise<void> {
    try {
      const id = elementId(`site:${registrableDomain(host)}`, fp);
      const prisma = this.i.prisma as unknown as SharedElementStore;
      await prisma.kgNode.upsert({ where: { userId_type_key: { userId: this.i.userId, type: 'Element', key: id } }, create: { id: `kgn-${randomUUID()}`, userId: this.i.userId, type: 'Element', key: id, label: (fp.name ?? fp.role ?? 'element').slice(0, 200), props: { ...fp, site: registrableDomain(host) } as never }, update: {} });
    } catch (err) {
      this.i.log.warn(`run ${this.i.runId}: kgraph element not written: ${err instanceof Error ? err.name : 'error'}`);
      throw err;
    }
  }

  /** What the owner's runs taught about a site, kept on its `Site` node (merged). */
  private async rememberSite(host: string, add: SiteMemory): Promise<void> {
    try {
      const prisma = this.i.prisma as unknown as { kgNode: PrismaService['kgNode'] };
      const key = registrableDomain(host);
      const existing = await prisma.kgNode.findFirst({ where: { userId: this.i.userId, type: 'Site', key } });
      const props = { ...((existing?.props as object | null) ?? {}), ...add };
      if (existing) await prisma.kgNode.update({ where: { id: existing.id }, data: { props: props as never } });
      else await prisma.kgNode.create({ data: { id: `kgn-${randomUUID()}`, userId: this.i.userId, type: 'Site', key, label: key, props: props as never } });
    } catch (err) {
      this.i.log.warn(`run ${this.i.runId}: kgraph site memory not written: ${err instanceof Error ? err.name : 'error'}`);
      throw err;
    }
  }

  async beforeToolCall(c: { tool: string; args: unknown }): Promise<void> {
    this.pending = null;
    if (!this.i.capture || !ELEMENT_TOOLS.has(c.tool)) return;
    this.pending = { tool: c.tool, fp: await this.i.capture(c.tool, c.args).catch(() => null) };
  }

  async toolCall(o: ToolCallObservation): Promise<void> {
    if (this.i.surfaceOnly) return this.surfaceCall(o);
    const bindings = bindArguments(o.args, { goal: this.i.goal, parameters: this.parameters, earlier: this.earlier, isSensitive: consoleIsSensitive });
    const post = postStateOf(o);
    if (post.host) this.lastHost = post.host;
    else if (o.tool === 'navigate' && o.ok) this.lastHost = hostAndPath(String((o.args as { url?: unknown })?.url ?? ''))?.host ?? this.lastHost;
    if (o.ok && o.outcome === 'ran' && this.i.capture && ELEMENT_TOOLS.has(o.tool)) {
      const fp = this.pending?.tool === o.tool && this.pending.fp ? this.pending.fp : await this.i.capture(o.tool, o.args).catch(() => null);
      if (fp) {
        post.element = fp;
        // The element's site: the page's host when the step reported it, else the last one seen (no path: no location check is written).
        if (!post.host && this.lastHost) post.host = this.lastHost;
        const host = post.host;
        if (host) this.enqueue(() => this.shareElement(host, fp));
        // The owner's own cookie choice on this site (E46.15): repeated when a banner interrupts a replay.
        if (host && o.tool !== 'type_text' && isConsentChoice(fp)) this.enqueue(() => this.rememberSite(host, { consent: fp }));
      }
    }
    // How the owner's run signed in (E46.15): a saved-login reference and selectors, never a secret.
    if (o.ok && o.outcome === 'ran' && o.tool === 'sign_in_with_saved_login' && this.lastHost) {
      const recipe = signInRecipe(o.args);
      const host = this.lastHost;
      if (recipe) this.enqueue(() => this.rememberSite(host, { signIn: recipe }));
    }
    this.earlier.push({ seq: o.seq, text: o.resultText.slice(0, EARLIER_CHARS) });
    if (this.earlier.length > EARLIER_KEPT) this.earlier.shift();
    const data = { userId: this.i.userId, runId: this.i.runId, seq: o.seq, tool: o.tool.slice(0, 64), family: o.family.slice(0, 200), commits: o.commits, bindings: bindings as unknown as Prisma.InputJsonValue, post: post as Prisma.InputJsonValue, ok: o.ok, outcome: o.outcome };
    this.enqueue(async () => {
      try {
        await this.i.prisma.kgTrace.create({ data });
      } catch (err) {
        this.i.log.warn(`run ${this.i.runId}: kgraph trace not written: ${err instanceof Error ? err.name : 'error'}`);
        throw err;
      }
    });
  }

  /** The everyday observer's call (E46.36): the element is fingerprinted and shared as in a learn run; the call's surface is kept for derive. */
  private async surfaceCall(o: ToolCallObservation): Promise<void> {
    const post = postStateOf(o);
    if (post.host) this.lastHost = post.host;
    else if (o.tool === 'navigate' && o.ok) this.lastHost = hostAndPath(String((o.args as { url?: unknown })?.url ?? ''))?.host ?? this.lastHost;
    if (o.ok && o.outcome === 'ran' && this.i.capture && ELEMENT_TOOLS.has(o.tool)) {
      const fp = this.pending?.tool === o.tool && this.pending.fp ? this.pending.fp : await this.i.capture(o.tool, o.args).catch(() => null);
      if (fp) {
        post.element = fp;
        if (!post.host && this.lastHost) post.host = this.lastHost;
        const at = post.host;
        if (at) this.enqueue(() => this.shareElement(at, fp));
      }
    }
    const host = post.host ?? this.lastHost;
    if (!host) return;
    const props: RunSurfaceProps = { tool: o.tool.slice(0, 64), family: o.family.slice(0, 200), host, ...(post.path ? { path: post.path } : {}), ...(post.element ? { element: post.element } : {}) };
    const key = `${this.i.runId}:${o.seq}`;
    this.enqueue(async () => {
      try {
        const prisma = this.i.prisma as unknown as { kgNode: PrismaService['kgNode'] };
        await prisma.kgNode.upsert({ where: { userId_type_key: { userId: this.i.userId, type: RUN_SURFACE_NODE, key } }, create: { id: `kgn-${randomUUID()}`, userId: this.i.userId, type: RUN_SURFACE_NODE, key, label: props.tool!, props: props as never }, update: { props: props as never } });
      } catch (err) {
        this.i.log.warn(`run ${this.i.runId}: kgraph surface not written: ${err instanceof Error ? err.name : 'error'}`);
        throw err;
      }
    });
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
