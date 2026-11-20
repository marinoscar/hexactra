// E40.5 (#689): when a run starts with a fresh browser, and what it closes.
import { freshStartDecision, freshStartSummary, profileShared, tabsToClose } from '../src/fresh-start';

describe('freshStartDecision', () => {
  it('restarts for a task run and for the first run of a chat', () => {
    expect(freshStartDecision({ trigger: 'manual', earlierChatRuns: 0, resumed: false })).toEqual({ restart: true });
    expect(freshStartDecision({ trigger: 'schedule', earlierChatRuns: 0, resumed: false })).toEqual({ restart: true });
    expect(freshStartDecision({ trigger: 'chat', earlierChatRuns: 0, resumed: false })).toEqual({ restart: true });
  });
  it('keeps the browser for a chat follow-up, a resumed run and an external agent', () => {
    expect(freshStartDecision({ trigger: 'chat', earlierChatRuns: 2, resumed: false })).toEqual({ restart: false, reason: 'chat_follow_up' });
    expect(freshStartDecision({ trigger: 'manual', earlierChatRuns: 0, resumed: true })).toEqual({ restart: false, reason: 'resumed' });
    expect(freshStartDecision({ trigger: 'external', earlierChatRuns: 0, resumed: false })).toEqual({ restart: false, reason: 'external' });
  });
});

describe('profileShared', () => {
  const own = { id: 's1', hostId: 'h1', profile: 'default' };
  it('is true only for another live session on the same host and profile', () => {
    expect(profileShared([{ id: 's1', host_id: 'h1', profile: 'default', status: 'active' }], own)).toBe(false);
    expect(profileShared([{ id: 's2', host_id: 'h1', status: 'active' }], own)).toBe(true);
    expect(profileShared([{ id: 's2', host_id: 'h1', profile: 'default', status: 'ended' }], own)).toBe(false);
    expect(profileShared([{ id: 's2', host_id: 'h2', profile: 'default', status: 'active' }], own)).toBe(false);
    expect(profileShared([{ id: 's2', host_id: 'h1', profile: 'work', status: 'active' }], own)).toBe(false);
  });
});

describe('tabsToClose and the summary', () => {
  it('closes every tab but the kept one', () => {
    expect(tabsToClose([{ id: 1 }, { id: 7 }, { id: 9 }, {}], 7)).toEqual([1, 9]);
  });
  it('says what happened in words', () => {
    expect(freshStartSummary({ restarted: true, closedTabs: 2 })).toBe('Started with a fresh browser (restarted it and closed 2 old tabs)');
    expect(freshStartSummary({ restarted: true, closedTabs: 0 })).toBe('Started with a fresh browser');
    expect(freshStartSummary({ restarted: false, why: 'shared' })).toMatch(/another session/);
  });
});
