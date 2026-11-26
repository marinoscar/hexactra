// The instructions of a run (E41.2, #699): a neutral identity, the families offered with the routing rule, the browser's how-to only when the
// browser is offered, the general sections unchanged.
import { ROUTING_RULE, type ToolFamily } from '@marinoscar/hexactra-agent';
import { browserFamily, desktopFamily } from '../src/families';
import { browserInstructions, IDENTITY } from '../src/instructions';

const accounts: ToolFamily = { id: 'accounts', title: "The owner's accounts", whenToUse: 'Mail and more.', rank: 10 };

describe('browserInstructions', () => {
  it('starts with the neutral identity, lists the families in the order given, then the routing rule and the browser how-to', () => {
    const text = browserInstructions(['payment', 'other'], { families: [accounts, browserFamily, desktopFamily], usageNotes: ['a note'] });
    expect(text.startsWith(IDENTITY)).toBe(true);
    expect(text).toContain("Your tools:\n- The owner's accounts: Mail and more.\n- The browser: A real Chrome browser");
    expect(text.indexOf('Your tools:')).toBeLessThan(text.indexOf(ROUTING_RULE));
    expect(text.indexOf(ROUTING_RULE)).toBeLessThan(text.indexOf('How to see:'));
    expect(text.indexOf('How to act')).toBeLessThan(text.indexOf('- Outside the page ('));
    expect(text.indexOf('- Outside the page (')).toBeLessThan(text.indexOf('When you need the person:'));
    expect(text).toContain('- On a website: signing in is your job, not theirs.');
    expect(text).toContain('topic from this list: payment, other');
    expect(text.endsWith('Tool notes:\n- a note')).toBe(true);
  });

  it('tells the agent how to type a code split into boxes, and never to read a typed field back (E49.2, #959)', () => {
    const text = browserInstructions(['other'], { families: [browserFamily] });
    expect(text).toContain('When the code is split across several boxes, pass the first box: the tool fills every box and says how many.');
    expect(text).toContain("After typing a secret, never read a field's value back (run_javascript, read_text)");
    expect(text).toContain('Never say a code was wrong or expired unless the page says so.');
  });

  it('with no browser family reads no browser how-to', () => {
    const text = browserInstructions(['other'], { families: [accounts] });
    expect(text).not.toContain('How to see');
    expect(text).not.toContain('How to act');
    expect(text).not.toContain('The browser:');
    expect(text).toContain('When done, or when the goal is impossible, call finish');
  });

  it('the desktop bullet moved out of the browser\'s act section into the desktop family', () => {
    expect(browserFamily.sections!.join('\n')).not.toContain('desktop_click');
    expect(desktopFamily.sections!.join('\n')).toContain('desktop_click, desktop_type, desktop_key, desktop_scroll, desktop_drag');
  });
});
