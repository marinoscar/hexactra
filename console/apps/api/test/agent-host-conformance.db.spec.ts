// The host conformance suite of the agent harness (`@marinoscar/hexactra-agent/testing`, E38.9) run against the console's REAL bindings: the Prisma
// run store with its lease (`runs.worker_token`), the job's stop signal over the database flag and the event bus, and the question port over the
// fabric's handoffs and the question broker. Only the fabric is in memory. A binding that stops honouring a port's guarantee fails here.
import { randomUUID } from 'node:crypto';
import { ConflictException, Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { runHarnessHostConformance, type HostedJob, type HostedRun } from '@marinoscar/hexactra-agent/testing';

import { createApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import type { FabricClient } from '../src/fabric/fabric.client';
import { FabricSession } from '../src/runner/fabric-session';
import { RunLease } from '../src/runner/lease';
import { RunStopSignal } from '../src/runner/stop-signal';
import { controlPort } from '../src/runner/host/control-port';
import type { HostDeps } from '../src/runner/host/deps';
import { PrismaRunStore } from '../src/runner/host/prisma-run-store';
import { questionPort } from '../src/runner/host/question-port';
import type { RunMemory } from '../src/runner/host/run-memory';
import { QuestionEvents } from '../src/questions/question-events';
import { QuestionsService } from '../src/questions/questions.service';
import { TasksService } from '../src/tasks/tasks.service';

let app: NestFastifyApplication;
const stamp = `${Date.now()}`;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test/login', payload: { email, role: 'contributor' } });
  const token = new URL(String(res.headers.location)).searchParams.get('token')!;
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  return me.json<{ data: { id: string } }>().data.id;
}

/** The fabric, in memory: it hands out handoff ids and accepts whatever it is told. */
function fakeFabric(): FabricClient {
  return {
    request: async (method: string, path: string) => {
      if (method === 'POST' && path.endsWith('/handoffs')) return { handoff: { id: randomUUID(), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() } };
      return {};
    },
    config: async () => ({ url: 'http://fabric.example.test', token: 't' }),
  } as unknown as FabricClient;
}

let runs = 0;

runHarnessHostConformance({
  name: 'the console bindings (Prisma run store and lease, stop signal, question port)',
  async open(): Promise<HostedRun> {
    const userId = await login(`agent-host-${stamp}-${(runs += 1)}@example.test`);
    const prisma = app.get(PrismaService);
    const tasks = app.get(TasksService);
    const run = await prisma.forUser({ userId }).run.create({ data: { userId, goal: 'Conformance run', status: 'running' } });
    const fabric = fakeFabric();
    // The broker over the in-memory fabric, and a queue that takes no job: answering must not start a worker on this run.
    const questions = new QuestionsService(prisma, fabric, { enqueue: async () => undefined } as never, new QuestionEvents());
    const d: HostDeps = { prisma, tasks, fabric, ai: {} as never, questions, clock: () => Date.now(), log: new Logger('agent-host-conformance') };
    const owned = prisma.forUser({ userId });
    const signals: RunStopSignal[] = [];
    const sessionId = randomUUID();

    /** One job: it claims the run, listens for Stop, and binds the three ports. */
    const bind = async (): Promise<HostedJob> => {
      const lease = await RunLease.claim(prisma, userId, run.id);
      const stop = RunStopSignal.start({
        runId: run.id,
        isRequested: async () => (await owned.run.findFirst({ where: { id: run.id }, select: { cancelRequested: true } }))?.cancelRequested === true,
        isPauseRequested: async () => (await owned.run.findFirst({ where: { id: run.id }, select: { pauseRequested: true } }))?.pauseRequested === true,
        ...(tasks.events ? { subscribe: (h) => tasks.events!.subscribe(h) } : {}),
        pollMs: 200,
      });
      signals.push(stop);
      const session = new FabricSession(fabric);
      const memory: RunMemory = { log: [], chunks: 0 };
      return {
        store: new PrismaRunStore(d, userId, run.id, lease, { run: { id: run.id }, session, sessionId: () => sessionId }),
        control: controlPort(stop, owned, run.id),
        questions: questionPort({ d, userId, runId: run.id, run: {}, session, sessionId: () => sessionId, memory, saveLoginOn: false }),
      };
    };

    const job = await bind();
    return {
      job,
      claimAgain: bind,
      pressStop: async () => {
        await tasks.cancel(userId, run.id);
      },
      answer: async (handoffId) => {
        const q = await prisma.question.findFirst({ where: { runId: run.id, handoffId } });
        if (!q) throw new Error(`the question for handoff ${handoffId} was not mirrored into the broker`);
        try {
          await questions.answer({ id: userId }, q.id, { outcome: 'completed', value: 'Medium' }, { channel: 'inbox' });
          return true;
        } catch (e) {
          // Only a refusal because it was answered already is "not delivered": anything else is a failure of the binding.
          if (e instanceof ConflictException) return false;
          throw e;
        }
      },
      readMemory: async () => {
        const row = await owned.run.findFirst({ where: { id: run.id }, select: { transcript: true } });
        return (row?.transcript as RunMemory | null) ?? null;
      },
      close: async () => {
        for (const s of signals) await s.dispose();
      },
    };
  },
});
