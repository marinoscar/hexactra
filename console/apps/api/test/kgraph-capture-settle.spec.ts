// #922: the run store flushes the Knowledge Graph's capture queue BEFORE the run finishes (so before the compile job is queued) and
// before it pauses (a paused job ends, and its observer with it). A flush that fails never stops the finish or the pause.
const order: string[] = [];
jest.mock('../src/runner/host/finish-run', () => ({
  finishRun: jest.fn(async () => {
    order.push('finish');
  }),
  pauseRunRaw: jest.fn(async () => {
    order.push('pause');
    return true;
  }),
  saveMemoryRaw: jest.fn(),
}));

import { PrismaRunStore } from '../src/runner/host/prisma-run-store';

function storeWith(beforeSettle?: () => Promise<void>) {
  const d = { prisma: { forUser: () => ({}) } } as never;
  return new PrismaRunStore(d, 'u', 'r1', {} as never, { run: { id: 'r1' }, session: {} as never, sessionId: () => null, ...(beforeSettle ? { beforeSettle } : {}) });
}

beforeEach(() => order.splice(0));

describe('the run store settles the capture (#922)', () => {
  it('flushes before the run finishes', async () => {
    await storeWith(async () => {
      order.push('flush');
    }).finish('succeeded', {});
    expect(order).toEqual(['flush', 'finish']);
  });

  it('flushes before the run pauses', async () => {
    await storeWith(async () => {
      order.push('flush');
    }).pause({});
    expect(order).toEqual(['flush', 'pause']);
  });

  it('a failed flush never stops the finish or the pause; without a capture nothing is flushed', async () => {
    const failing = storeWith(async () => {
      throw new Error('db down');
    });
    await failing.finish('failed', {});
    await failing.pause({});
    await storeWith().finish('succeeded', {});
    expect(order).toEqual(['finish', 'pause', 'finish']);
  });
});
