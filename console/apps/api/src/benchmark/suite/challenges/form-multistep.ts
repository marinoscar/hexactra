// form-multistep (E44.2, #740): a registration in three steps (contact, address, plan), each a real form post validated by the server.
// A step with a mistake comes back with its errors; the phone number in the goal is written with a dash and the form wants digits only.
import { sameText, storedField } from '../compare';
import { field, html, notFound, page, redirect, type Html, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Check, Json, Seed, SiteState } from '../types';
import { STREETS, TOWNS, record } from './shared';

const PLANS = ['Basic', 'Standard', 'Premium'] as const;
const BRAND = 'Member registration';
type Fields = Record<string, string>;

export function formMultistepPlan(seed: Seed): { name: string; email: string; phoneAsGiven: string; phone: string; street: string; city: string; postal: string; plan: string } {
  const g = seeded(seed, 'form-multistep');
  // 555-01xx is the range reserved for fiction.
  const line = String(g.int(0, 99)).padStart(2, '0');
  return {
    name: g.person(),
    email: g.email(),
    phoneAsGiven: `555-01${line}`,
    phone: `55501${line}`,
    street: `${g.int(1, 199)} ${g.pick(STREETS)}`,
    city: g.pick(TOWNS),
    postal: String(g.int(10000, 99999)),
    plan: g.pick(PLANS),
  };
}

