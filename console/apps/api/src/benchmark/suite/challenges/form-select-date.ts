// form-select-date (E44.2, #740): a booking form whose service is chosen in a custom dropdown (a button and a listbox, not a
// `<select>`) and whose date is chosen in a calendar that opens on January 2030 (assets/benchmark-site/form-select-date.js). The form
// itself is an ordinary post: the widgets only fill its two hidden fields.
import { storedField } from '../compare';
import { field, html, notFound, page, redirect, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Check, Seed, SiteState } from '../types';
import { longDate, record } from './shared';

const SERVICES = ['Boiler service', 'Chimney sweep', 'Gutter cleaning', 'Lock repair', 'Meter reading', 'Oven repair', 'Roof inspection', 'Window fitting'] as const;
const BRAND = 'Home visits';
/** The month the calendar opens on, and the last one it reaches. */
const CALENDAR = { first: '2030-01', last: '2031-06' } as const;

export function formSelectDatePlan(seed: Seed): { name: string; service: string; date: string } {
  const g = seeded(seed, 'form-select-date');
  // Never in the month the calendar opens on: the task includes moving it.
  return { name: g.person(), service: g.pick(SERVICES), date: g.date('2030-03-01', 420) };
}

const validDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v && v.slice(0, 7) >= CALENDAR.first && v.slice(0, 7) <= CALENDAR.last;

function form(req: SiteRequest, values: { name: string; service: string; date: string }, errors: string[]): SiteResponse {
  return page({
    title: 'Book a visit',
    brand: BRAND,
    scripts: ['form-select-date.js'],
    body: html`${errors.length ? html`<div class="errors" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
      <form method="post" action="${req.root}book" class="stack" novalidate>
        <label for="f-name">Name</label>
        <input id="f-name" name="name" type="text" value="${values.name}" autocomplete="off">

        <span class="label" id="service-label">Service</span>
        <div class="dropdown" data-dropdown>
          <input type="hidden" name="service" value="${values.service}">
          <button type="button" class="dropdown-toggle" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="service-label service-value"><span id="service-value">${values.service || 'Choose a service'}</span></button>
          <ul class="dropdown-list" role="listbox" aria-labelledby="service-label" hidden>
            ${SERVICES.map((s) => html`<li role="option" tabindex="-1" data-value="${s}" aria-selected="${s === values.service ? 'true' : 'false'}">${s}</li>`)}
          </ul>
        </div>

        <span class="label" id="date-label">Date of the visit</span>
        <div class="datepicker" data-datepicker data-first="${CALENDAR.first}" data-last="${CALENDAR.last}">
          <input type="hidden" name="date" value="${values.date}">
          <button type="button" class="datepicker-toggle" aria-haspopup="dialog" aria-expanded="false" aria-labelledby="date-label date-value"><span id="date-value">${values.date ? longDate(values.date) : 'Choose a date'}</span></button>
          <div class="calendar" role="dialog" aria-label="Choose a date" hidden>
            <div class="calendar-head">
              <button type="button" data-step="-1" aria-label="Previous month">‹</button>
              <strong class="calendar-month" aria-live="polite"></strong>
              <button type="button" data-step="1" aria-label="Next month">›</button>
            </div>
            <div class="calendar-grid"></div>
          </div>
        </div>

        <div class="row"><button type="submit">Book the visit</button></div>
      </form>`,
  });
}

function handle(req: SiteRequest): SiteResponse {
  const booked = req.state.record !== null && req.state.record !== undefined;
  if (req.path === '' && req.method === 'GET') return booked ? redirect('done') : form(req, { name: '', service: '', date: '' }, []);
  if (req.path === 'done' && req.method === 'GET') {
    if (!booked) return redirect('');
    const r = record(req.state, 'record');
    return page({ title: 'Visit booked', brand: BRAND, body: html`<p id="confirmation">${String(r.service)} for ${String(r.name)} on ${longDate(String(r.date))}.</p>` });
  }
  if (req.path !== 'book' || req.method !== 'POST') return notFound();
  // The first completed booking is the record.
  if (booked) return redirect('done');
  const values = { name: field(req.body, 'name'), service: field(req.body, 'service'), date: field(req.body, 'date', 10) };
  const errors: string[] = [];
  if (!values.name) errors.push('Enter a name.');
  if (!(SERVICES as readonly string[]).includes(values.service)) errors.push('Choose a service.');
  if (!validDate(values.date)) errors.push('Choose a date.');
  if (errors.length) return form(req, { ...values, service: (SERVICES as readonly string[]).includes(values.service) ? values.service : '', date: validDate(values.date) ? values.date : '' }, errors);
  return redirect('done', { state: { ...req.state, record: values } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const plan = formSelectDatePlan(seed);
  const stored = record(state, 'record');
  const booked = state.record !== null && state.record !== undefined;
  return [
    { name: 'record-submitted', pass: booked, detail: booked ? 'a visit was booked' : 'no visit was booked' },
    storedField('stored-name', stored.name, plan.name),
    storedField('stored-service', stored.service, plan.service),
    { name: 'stored-date', pass: stored.date === plan.date, detail: `expected ${plan.date}; stored ${typeof stored.date === 'string' ? stored.date : 'nothing'}` },
  ];
}

export const formSelectDate: Challenge = {
  id: 'form-select-date',
  title: 'Book with a custom dropdown and a date picker',
  category: 'forms',
  difficulty: 2,
  setup: () => ({ record: null }),
  goal: (seed, baseUrl) => {
    const p = formSelectDatePlan(seed);
    return `Open ${baseUrl}/ and book a "${p.service}" visit for ${p.name} on ${longDate(p.date)}.`;
  },
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
