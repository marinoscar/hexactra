// Tool families (E41.2, #699): the registry's families, the composed instructions (identity, "Your tools", the routing rule, each family's
// sections, the general sections, the notes), determinism, and the first round's hint.
import { z } from 'zod';

import { buildRoundText, composeInstructions, defineRunnerTool, FIRST_ROUND_HINT, ROUTING_RULE, ToolRegistry, toolFamilyOf, type HarnessMemory, type RunContext, type ToolFamily } from '../src';
import { fakeRun } from '../src/testing';

type Ctx = RunContext<HarnessMemory, Record<string, never>>;
const tool = (name: string, family: string, extra: object = {}) => defineRunnerTool({ name, group: 'test', family, description: '', parameters: z.object({}), execute: () => name, ...extra }) as never;
const fam = (id: string, rank: number, sections?: string[]): ToolFamily<Ctx> => ({ id, title: `T-${id}`, whenToUse: `use ${id}`, rank, ...(sections ? { sections } : {}) });

describe('the registry\'s families', () => {
  it('lists the families with a tool offered, by rank then registration order, and refuses a duplicate', () => {
    const { ctx } = fakeRun();
    const r = new ToolRegistry<Ctx>()
      .registerAll([tool('nav', 'browser'), tool('mail', 'accounts'), tool('hidden', 'desktop', { available: () => false }), tool('done', 'control')])
      .registerFamilies([fam('browser', 50), fam('desktop', 60), fam('notes', 20), fam('accounts', 10), fam('other', 50)]);
    expect(r.families(ctx as Ctx).map((f) => f.id)).toEqual(['accounts', 'browser']);
    expect(() => r.registerFamily(fam('browser', 1))).toThrow(/twice/);
  });

  it('keeps registration order between families of equal rank', () => {
    const { ctx } = fakeRun();
    const r = new ToolRegistry<Ctx>().registerAll([tool('a', 'x'), tool('b', 'y')]).registerFamilies([fam('y', 20), fam('x', 20)]);
    expect(r.families(ctx as Ctx).map((f) => f.id)).toEqual(['y', 'x']);
  });

  it('toolFamilyOf reads `family` first', () => {
    expect(toolFamilyOf({ group: 'connection', family: 'accounts' })).toBe('accounts');
  });
});

describe('composeInstructions', () => {
  const families = [fam('accounts', 10, ['Accounts how-to']), fam('browser', 50, ['How to see', 'How to act'])];

  it('orders identity, "Your tools", the routing rule, the families\' sections, the general sections, then the notes', () => {
    const text = composeInstructions({ identity: 'I am.', families, sections: ['Person', 'Done'], usageNotes: ['n1'] });
    expect(text).toBe(['I am.', 'Your tools:\n- T-accounts: use accounts\n- T-browser: use browser', ROUTING_RULE, 'Accounts how-to', 'How to see', 'How to act', 'Person', 'Done', 'Tool notes:\n- n1'].join('\n\n'));
  });

  it('omits a family that has no tool offered (the registry decides) and its sections', () => {
    const { ctx } = fakeRun();
    const r = new ToolRegistry<Ctx>().registerAll([tool('mail', 'accounts')]).registerFamilies(families);
    const text = composeInstructions({ identity: 'I am.', families: r.families(ctx as Ctx), sections: [] });
    expect(text).toContain('T-accounts');
    expect(text).not.toContain('T-browser');
    expect(text).not.toContain('How to see');
  });

  it('is deterministic', () => {
    const a = composeInstructions({ identity: 'I', families, sections: ['S'], usageNotes: ['n'] });
    const b = composeInstructions({ identity: 'I', families: [...families], sections: ['S'], usageNotes: ['n'] });
    expect(a).toBe(b);
  });

  it('has the routing rule word for word', () => {
    expect(ROUTING_RULE.split('\n')[0]).toBe('How to choose a tool:');
    expect(ROUTING_RULE).toContain('Do not open a website to do what a tool does: it is slower and can fail.');
  });
});

describe('the first round\'s hint', () => {
  const base = { goal: 'g', aboutOwner: '', contextLines: [], log: [], logLines: 5, warnings: [] };
  it('is family-neutral when the profile gives one, and the old sentence when it does not', () => {
    expect(buildRoundText({ ...base, firstRoundHint: FIRST_ROUND_HINT })).toContain('Nothing has been done yet. Choose the tool that fits the goal.');
    expect(buildRoundText(base)).toContain('Nothing has been done yet. Start by navigating or observing the page.');
  });
});
