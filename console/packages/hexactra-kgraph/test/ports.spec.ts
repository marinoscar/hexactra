import { effectiveMode, noopTelemetry } from '../src/ports';
import { canTransition, VERSION_STATES } from '../src/schema';

describe('effectiveMode', () => {
  const on = { deployment: true, user: true, task: 'reuse' as const, aiOnlyThisRun: false, savedTask: true };
  it('is the task mode only when every level allows it', () => {
    expect(effectiveMode(on)).toBe('reuse');
    expect(effectiveMode({ ...on, deployment: false })).toBe('off');
    expect(effectiveMode({ ...on, user: false })).toBe('off');
    expect(effectiveMode({ ...on, savedTask: false })).toBe('off');
    expect(effectiveMode({ ...on, task: 'off' })).toBe('off');
    expect(effectiveMode({ ...on, task: 'learn' })).toBe('learn');
  });
  it('"AI only this time" never replays', () => {
    expect(effectiveMode({ ...on, aiOnlyThisRun: true })).toBe('learn');
  });
});

describe('version states', () => {
  it('retired is final and nothing skips verification', () => {
    for (const s of VERSION_STATES) expect(canTransition('retired', s)).toBe(false);
    expect(canTransition('candidate', 'active')).toBe(false);
    expect(canTransition('suspended', 'active')).toBe(true);
  });
});

it('noopTelemetry runs the span body', async () => {
  expect(await noopTelemetry.span('x', {}, async () => 7)).toBe(7);
});
