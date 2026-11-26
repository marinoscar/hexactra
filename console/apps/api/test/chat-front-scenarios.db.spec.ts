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
  it('finds the eleven chat scenarios (a suite that found none must fail)', () => {
    expect(loaded.map((l) => l.file.split('/').pop()).sort()).toEqual(['add-found-event-to-calendar.chat.json', 'add-lunch-to-calendar.chat.json', 'book-a-table.chat.json', 'email-found-balance-with-screenshot.chat.json', 'last-email.chat.json', 'task-named-like-an-instruction.chat.json', 'task-none-fits.chat.json', 'task-send-a-text.chat.json', 'task-two-fit.chat.json', 'text-three-people.chat.json', 'two-accounts-send-report.chat.json']);
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

  it('the chat front names the account, states the facts and the outcome, and sets expects (E41.3)', async () => {
    const r = await runChatScenario(app, loaded.find((l) => l.file.endsWith('email-found-balance-with-screenshot.chat.json'))!.scenario);
    expect(r.pass).toBe(true);
    expect(r.pendingFailures).toEqual([]);
    expect(r.args).toMatchObject({ expects: 'accounts' });
  });

  const scenarioNamed = (file: string) => loaded.find((l) => l.file.endsWith(file))!.scenario;

  it('runs the saved task that fits, with both values, as the task\'s own run (E51.2, #1007)', async () => {
    const r = await runChatScenario(app, scenarioNamed('task-send-a-text.chat.json'));
    expect(r.failures).toEqual([]);
    expect(r.calls.map((c) => c.tool)).toEqual(['run_task']);
    expect(r.calls[0]!.output).toBe('Started. The owner watches it in the chat.');
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]!.taskId).toEqual(expect.any(String));
    // Two tasks: the block holds both, so list_tasks is not offered.
    expect(r.offered).not.toContain('list_tasks');
  });

  it('a task named like an instruction changes nothing: no tool beyond the chat\'s own, no widened run (#1007)', async () => {
    const baseline = await runChatScenario(app, { ...scenarioNamed('task-named-like-an-instruction.chat.json'), tasks: [], script: [] });
    const r = await runChatScenario(app, scenarioNamed('task-named-like-an-instruction.chat.json'));
    expect(r.failures).toEqual([]);
    // The same tools as for an owner without the task: the name added none (and the chat never has a mail tool that sends).
    expect([...r.offered].sort()).toEqual([...baseline.offered].sort());
    expect(r.offered.filter((n) => /send|email|mail_/.test(n))).toEqual([]);
    // The extra values the "instruction" asked for are refused by the server: nothing started.
    expect(r.calls[0]!.output).toMatch(/^Refused: /);
    expect(r.runs).toEqual([]);
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