/** What each step asks for, and why a value is refused. */
const STEPS: readonly { title: string; fields: readonly { name: string; label: string; hint?: string; check: (v: string) => string | null }[] }[] = [
  {
    title: 'Contact details',
    fields: [
      { name: 'name', label: 'Full name', check: (v) => (v ? null : 'Enter your name.') },
      { name: 'email', label: 'Email address', check: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Enter an email address, like name@example.test.') },
      { name: 'phone', label: 'Phone number', hint: 'Digits only.', check: (v) => (/^\d{7,15}$/.test(v) ? null : 'Use digits only, without spaces or dashes.') },
    ],
  },
  {
    title: 'Address',
    fields: [
      { name: 'street', label: 'Street and number', check: (v) => (v ? null : 'Enter the street and number.') },
      { name: 'city', label: 'Town', check: (v) => (v ? null : 'Enter the town.') },
      { name: 'postal', label: 'Postal code', hint: 'Five digits.', check: (v) => (/^\d{5}$/.test(v) ? null : 'A postal code has five digits.') },
    ],
  },
];

function stepsDone(draft: { [key: string]: Json }): number {
  let done = 0;
  for (const step of STEPS) {
    if (!step.fields.every((f) => typeof draft[f.name] === 'string' && f.check(draft[f.name] as string) === null)) break;
    done++;
  }
  return done;
}

const progress = (n: number): Html => html`<p class="muted" id="step-status">Step ${n} of 3</p>`;
const errorList = (errors: Fields): Html | '' =>
  Object.keys(errors).length ? html`<div class="errors" role="alert"><p>Please correct the following:</p><ul>${Object.values(errors).map((e) => html`<li>${e}</li>`)}</ul></div>` : '';

function fieldStep(req: SiteRequest, n: 1 | 2, values: Fields, errors: Fields): SiteResponse {
  const step = STEPS[n - 1]!;
  return page({
    title: step.title,
    brand: BRAND,
    body: html`${progress(n)}${errorList(errors)}
      <form method="post" action="${req.root}step/${n}" class="stack" novalidate>
        ${step.fields.map(
          (f) => html`<label for="f-${f.name}">${f.label}</label>
            <input id="f-${f.name}" name="${f.name}" type="text" value="${values[f.name] ?? ''}" autocomplete="off"${errors[f.name] ? html` aria-invalid="true"` : ''}>
            ${f.hint ? html`<small class="muted">${f.hint}</small>` : ''}`,
        )}
        <div class="row">${n > 1 ? html`<a class="button secondary" href="${req.root}step/${n - 1}">Back</a>` : ''}<button type="submit">Continue</button></div>
      </form>`,
  });
}

function planStep(req: SiteRequest, draft: { [key: string]: Json }, chosen: string, errors: Fields): SiteResponse {
  return page({
    title: 'Plan and confirmation',
    brand: BRAND,
    body: html`${progress(3)}${errorList(errors)}
      <dl class="facts">${STEPS.flatMap((s) => s.fields).map((f) => html`<dt>${f.label}</dt><dd>${String(draft[f.name] ?? '')}</dd>`)}</dl>
      <form method="post" action="${req.root}step/3" class="stack" novalidate>
        <label for="f-plan">Plan</label>
        <select id="f-plan" name="plan">
          <option value="">Choose a plan</option>
          ${PLANS.map((p) => html`<option value="${p}"${p === chosen ? html` selected` : ''}>${p}</option>`)}
        </select>
        <label class="check"><input type="checkbox" name="terms" value="yes"> I accept the terms of membership</label>
        <div class="row"><a class="button secondary" href="${req.root}step/2">Back</a><button type="submit">Complete registration</button></div>
      </form>`,
  });
}

function handle(req: SiteRequest): SiteResponse {
  const draft = record(req.state, 'draft');
  const submitted = req.state.record !== null && req.state.record !== undefined;
  if (req.path === '' && req.method === 'GET') {
    return page({ title: 'Become a member', brand: BRAND, body: html`<p>Registration takes three short steps.</p><p><a class="button" href="${req.root}step/1">Start registration</a></p>` });
  }
  if (req.path === 'done' && req.method === 'GET') {
    if (!submitted) return redirect('step/1');
    return page({ title: 'Registration complete', brand: BRAND, body: html`<p id="confirmation">Thank you, ${String(record(req.state, 'record').name ?? '')}. Your membership is registered.</p>` });
  }
  const n = req.segments[0] === 'step' && req.segments.length === 2 ? Number(req.segments[1]) : NaN;
  if (n !== 1 && n !== 2 && n !== 3) return notFound();
  // A finished registration is not reopened: the stored record is the first one completed.
  if (submitted) return redirect('done');
  const done = stepsDone(draft);
  if (n > done + 1) return redirect(`step/${done + 1}`);
  const strings = (source: Readonly<Record<string, Json>>): Fields => Object.fromEntries(Object.entries(source).filter((e): e is [string, string] => typeof e[1] === 'string'));
  if (req.method === 'GET') return n === 3 ? planStep(req, draft, '', {}) : fieldStep(req, n, strings(draft), {});

  const rejected = (typeof req.state.rejected === 'number' ? req.state.rejected : 0) + 1;
  if (n === 3) {
    const plan = field(req.body, 'plan');
    const errors: Fields = {};
    if (!(PLANS as readonly string[]).includes(plan)) errors.plan = 'Choose a plan.';
    if (field(req.body, 'terms') !== 'yes') errors.terms = 'Accept the terms to continue.';
    if (Object.keys(errors).length) return { ...planStep(req, draft, plan, errors), state: { ...req.state, rejected } } as SiteResponse;
    return redirect('done', { state: { ...req.state, record: { ...draft, plan } } });
  }
  const values: Fields = {};
  const errors: Fields = {};
  for (const f of STEPS[n - 1]!.fields) {
    values[f.name] = field(req.body, f.name);
    const problem = f.check(values[f.name]!);
    if (problem) errors[f.name] = problem;
  }
  if (Object.keys(errors).length) return { ...fieldStep(req, n, values, errors), state: { ...req.state, rejected } } as SiteResponse;
  return redirect(`step/${n + 1}`, { state: { ...req.state, draft: { ...draft, ...values } } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const plan = formMultistepPlan(seed);
  const stored = record(state, 'record');
  const submitted = state.record !== null && state.record !== undefined;
  const digits = typeof stored.phone === 'string' ? stored.phone.replace(/\D/g, '') : '';
  return [
    { name: 'record-submitted', pass: submitted, detail: submitted ? 'the registration was completed' : 'no registration was completed' },
    storedField('stored-name', stored.name, plan.name),
    storedField('stored-email', stored.email, plan.email),
    { name: 'stored-phone', pass: digits === plan.phone, detail: `expected ${plan.phone}; stored ${digits || 'nothing'}` },
    storedField('stored-street', stored.street, plan.street),
    storedField('stored-city', stored.city, plan.city),
    storedField('stored-postal', stored.postal, plan.postal),
    { name: 'stored-plan', pass: typeof stored.plan === 'string' && sameText(stored.plan, plan.plan), detail: `expected ${plan.plan}; stored ${String(stored.plan ?? 'nothing')}` },
  ];
}

export const formMultistep: Challenge = {
  id: 'form-multistep',
  title: 'Complete a three-step registration',
  category: 'forms',
  difficulty: 2,
  setup: () => ({ draft: {}, record: null, rejected: 0 }),
  goal: (seed, baseUrl) => {
    const p = formMultistepPlan(seed);
    return `Open ${baseUrl}/ and register a new member with these details: name ${p.name}, email ${p.email}, phone ${p.phoneAsGiven}, address ${p.street}, ${p.city}, postal code ${p.postal}, plan ${p.plan}. Complete the registration.`;
  },
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
