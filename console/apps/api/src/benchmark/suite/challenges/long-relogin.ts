// long-relogin (E44.7, #745): an expenses app behind a sign-in. After the first expense is saved the session expires: the next
// expense posted is refused (and lost), and the person is sent back to sign in. The agent finishes the task by signing in again and
// adding what was lost.
//
// The username and password are FIXTURE credentials of this trial's site, derived from the seed and written in the goal. They are
// not Secret Material: they open nothing but this trial's pages, and the challenge has no owner rule (the goal already holds them).
// There is no cookie: "signed in" is the trial's state, like everything else on the site.
import { amountsIn, sameText } from '../compare';
import { field, html, notFound, page, redirect, type SiteRequest, type SiteResponse } from '../pages';
import { formatPrice, seeded } from '../seeded';
import type { Challenge, Check, Json, Seed, SiteState } from '../types';
import { appended, asRecord, counter, distinct, list } from './shared';

const PURPOSES = ['Taxi to the airport', 'Train ticket', 'Hotel breakfast', 'Printer paper', 'Client lunch', 'Parking', 'Conference pass', 'Courier fee', 'Team coffee', 'Phone charger'] as const;
const BRAND = 'Expenses';

export interface ReloginPlan {
  username: string;
  password: string;
  expenses: { purpose: string; cents: number }[];
}

export function longReloginPlan(seed: Seed): ReloginPlan {
  const g = seeded(seed, 'long-relogin');
  const purposes = distinct(() => g.pick(PURPOSES), 3);
  return { username: g.email().split('@')[0]!, password: `fixture-${g.code(8).toLowerCase()}`, expenses: purposes.map((purpose) => ({ purpose, cents: g.price(6, 240).cents })) };
}

function loginPage(req: SiteRequest, message: { error?: string; expired?: boolean }): SiteResponse {
  return page({
    title: 'Sign in',
    brand: BRAND,
    body: html`${message.expired ? html`<div class="errors" role="alert"><p>Your session has expired. Sign in again. The expense you were adding was not saved.</p></div>` : ''}${message.error ? html`<div class="errors" role="alert"><p>${message.error}</p></div>` : ''}
      <form method="post" action="${req.root}login" class="stack" novalidate>
        <label for="f-user">Username</label><input id="f-user" name="username" type="text" autocomplete="username">
        <label for="f-pass">Password</label><input id="f-pass" name="password" type="password" autocomplete="current-password">
        <div class="row"><button type="submit">Sign in</button></div>
      </form>`,
  });
}

function expensesPage(req: SiteRequest, error?: string): SiteResponse {
  const entries = list(req.state, 'entries').map((e) => asRecord(e));
  return page({
    title: 'Your expenses',
    brand: BRAND,
    body: html`${error ? html`<div class="errors" role="alert"><p>${error}</p></div>` : ''}
      <table class="grid"><thead><tr><th>Purpose</th><th class="num">Amount</th></tr></thead><tbody>
        ${entries.length ? entries.map((e) => html`<tr><td>${String(e.purpose)}</td><td class="num">${formatPrice(Number(e.cents))}</td></tr>`) : html`<tr><td colspan="2" class="muted">No expenses yet.</td></tr>`}
      </tbody></table>
      <h2>Add an expense</h2>
      <form method="post" action="${req.root}expenses" class="stack" novalidate>
        <label for="f-purpose">Purpose</label><input id="f-purpose" name="purpose" type="text" autocomplete="off">
        <label for="f-amount">Amount</label><input id="f-amount" name="amount" type="text" inputmode="decimal" autocomplete="off">
        <div class="row"><button type="submit">Add expense</button></div>
      </form>`,
  });
}

function handle(req: SiteRequest): SiteResponse {
  const plan = longReloginPlan(req.seed);
  const signedIn = req.state.signedIn === true;
  if (req.path === '' && req.method === 'GET') return signedIn ? expensesPage(req) : redirect(req.state.expired === true ? 'login?expired=1' : 'login');
  if (req.path === 'login' && req.method === 'GET') return signedIn ? redirect('') : loginPage(req, { expired: req.query.expired === '1' });
  if (req.path === 'login' && req.method === 'POST') {
    if (field(req.body, 'username') !== plan.username || field(req.body, 'password', 100) !== plan.password) {
      return loginPage(req, { error: 'The username or password is not right.' });
    }
    return redirect('', { state: { ...req.state, signedIn: true, expired: false, logins: counter(req.state, 'logins') + 1 } });
  }
  if (req.path !== 'expenses' || req.method !== 'POST') return notFound();
  if (!signedIn) return redirect('login?expired=1');
  const entries = list(req.state, 'entries');
  // The session runs out after the first saved expense: the next one posted is refused and lost.
  if (entries.length >= 1 && req.state.expiredOnce !== true) return redirect('login?expired=1', { state: { ...req.state, signedIn: false, expired: true, expiredOnce: true } });
  const purpose = field(req.body, 'purpose', 80);
  const amounts = amountsIn(field(req.body, 'amount', 20));
  if (!purpose || amounts.length !== 1 || amounts[0]! <= 0) return expensesPage(req, 'Enter a purpose and an amount.');
  return redirect('', { state: { ...req.state, entries: appended(entries, { purpose, cents: amounts[0]! }) } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const { expenses } = longReloginPlan(seed);
  const entries = list(state, 'entries').map((e) => asRecord(e));
  const matches = (want: { purpose: string; cents: number }) => entries.filter((e) => typeof e.purpose === 'string' && sameText(e.purpose, want.purpose) && e.cents === want.cents).length;
  const missing = expenses.filter((x) => matches(x) === 0);
  const extra = entries.length - expenses.reduce((n, x) => n + Math.min(1, matches(x)), 0);
  return [
    { name: 'signed-in-again', pass: counter(state, 'logins') >= 2, detail: `signed in ${counter(state, 'logins')} time(s); the session expires once` },
    { name: 'expenses-stored', pass: missing.length === 0, detail: missing.length ? `missing: ${missing.map((x) => `${x.purpose} ${formatPrice(x.cents)}`).join(', ')}` : 'every expense was saved' },
    { name: 'no-extra-expenses', pass: entries.length > 0 && extra === 0, detail: extra > 0 ? `${extra} expense(s) saved that were not asked for, or saved twice` : `${entries.length} expense(s) saved` },
  ];
}

export const longRelogin: Challenge = {
  id: 'long-relogin',
  title: 'Finish a task across a session expiry',
  category: 'long',
  difficulty: 3,
  setup: () => ({ signedIn: false, expired: false, expiredOnce: false, logins: 0, entries: [] as Json[] }),
  goal: (seed, baseUrl) => {
    const p = longReloginPlan(seed);
    return `Open ${baseUrl}/ and sign in with the username "${p.username}" and the password "${p.password}" (test credentials for this site only). Then add these expenses: ${p.expenses.map((x) => `"${x.purpose}" ${formatPrice(x.cents)}`).join(', ')}.`;
  },
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
