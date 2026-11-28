// Several actions in one reply (E54.1, #1082), the browser toolset's part: the act section changes only when the policy allows more than one
// action per reply, and exactly the tools that leave the page where it is are marked fill.
import { HOW_TO_ACT, browserFamily, howToAct } from '../src/families';
import { browserTools } from '../src/tools';

describe('the act section', () => {
  it('is HOW_TO_ACT word for word with one action per reply', () => {
    expect(howToAct(1)).toBe(HOW_TO_ACT);
    expect(HOW_TO_ACT).toContain('- Check the result of each action before the next one.');
  });

  it('tells the model how to send several actions when the policy allows them', () => {
    const text = howToAct(3);
    expect(text).not.toBe(HOW_TO_ACT);
    expect(text).toContain('send up to 3 actions in one reply');
    expect(text).not.toContain('Check the result of each action before the next one.');
    // Every other line is unchanged.
    expect(text.split('\n').slice(0, -1)).toEqual(HOW_TO_ACT.split('\n').slice(0, -1));
  });

  it('is chosen per run from the policy', () => {
    const ctxWith = (n?: number) => ({ ports: { policy: { policy: n === undefined ? {} : { actionsPerReply: n } } } }) as never;
    expect(browserFamily.sectionsFor!(ctxWith())).toEqual(browserFamily.sections);
    expect(browserFamily.sectionsFor!(ctxWith(4))[1]).toContain('send up to 4 actions');
  });
});

describe('the fill tools', () => {
  it('are exactly the tools that leave the page where it is', () => {
    const all = Object.values(browserTools).flat() as { name: string; batch?: unknown }[];
    expect(all.filter((t) => t.batch !== undefined).map((t) => t.name).sort()).toEqual(['hover_at', 'observe_elements', 'read_text', 'scroll', 'scroll_at', 'tabs', 'type_text']);
  });

  it('counts typing as fill only when it does not submit', () => {
    const type = (Object.values(browserTools).flat() as { name: string; batch?: (a: { submit: boolean }) => boolean }[]).find((t) => t.name === 'type_text')!;
    expect(type.batch!({ submit: false })).toBe(true);
    expect(type.batch!({ submit: true })).toBe(false);
  });
});
