import {
  ConflictException,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Res,
  Sse,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
  type MessageEvent,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import type { FastifyReply } from 'fastify';
import { Observable } from 'rxjs';

import { FabricClient, FabricError, type FabricHost } from '../fabric/fabric.client';
import { PrismaService } from '../prisma/prisma.service';
import { FabricSession } from './fabric-session';

const POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * 404 for a run that is not the caller's, BEFORE a stream's headers go out
 * (Nest's SSE writes them before the handler runs). Placed above `@Auth`, so
 * it runs after authentication.
 */
@Injectable()
export class RunOwnerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user?: { id: string }; params: { id?: string } }>();
    if (!req.user || !req.params.id) return true;
    const found = await this.prisma.forUser({ userId: req.user.id }).run.count({ where: { id: req.params.id } });
    if (!found) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    return true;
  }
}

/**
 * The live view of a run: an event stream of its status and new steps, a
 * fresh screenshot of its browser, and where a person can take over.
 */
@ApiTags('Runs')
@Controller('runs')
export class RunLiveController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fabric: FabricClient,
  ) {}

  private async ownRun(userId: string, id: string) {
    const run = await this.prisma.forUser({ userId }).run.findFirst({
      where: { id },
      select: { id: true, status: true, sessionId: true, hostId: true, stepCount: true, result: true, error: true, handoffId: true, cancelRequested: true },
    });
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    return run;
  }

  /**
   * `run` events (status changes) and `step` events (each new step), then
   * the stream ends once the run is final. Reconnecting replays the current
   * state and every step, so a client simply renders what arrives.
   */
  @Sse(':id/stream')
  @UseGuards(RunOwnerGuard)
  @Auth({ permissions: ['runs:read'] })
  stream(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((observer) => {
      let lastSeq = 0;
      let lastState = '';
      let closed = false;
      let sinceBeat = 0;
      const tick = async () => {
        if (closed) return;
        try {
          const run = await this.ownRun(userId, id);
          const steps = await this.prisma.runStep.findMany({ where: { runId: id, seq: { gt: lastSeq } }, orderBy: { seq: 'asc' }, take: 200 });
          for (const s of steps) {
            observer.next({ type: 'step', id: `step-${s.seq}`, data: s });
            lastSeq = s.seq;
          }
          const state = JSON.stringify([run.status, run.stepCount, run.result, run.error, run.handoffId, run.cancelRequested]);
          if (state !== lastState) {
            observer.next({ type: 'run', data: run });
            lastState = state;
            sinceBeat = 0;
          } else if ((sinceBeat += POLL_MS) >= HEARTBEAT_MS) {
            observer.next({ type: 'heartbeat', data: {} });
            sinceBeat = 0;
          }
          if (TERMINAL.has(run.status)) {
            observer.complete();
            return;
          }
        } catch (e) {
          observer.error(e);
          return;
        }
        timer = setTimeout(() => void tick(), POLL_MS);
      };
      let timer: NodeJS.Timeout | undefined = setTimeout(() => void tick(), 0);
      return () => {
        closed = true;
        if (timer) clearTimeout(timer);
      };
    });
  }

  /** A fresh JPEG of the run's browser (live runs only). Never stored. */
  @Get(':id/screenshot')
  @Auth({ permissions: ['runs:read'] })
  async screenshot(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string, @Res() reply: FastifyReply): Promise<void> {
    const run = await this.ownRun(userId, id);
    if (!run.sessionId || TERMINAL.has(run.status)) {
      throw new ConflictException({ code: 'RUN_NOT_LIVE', message: 'The run has no live browser' });
    }
    try {
      const op = await new FabricSession(this.fabric).act(run.sessionId, { type: 'screenshot' }, 20_000);
      const artifactId = op.result?.artifact_id;
      if (op.state !== 'succeeded' || typeof artifactId !== 'string') {
        throw new ConflictException({ code: 'SCREENSHOT_FAILED', message: op.error ?? `The screenshot ${op.state}` });
      }
      const res = await this.fabric.raw('GET', `/v1/artifacts/${artifactId}`, { retries: 0 });
      const bytes = Buffer.from(await res.arrayBuffer());
      await reply.header('cache-control', 'no-store').type(res.headers.get('content-type') ?? 'image/jpeg').send(bytes);
    } catch (e) {
      if (e instanceof FabricError) throw new ConflictException({ code: 'SCREENSHOT_FAILED', message: e.message });
      throw e;
    }
  }

  /** Where a person can see and use the run's browser (to take over). */
  @Get(':id/viewer')
  @Auth({ permissions: ['runs:read'] })
  async viewer(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<{ hostName: string | null; viewerUrl: string | null; local: boolean }> {
    const run = await this.ownRun(userId, id);
    let hostId = run.hostId;
    if (!hostId && run.sessionId) {
      hostId = await this.fabric
        .request<{ host_id: string }>('GET', `/v1/sessions/${run.sessionId}`)
        .then((s) => s.host_id)
        .catch(() => null);
    }
    if (!hostId) return { hostName: null, viewerUrl: null, local: false };
    const host = (await this.fabric.hosts().catch(() => [] as FabricHost[])).find((h) => h.id === hostId);
    const viewerUrl = host?.viewer_url ?? null;
    return { hostName: host?.name ?? null, viewerUrl, local: Boolean(viewerUrl?.includes('/viewer/local/')) };
  }
}
