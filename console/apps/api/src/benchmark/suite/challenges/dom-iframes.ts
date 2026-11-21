// dom-iframes (E44.7, #745): the form is two frames deep. The start page frames `frame/outer`, which frames `frame/inner`, where the
// form is; all three are this trial's own pages (the site's policy allows its own frames only). The form is an ordinary post.
import { storedField } from '../compare';
import { field, html, notFound, page, redirect, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Check, Seed, SiteState } from '../types';
import { record } from './shared';

const TRADES = ['Joinery', 'Catering', 'Printing', 'Cleaning', 'Landscaping', 'Courier', 'Upholstery', 'Glazing'] as const;
const BRAND = 'Supplier portal';

export function domIframesPlan(seed: Seed): { company: string; contact: string; email: string; supplierCode: string } {
  const g = seeded(seed, 'dom-iframes');
  const contact = g.person();
  return { company: `${contact.slice(7)} ${g.pick(TRADES)} Works`, contact, email: g.email(), supplierCode: `SUP-${g.code(5)}` };
}

const FIELDS = ['company', 'contact', 'email', 'code'] as const;

function form(req: SiteRequest, values: Record<(typeof FIELDS)[number], string>, errors: string[]): SiteResponse {
  return page({
    title: 'Supplier details',
    brand: BRAND,
    body: html`${errors.length ? html`<div class="errors" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
      <form method="post" action="${req.root}frame/submit" class="stack" novalidate>
        <label for="f-company">Company name</label><input id="f-company" name="company" type="text" value="${values.company}" autocomplete="off">
        <label for="f-contact">Contact person</label><input id="f-contact" name="contact" type="text" value="${values.contact}" autocomplete="off">
        <label for="f-email">Contact email</label><input id="f-email" name="email" type="text" value="${values.email}" autocomplete="off">
        <label for="f-code">Supplier code</label><input id="f-code" name="code" type="text" value="${values.code}" autocomplete="off">
        <div class="row"><button type="submit">Register supplier</button></div>
      </form>`,
  });
}

function handle(req: SiteRequest): SiteResponse {
  const done = req.state.record !== null && req.state.record !== undefined;
  if (req.method === 'GET' && req.path === '') {
    return page({ title: 'Register as a supplier', brand: BRAND, body: html`<p>Fill in the registration form below.</p><iframe class="frame frame-outer" src="${req.root}frame/outer" title="Registration"></iframe>` });
  }
  if (req.method === 'GET' && req.path === 'frame/outer') {
    return page({ title: 'Registration', brand: BRAND, body: html`<p class="muted">Step 1 of 1: your company.</p><iframe class="frame frame-inner" src="${req.root}frame/inner" title="Supplier details"></iframe>` });
  }
  if (req.method === 'GET' && req.path === 'frame/inner') return done ? redirect('frame/done') : form(req, { company: '', contact: '', email: '', code: '' }, []);
  if (req.method === 'GET' && req.path === 'frame/done') {
    if (!done) return redirect('frame/inner');
    return page({ title: 'Registered', brand: BRAND, body: html`<p id="confirmation">${String(record(req.state, 'record').company)} is registered.</p>` });
  }
  if (req.method !== 'POST' || req.path !== 'frame/submit') return notFound();
  if (done) return redirect('frame/done');
  const values = { company: field(req.body, 'company'), contact: field(req.body, 'contact'), email: field(req.body, 'email'), code: field(req.body, 'code', 40) };
  const errors: string[] = [];
  if (!values.company) errors.push('Enter the company name.');
  if (!values.contact) errors.push('Enter the contact person.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) errors.push('Enter an email address.');
  if (!values.code) errors.push('Enter the supplier code.');
  if (errors.length) return form(req, values, errors);
  return redirect('frame/done', { state: { ...req.state, record: values } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const p = domIframesPlan(seed);
  const r = record(state, 'record');
  const done = state.record !== null && state.record !== undefined;
  return [
    { name: 'record-submitted', pass: done, detail: done ? 'the form was submitted' : 'the form was never submitted' },
    storedField('stored-company', r.company, p.company),
    storedField('stored-contact', r.contact, p.contact),
    storedField('stored-email', r.email, p.email),
    storedField('stored-code', r.code, p.supplierCode),
  ];
}

export const domIframes: Challenge = {
  id: 'dom-iframes',
  title: 'Fill a form inside nested frames',
  category: 'forms',
  difficulty: 2,
  setup: () => ({ record: null }),
  goal: (seed, baseUrl) => {
    const p = domIframesPlan(seed);
    return `Open ${baseUrl}/ and register the supplier "${p.company}": contact person ${p.contact}, email ${p.email}, supplier code ${p.supplierCode}.`;
  },
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
