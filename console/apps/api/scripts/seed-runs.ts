// `npm run seed:runs --workspace=api -- --user <email> --count 5000` (#420).
// Development only: fills one user's account with finished runs, so the runs
// list, delete by filter and retention have thousands of rows to work on.
// It creates five tasks named "Seed task N" (reused on the next call) and
// `count` terminal runs across them (some with no task), spread over 120 days,
// each with 3 to 10 steps, a cost, a stop reason and an agent policy.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { buildDatabaseUrl } from '@marinoscar/platform-api/core';

import { builtinPolicy } from '../src/policies/builtin-policies';

const DAYS = 120;
const BATCH = 500;
const TASKS = ['Check fares', 'Sweep the inbox', 'Renew the permit', 'Compare prices', 'Book a table'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A small seeded generator (mulberry32): the same arguments give the same runs. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Outcome = { status: 'succeeded' | 'failed' | 'cancelled'; stopReason: Prisma.RunCreateManyInput['stopReason']; weight: number };
const OUTCOMES: Outcome[] = [
  { status: 'succeeded', stopReason: 'finished', weight: 68 },
  { status: 'failed', stopReason: 'error', weight: 9 },
  { status: 'failed', stopReason: 'stalled', weight: 5 },
  { status: 'failed', stopReason: 'budget_cost', weight: 3 },
  { status: 'failed', stopReason: 'budget_actions', weight: 3 },
  { status: 'failed', stopReason: 'budget_active_time', weight: 2 },
  { status: 'failed', stopReason: 'no_model', weight: 1 },
  { status: 'cancelled', stopReason: 'cancelled', weight: 9 },
];
const POLICIES = [
  { ref: 'builtin:balanced', weight: 80 },
  { ref: 'builtin:economy', weight: 12 },
  { ref: 'builtin:thorough', weight: 8 },
];
const TRIGGERS = [
  { trigger: 'schedule' as const, weight: 60 },
  { trigger: 'manual' as const, weight: 25 },
  { trigger: 'api' as const, weight: 8 },
  { trigger: 'mcp' as const, weight: 7 },
];
const ACTIONS = ['navigate', 'click', 'type', 'scroll', 'screenshot'];

function pick<T extends { weight: number }>(rand: () => number, options: T[]): T {
  let n = rand() * options.reduce((sum, o) => sum + o.weight, 0);
  for (const o of options) if ((n -= o.weight) < 0) return o;
  return options[options.length - 1]!;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('seed:runs is a development tool: it refuses to run with NODE_ENV=production.');
  const email = arg('user');
  const count = Number(arg('count') ?? 5000);
  if (!email || !Number.isInteger(count) || count < 1 || count > 100_000) throw new Error('Usage: npm run seed:runs --workspace=api -- --user <email> [--count 5000]   (count: 1 to 100000)');

  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL ?? buildDatabaseUrl(process.env)) });
  try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) throw new Error(`No user with the email ${email}: sign in once first.`);

    const tasks: string[] = [];
    for (const [n, goal] of TASKS.entries()) {
      const name = `Seed task ${n + 1}`;
      const found = await prisma.task.findFirst({ where: { userId: user.id, name }, select: { id: true } });
      tasks.push((found ?? (await prisma.task.create({ data: { userId: user.id, name, goal: `${goal} on shop.example.test`, policyRef: 'builtin:balanced' }, select: { id: true } }))).id);
    }

    const rand = random(count);
    const now = Date.now();
    const started = Date.now();
    let steps = 0;
    for (let done = 0; done < count; done += BATCH) {
      const runs: Prisma.RunCreateManyInput[] = [];
      const runSteps: Prisma.RunStepCreateManyInput[] = [];
      for (let n = done; n < Math.min(count, done + BATCH); n++) {
        const id = randomUUID();
        const outcome = pick(rand, OUTCOMES);
        const policy = pick(rand, POLICIES);
        const spec = builtinPolicy(policy.ref)!;
        // One run in ten has no task (an ad-hoc run).
        const task = rand() < 0.1 ? null : Math.floor(rand() * tasks.length);
        const createdAt = new Date(now - Math.floor(rand() * DAYS * 86_400_000));
        const stepCount = 3 + Math.floor(rand() * 8);
        const activeMs = stepCount * (4000 + Math.floor(rand() * 9000));
        const startedAt = new Date(createdAt.getTime() + 500 + Math.floor(rand() * 4000));
        const finishedAt = new Date(startedAt.getTime() + activeMs);
        const modelCalls = outcome.stopReason === 'no_model' ? 0 : stepCount + Math.floor(rand() * 3);
        const inputTokens = modelCalls * (2500 + Math.floor(rand() * 6000));
        const outputTokens = modelCalls * (120 + Math.floor(rand() * 400));
        const costKnown = rand() > 0.03;
        const costUsd = outcome.stopReason === 'budget_cost' ? 2 + rand() : (inputTokens * 3 + outputTokens * 15) / 1_000_000;
        const goal = `${task === null ? 'Look up the opening hours' : TASKS[task]} on shop.example.test (#${n + 1})`;
        runs.push({
          id,
          userId: user.id,
          taskId: task === null ? null : tasks[task]!,
          status: outcome.status,
          trigger: task === null ? 'manual' : pick(rand, TRIGGERS).trigger,
          goal,
          result: outcome.status === 'succeeded' ? `Done: ${goal}` : null,
          error: outcome.status === 'succeeded' ? null : outcome.status === 'cancelled' ? 'Cancelled by the user' : outcome.stopReason === 'stalled' ? 'The agent stalled: the same click repeated 3 times' : `Stopped: ${String(outcome.stopReason)}`,
          stepCount,
          inputTokens,
          outputTokens,
          modelCalls,
          costUsd: new Prisma.Decimal(costUsd.toFixed(6)),
          costKnown,
          activeMs,
          createdAt,
          startedAt,
          finishedAt,
          stopReason: outcome.stopReason,
          policyRef: policy.ref,
          policyVersion: 1,
          policySource: task === null ? 'user_default' : 'task',
          policySnapshot: {
            schemaVersion: 1,
            ref: policy.ref,
            name: spec.name,
            version: 1,
            builtin: true,
            source: task === null ? 'user_default' : 'task',
            spec: spec.spec,
            tiers: null,
            takenAt: startedAt.toISOString(),
          } as unknown as Prisma.InputJsonValue,
          currentTier: rand() < 0.15 ? 'frontier' : 'standard',
        });
        for (let seq = 1; seq <= stepCount; seq++) {
          const last = seq === stepCount;
          const action = ACTIONS[Math.floor(rand() * ACTIONS.length)]!;
          runSteps.push({
            runId: id,
            seq,
            kind: last ? (outcome.status === 'succeeded' ? 'finish' : 'error') : 'action',
            action: last ? null : action,
            args: last ? Prisma.JsonNull : action === 'navigate' ? { url: 'https://shop.example.test/' } : { selector: `#item-${seq}` },
            ok: !(last && outcome.status === 'failed'),
            summary: last ? (outcome.status === 'succeeded' ? 'Finished' : `Stopped: ${String(outcome.stopReason)}`) : `${action} ok`,
            durationMs: 300 + Math.floor(rand() * 2500),
            createdAt: new Date(startedAt.getTime() + Math.floor((activeMs * seq) / stepCount)),
          });
        }
      }
      await prisma.run.createMany({ data: runs });
      await prisma.runStep.createMany({ data: runSteps });
      steps += runSteps.length;
    }
    console.log(`Seeded ${count} runs and ${steps} steps for ${email} across ${tasks.length} tasks in ${Date.now() - started} ms.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
