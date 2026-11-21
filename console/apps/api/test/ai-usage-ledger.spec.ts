// The verdict of the `ai.usage_ledger` Doctor check (#731), pure.
import { ledgerVerdict, type LedgerStats } from '../src/platform/ai/ai-usage-ledger.doctor-check';

const stats = (over: Partial<LedgerStats>): LedgerStats => ({
  runInputTokens: 0,
  responseRows: 0,
  responseRowsWithoutTokens: 0,
  ledgerAgentInputTokens: 0,
  catalogRows: 0,
  ...over,
});

describe('ledgerVerdict', () => {
  it('fails when runs used tokens but the ledger recorded none (the #731 case: only catalogue rows)', () => {
    const v = ledgerVerdict(stats({ runInputTokens: 50_000, catalogRows: 8 }));
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('Could not record AI usage');
  });

  it('fails when the ledger holds under half of what the runs counted', () => {
    expect(ledgerVerdict(stats({ runInputTokens: 10_000, responseRows: 3, ledgerAgentInputTokens: 4_000 })).status).toBe('fail');
  });

  it('warns when every recorded model call has no token counts', () => {
    expect(ledgerVerdict(stats({ responseRows: 4, responseRowsWithoutTokens: 4 })).status).toBe('warn');
  });

  it('skips when there were no model calls', () => {
    expect(ledgerVerdict(stats({ catalogRows: 2 })).status).toBe('skip');
  });

  it('passes when the ledger matches the runs (chat and other features may add more)', () => {
    const v = ledgerVerdict(stats({ runInputTokens: 10_000, responseRows: 12, ledgerAgentInputTokens: 10_000 }));
    expect(v.status).toBe('pass');
    expect(v.detail).toContain('100%');
  });
});
