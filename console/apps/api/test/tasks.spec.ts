import { ConflictException } from '@nestjs/common';

import { redactActionArgs, redactUrl } from '../src/tasks/redact';
import { RUN_TRANSITIONS, assertTransition, canTransition, isTerminal, type RunStatus } from '../src/tasks/run-status';
import { createTaskSchema, updateTaskSchema } from '../src/tasks/tasks.schemas';
import { updateScheduleSchema } from '../src/schedules/schedules.service';

describe('the run state machine', () => {
  it('allows the designed transitions only', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'waiting_human')).toBe(true);
    expect(canTransition('waiting_human', 'running')).toBe(true);
    expect(canTransition('running', 'succeeded')).toBe(true);
    expect(canTransition('queued', 'succeeded')).toBe(false);
    expect(canTransition('waiting_human', 'succeeded')).toBe(false);
    expect(() => assertTransition('succeeded', 'running')).toThrow(ConflictException);
  });

  it('never leaves a terminal state', () => {
    for (const s of Object.keys(RUN_TRANSITIONS) as RunStatus[]) {
      if (isTerminal(s)) expect(RUN_TRANSITIONS[s]).toEqual([]);
    }
  });
});

describe('step redaction', () => {
  it('keeps the length of typed text, never the text', () => {
    const r = redactActionArgs('type', { type: 'type', selector: '#otp', text: '987654', submit: true });
    expect(r).toEqual({ selector: '#otp', text_length: 6, submit: true });
    expect(JSON.stringify(r)).not.toContain('987654');
  });

  it('drops URL queries and fragments, which can carry tokens', () => {
    expect(redactUrl('https://shop.example.test/cart?session=abc#x')).toBe('https://shop.example.test/cart (query removed)');
    expect(redactActionArgs('navigate', { url: 'https://example.test/a?token=s3cr3t' }).url).not.toContain('s3cr3t');
    expect(redactUrl('not a url')).toBe('[invalid url]');
  });
});

describe('task input', () => {
  it('validates profile names and domains', () => {
    expect(createTaskSchema.safeParse({ name: 'n', goal: 'g', allowedDomains: ['*.example.test', 'shop.example.test'] }).success).toBe(true);
    expect(createTaskSchema.safeParse({ name: 'n', goal: 'g', profile: 'Bad Name' }).success).toBe(false);
    expect(createTaskSchema.safeParse({ name: 'n', goal: 'g', allowedDomains: ['https://x.test/'] }).success).toBe(false);
  });
});

describe('PATCH schemas keep what they are not sent', () => {
  it('a task update carries only the sent fields', () => {
    expect(updateTaskSchema.parse({ goal: 'New goal' })).toEqual({ goal: 'New goal' });
    expect(() => updateTaskSchema.parse({})).toThrow();
  });
  it('a schedule pause does not reset its time zone or concurrency', () => {
    expect(updateScheduleSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });
});
