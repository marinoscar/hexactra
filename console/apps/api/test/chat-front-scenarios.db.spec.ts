// The chat-front scenarios (E41.1, #698) in scripted mode, against the real database: each `test/scenarios/chat/*.chat.json` is one turn of
// the real `ChatTurnService` over a conversation, and what the model called is checked. The pending expectations are reported, not failed.
import { join } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createApp } from '../src/main';
import { evaluateChat, loadChatScenarios, runChatScenario } from './replay/chat-front';

const DIR = join(__dirname, 'scenarios/chat');
const loaded = loadChatScenarios(DIR);

let app: NestFastifyApplication;
const workerMode = process.env.JOBS_WORKER_MODE;
beforeAll(async () => {
  process.env.JOBS_WORKER_MODE = 'off';
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  if (workerMode === undefined) delete process.env.JOBS_WORKER_MODE;
  else process.env.JOBS_WORKER_MODE = workerMode;
});
afterAll(async () => {
  await app?.close();
});

describe('the chat-front scenarios', () => {
  it('finds the five chat scenarios (a suite that found none must fail)', () => {
    expect(loaded.map((l) => l.file.split('/').pop()).sort()).toEqual(['add-lunch-to-calendar.chat.json', 'book-a-table.chat.json', 'email-found-balance-with-screenshot.chat.json', 'last-email.chat.json', 'two-accounts-send-report.chat.json']);
  });

  it.each(loaded.map((l) => [l.scenario.name, l.scenario] as const))('%s passes scripted', async (_name, scenario) => {
    const r = await runChatScenario(app, scenario);
    if (r.pendingFailures.length) process.stdout.write(`PENDING ${scenario.name}:\n${r.pendingFailures.map((f) => `  - ${f}`).join('\n')}\n`);
    expect(r.failures).toEqual([]);
  });

  it('the read tool answered from the fake mailbox, with no run', async () => {
    const r = await runChatScenario(app, loaded.find((l) => l.file.endsWith('last-email.chat.json'))!.scenario);
    expect(r.calls.map((c) => c.tool)).toEqual(['mail_search']);
  });

  it('a pending expectation fires today and is only reported', async () => {
    const r = await runChatScenario(app, loaded.find((l) => l.file.endsWith('email-found-balance-with-screenshot.chat.json'))!.scenario);
    expect(r.pass).toBe(true);
    expect(r.pendingFailures).toEqual(expect.arrayContaining([expect.stringMatching(/^\[pending E41\.3\] goalMustNotInclude: the goal matches/)]));
  });

  it('names what differs', () => {
    expect(evaluateChat({ tool: 'start_run', args: { goal: 'Open shop.example.test' } }, { tool: 'ask_user', goalIncludes: ['Personal'], goalMustNotInclude: ['open'] })).toEqual([
      'tool: expected ask_user, the model called start_run',
      'goalIncludes: the goal does not contain "Personal" (goal: Open shop.example.test)',
      'goalMustNotInclude: the goal matches /open/i (goal: Open shop.example.test)',
    ]);
    expect(evaluateChat({ tool: 'none', args: null }, { tool: 'read' })).toEqual(['tool: expected read, the model called none']);
  });
});
