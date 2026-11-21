// form-real-keys (E44.7, #745): a verification field that ignores synthetic input. Its script (assets/benchmark-site/
// form-real-keys.js) builds the value from TRUSTED key presses only (`event.isTrusted`): a value set by a script, pasted, or typed
// with synthetic key events never reaches the form. On submit it copies what was typed, and how many keys it took, into the form's
// hidden fields. The server refuses a phrase that took fewer key presses than it has characters.
//
// A page cannot prove how it was driven: an agent that runs code in the page could post the hidden fields itself. The challenge
// measures whether the agent completes a field like this, not whether it is able to cheat it.
import { storedField } from '../compare';
import { field, html, notFound, page, redirect, type SiteRequest, type SiteResponse } from '../pages';
import { seeded } from '../seeded';
import type { Challenge, Check, Seed, SiteState } from '../types';
import { intField, record } from './shared';

const BRAND = 'Account recovery';

export function formRealKeysPlan(seed: Seed): { name: string; phrase: string } {
  const g = seeded(seed, 'form-real-keys');
  return { name: g.person(), phrase: `${g.code(4)}-${g.code(4)}` };
}

function form(req: SiteRequest, name: string, errors: string[]): SiteResponse {
  return page({
    title: 'Confirm your identity',
    brand: BRAND,
    scripts: ['form-real-keys.js'],
    body: html`${errors.length ? html`<div class="errors" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
      <form method="post" action="${req.root}verify" class="stack" novalidate data-real-keys-form>
        <label for="f-name">Full name</label>
        <input id="f-name" name="name" type="text" value="${name}" autocomplete="off">
        <label for="f-phrase">Verification phrase</label>
        <input id="f-phrase" type="text" autocomplete="off" spellcheck="false" data-real-keys>
        <span class="muted">Type the phrase. Pasting is turned off.</span>
        <input type="hidden" name="phrase" value="">
        <input type="hidden" name="typed" value="0">
        <div class="row"><button type="submit">Verify</button></div>
      </form>`,
  });
}

function handle(req: SiteRequest): SiteResponse {
  const done = req.state.record !== null && req.state.record !== undefined;
  if (req.path === '' && req.method === 'GET') return done ? redirect('done') : form(req, '', []);
  if (req.path === 'done' && req.method === 'GET') {
    if (!done) return redirect('');
    return page({ title: 'Verified', brand: BRAND, body: html`<p id="confirmation">Thank you, ${String(record(req.state, 'record').name)}. Your identity is confirmed.</p>` });
  }
  if (req.path !== 'verify' || req.method !== 'POST') return notFound();
  if (done) return redirect('done');
  const name = field(req.body, 'name');
  const phrase = field(req.body, 'phrase', 40);
  const typed = intField(req.body, 'typed', 0, 10_000) ?? 0;
  const errors: string[] = [];
  if (!name) errors.push('Enter your full name.');
  if (!phrase) errors.push('Type the verification phrase.');
  else if (typed < phrase.length) errors.push('Type the verification phrase with the keyboard.');
  if (errors.length) return form(req, name, errors);
  return redirect('done', { state: { ...req.state, record: { name, phrase, typed } } });
}

function grade(seed: Seed, state: SiteState): Check[] {
  const p = formRealKeysPlan(seed);
  const r = record(state, 'record');
  const done = state.record !== null && state.record !== undefined;
  // The phrase is a code: its case and characters must be exact.
  const phraseOk = r.phrase === p.phrase;
  return [
    { name: 'record-submitted', pass: done, detail: done ? 'the form was submitted' : 'the form was never submitted' },
    storedField('stored-name', r.name, p.name),
    { name: 'stored-phrase', pass: phraseOk, detail: phraseOk ? `stored ${p.phrase}` : `expected ${p.phrase}; stored ${typeof r.phrase === 'string' && r.phrase ? r.phrase : 'nothing'}` },
  ];
}

export const formRealKeys: Challenge = {
  id: 'form-real-keys',
  title: 'Type into a field that ignores synthetic input',
  category: 'forms',
  difficulty: 2,
  requires: ['real_keys'],
  setup: () => ({ record: null }),
  goal: (seed, baseUrl) => {
    const p = formRealKeysPlan(seed);
    return `Open ${baseUrl}/ and verify the identity of ${p.name} with the verification phrase ${p.phrase}.`;
  },
  grade: ({ seed, state }) => grade(seed, state),
  site: { handle },
};
