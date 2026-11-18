import { approvalCovers, classifyTarget, hostOf, normaliseTargetLabel, type RiskCategory, type TargetFacts } from '../src/runner/policy';

/** #550: the confirmation gate decides by what is clicked, not by the model's words. */
describe('classifyTarget (#550)', () => {
  const button = (label: string, extra: TargetFacts = {}): TargetFacts => ({ tag: 'button', label, ...extra });
  const link = (label: string): TargetFacts => ({ tag: 'a', label });

  const risky: [string, TargetFacts, RiskCategory][] = [
    ['button "Pay"', button('Pay'), 'payment'],
    ['button "Pay $10.00"', button('Pay $10.00'), 'payment'],
    ['button "Pay now"', button('Pay now'), 'payment'],
    ['button "Submit payment"', button('Submit payment'), 'payment'],
    ['button "Make a payment"', button('Make a payment'), 'payment'],
    ['button "Confirm payment"', button('Confirm payment'), 'payment'],
    ['role=button "Pay $25.00 to Person A"', { tag: 'div', role: 'button', label: 'Pay $25.00 to Person A' }, 'payment'],
    ['button "Send"', button('Send'), 'send'],
    ['button "Send money"', button('Send money'), 'send'],
    ['button "Send $25"', button('Send $25'), 'send'],
    ['button "Confirm transfer"', button('Confirm transfer'), 'send'],
    ['button "Transfer now"', button('Transfer now'), 'send'],
    ['button "Place your order"', button('Place your order'), 'purchase'],
    ['button "Place order"', button('Place order'), 'purchase'],
    ['button "Buy now"', button('Buy now'), 'purchase'],
    ['button "Confirm purchase"', button('Confirm purchase'), 'purchase'],
    ['button "Book now"', button('Book now'), 'purchase'],
    ['button "Subscribe"', button('Subscribe'), 'purchase'],
    ['button "Delete account"', button('Delete account'), 'delete'],
    ['button "Cancel subscription"', button('Cancel subscription'), 'delete'],
    ['button "Sign and submit"', button('Sign and submit'), 'submit'],
    ['submit input "Continue" posting to /payment/submit', { tag: 'input', inputType: 'submit', label: 'Continue', formAction: 'https://bank.example.test/payment/submit' }, 'payment'],
    ['submit button posting to /checkout/place-order', button('Next', { inputType: 'submit', formAction: '/checkout/place-order' }), 'purchase'],
    ['link styled as a button "Place order"', link('Place order'), 'purchase'],
    ['menu item "Delete account"', { role: 'menuitem', label: 'Delete account' }, 'delete'],
    ['button "PAY ®"', button('  PAY ® '), 'payment'],
    ['fallback (kind unknown), label "Pay now"', { label: 'Pay now' }, 'payment'],
  ];

  const safe: [string, TargetFacts][] = [
    ['date cell "18"', { tag: 'td', role: 'gridcell', label: '18' }],
    ['date cell button under a gridcell role', { role: 'gridcell', label: 'Pay on 18' }],
    ['option "Checking ending 0659"', { tag: 'option', label: 'Checking ending 0659' }],
    ['role=option "Pay from checking"', { tag: 'li', role: 'option', label: 'Pay from checking' }],
    ['tab "Pay bills"', { tag: 'button', role: 'tab', label: 'Pay bills' }],
    ['link "Send money with Zelle®"', link('Send money with Zelle®')],
    ['menu item "Payment activity"', { role: 'menuitem', label: 'Payment activity' }],
    ['link "View payment history"', link('View payment history')],
    ['field "Payment amount"', { tag: 'input', inputType: 'text', label: 'Payment amount' }],
    ['number field "Amount to pay"', { tag: 'input', inputType: 'number', label: 'Pay' }],
    ['checkbox "Pay automatically"', { tag: 'input', inputType: 'checkbox', label: 'Pay automatically' }],
    ['radio "Send today"', { tag: 'input', inputType: 'radio', label: 'Send today' }],
    ['button "Continue"', button('Continue')],
    ['button "Next"', button('Next')],
    ['button "Review"', button('Review')],
    ['button "Review payment"', button('Review payment')],
    ['button "Cancel"', button('Cancel')],
    ['button "Payment options"', button('Payment options')],
    ['button "Send money with Zelle"', button('Send money with Zelle')],
    ['combobox "From account"', { role: 'combobox', label: 'Pay from' }],
    ['accordion summary "Payment details"', { tag: 'summary', label: 'Payment details' }],
    ['plain text span "Pay"', { tag: 'span', label: 'Pay' }],
    ['button type=button with a commit form', button('Continue', { inputType: 'button', formAction: '/payment/submit' })],
    ['submit to a search form', button('Search', { inputType: 'submit', formAction: '/search' })],
    ['nothing known at all', {}],
    ['fallback, label "Continue"', { label: 'Continue' }],
  ];

  it('has at least 40 targets', () => {
    expect(risky.length + safe.length).toBeGreaterThanOrEqual(40);
  });

  it.each(risky)('%s is risky', (_name, facts, category) => {
    const v = classifyTarget(facts);
    expect(v).toMatchObject({ risky: true, category });
    expect(v.why).toBeTruthy();
  });

  it.each(safe)('%s is not risky', (_name, facts) => {
    expect(classifyTarget(facts)).toEqual({ risky: false, category: null, label: null, why: null });
  });

  it('never reads the model reason or the selector: TargetFacts has no field for them', () => {
    // A date cell whose surrounding words say "payment" stays a date cell.
    const facts = { tag: 'td', role: 'gridcell', label: '18', reason: 'Choose today, the earliest available payment date', selector: '#paymentDate' } as TargetFacts;
    expect(classifyTarget(facts).risky).toBe(false);
  });

  it('names the category and the label for the log and the question', () => {
    expect(classifyTarget(button('Pay $10.00'))).toEqual({ risky: true, category: 'payment', label: 'Pay $10.00', why: "a button labelled 'Pay $10.00'" });
  });
});

describe('approvalCovers (#550)', () => {
  const pay = { category: 'payment' as const, label: 'Pay', host: 'bank.example.test' };

  it('covers the same target, compared after normalisation', () => {
    expect(approvalCovers(pay, { category: 'payment', label: ' pay. ', host: 'bank.example.test' })).toBe(true);
  });
  it('does not cover a different risky target', () => {
    expect(approvalCovers(pay, { category: 'payment', label: 'Pay all', host: 'bank.example.test' })).toBe(false);
    expect(approvalCovers(pay, { category: 'send', label: 'Pay', host: 'bank.example.test' })).toBe(false);
    expect(approvalCovers(pay, { category: 'purchase', label: 'Place order', host: 'bank.example.test' })).toBe(false);
  });
  it('does not cover the same label on another host', () => {
    expect(approvalCovers(pay, { category: 'payment', label: 'Pay', host: 'other.example.test' })).toBe(false);
  });
  it('an approval read from a transcript written before #550 covers the next risky click', () => {
    expect(approvalCovers({ category: null, label: null, host: null }, { category: 'delete', label: 'Delete account', host: null })).toBe(true);
  });
});

describe('helpers (#550)', () => {
  it('normalises labels', () => {
    expect(normaliseTargetLabel('  Send   money with Zelle®  ')).toBe('send money with zelle');
    expect(normaliseTargetLabel('Pay →')).toBe('pay');
  });
  it('reads a host from a URL', () => {
    expect(hostOf('https://Secure.Bank.example.test/pay?x=1')).toBe('secure.bank.example.test');
    expect(hostOf('not a url')).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});
