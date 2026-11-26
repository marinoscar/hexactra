// @vitest-environment jsdom
//
// Typed secrets never come back (E49.3, #960): what the fabric typed as Secret
// Material is replaced with `[secret]` in `evaluate`, `text` and `elements`
// results and in errors. The run that prompted it read the `.value` of every
// code box with `evaluate` right after `type_secret`.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCdp } from '../src/cdp';
import { handleRequest, type BridgeRequest } from '../src/remote';
import { REMEMBER_MAX, REMEMBER_MS, SECRET_MARK, forgetTyped, hasTyped, rememberTyped, scrubTyped } from '../src/typed-secrets';

const CODE = '585774';
const PASSWORD = 'Tr0ub4dor&3';

describe('scrubTyped', () => {
  beforeEach(() => forgetTyped());

  it('leaves a result alone when nothing was typed', () => {
    const r = { value: `code ${CODE}` };
    expect(scrubTyped(r)).toBe(r);
  });

  it('replaces whole occurrences in every string, at any depth', () => {
    rememberTyped(CODE);
    rememberTyped(PASSWORD);
    expect(scrubTyped({ value: [`#otp=${CODE}`, { deep: `pw:${PASSWORD};${PASSWORD}` }], type: 'object' })).toEqual({
      value: [`#otp=${SECRET_MARK}`, { deep: `pw:${SECRET_MARK};${SECRET_MARK}` }],
      type: 'object',
    });
    expect(scrubTyped(`script threw: ${CODE}`)).toBe(`script threw: ${SECRET_MARK}`);
  });

  it('replaces a value read one box at a time (the failing run)', () => {
    rememberTyped(CODE);
    const read = [...CODE].map((d, i) => [`txtCode${i + 1}`, d]);
    read.push(['txtZipCode', '77384']);
    const out = scrubTyped({ value: read, type: 'object' }) as { value: string[][] };
    expect(out.value.slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6].map((n) => [`txtCode${n}`, SECRET_MARK]));
    expect(out.value[6]).toEqual(['txtZipCode', '77384']);
    expect(JSON.stringify(out)).not.toMatch(/"[0-9]"/);
  });

  it('replaces a value read in two-character pieces', () => {
    rememberTyped(CODE);
    expect(scrubTyped({ a: '58', b: '57', c: '74', d: 'other' })).toEqual({ a: SECRET_MARK, b: SECRET_MARK, c: SECRET_MARK, d: 'other' });
  });

  it('leaves pieces that do not spell out a value', () => {
    rememberTyped(CODE);
    expect(scrubTyped(['5', '8', 'x'])).toEqual(['5', '8', 'x']);
    expect(scrubTyped({ qty: '5', price: '7' })).toEqual({ qty: '5', price: '7' });
  });

  it('does not remember values too short to match safely', () => {
    rememberTyped('123');
    expect(hasTyped()).toBe(false);
  });

  it('forgets values after ten minutes, and keeps at most twenty', () => {
    rememberTyped(CODE, 0);
    expect(scrubTyped(CODE, REMEMBER_MS - 1)).toBe(SECRET_MARK);
    expect(scrubTyped(CODE, REMEMBER_MS)).toBe(CODE);
    forgetTyped();
    for (let i = 0; i < REMEMBER_MAX + 1; i++) rememberTyped(`value-${i}`);
    expect(scrubTyped('value-0')).toBe('value-0');
    expect(scrubTyped(`value-${REMEMBER_MAX}`)).toBe(SECRET_MARK);
  });
});

// --- Through the real path: handleRequest with a page in jsdom. ---

type Tab = { id: number; windowId: number; url: string; title: string; active: boolean; status: string };
let tab: Tab;

function makeChrome() {
  return {
    tabs: {
      get: vi.fn(async () => ({ ...tab })),
      query: vi.fn(async () => [{ ...tab }]),
      update: vi.fn(async () => tab),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async ({ func, args }: { func: (...a: unknown[]) => unknown; args: unknown[] }) => [{ result: await func(...args) }]),
    },
    debugger: {
      attach: vi.fn(async () => undefined),
      // Runtime.evaluate runs the expression in this (jsdom) page, as Chrome would.
      sendCommand: vi.fn(async (_t: unknown, method: string, params?: Record<string, unknown>) => {
        if (method !== 'Runtime.evaluate') return {};
        try {
          const value = new Function(`return (${String(params?.expression)})`)();
          return { result: { type: typeof value === 'object' ? 'object' : typeof value, value } };
        } catch (e) {
          return { exceptionDetails: { exception: { description: String(e) } } };
        }
      }),
      onDetach: { addListener: vi.fn() },
    },
  };
}

const req = (action: BridgeRequest['action']): BridgeRequest => ({ type: 'request', id: 'op-1', action, deadline_ms: Date.now() + 5_000 });

describe('a typed secret does not come back through handleRequest', () => {
  beforeEach(() => {
    forgetTyped();
    resetCdp();
    tab = { id: 1, windowId: 10, url: `${location.origin}/verify`, title: 'Verify', active: true, status: 'complete' };
    vi.stubGlobal('chrome', makeChrome());
    Element.prototype.scrollIntoView = () => undefined;
  });

  it('evaluate reading the field after a sensitive type gets [secret]', async () => {
    document.body.innerHTML = '<input id="pw" type="password">';
    expect((await handleRequest(req({ type: 'type', selector: '#pw', text: PASSWORD, sensitive: true, tab_id: 1 }))).ok).toBe(true);
    const r = await handleRequest(req({ type: 'evaluate', script: "document.querySelector('#pw').value", tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { value: SECRET_MARK } });
  });

  it('evaluate reading every code box after a sensitive type gets [secret] per box (the failing run)', async () => {
    document.body.innerHTML = `<form>${[1, 2, 3, 4, 5, 6].map((n) => `<input id="txtCode${n}" maxlength="1">`).join('')}</form>`;
    expect((await handleRequest(req({ type: 'type', selector: '#txtCode1', text: CODE, sensitive: true, tab_id: 1 }))).ok).toBe(true);
    const r = await handleRequest(req({ type: 'evaluate', script: "[...document.querySelectorAll('input')].map(e=>[e.id,e.value])", tab_id: 1 }));
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.result)).not.toMatch(/"[0-9]"/);
    expect((r.result as { value: string[][] }).value.map((p) => p[1])).toEqual(Array(6).fill(SECRET_MARK));
  });

  it('a script error that carries the value gets [secret]', async () => {
    document.body.innerHTML = '<input id="pw">';
    await handleRequest(req({ type: 'type_keys', text: PASSWORD, sensitive: true, tab_id: 1 }));
    const r = await handleRequest(req({ type: 'evaluate', script: `(() => { throw new Error('${PASSWORD}') })()`, tab_id: 1 }));
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain(PASSWORD);
    expect(r.error).toContain(SECRET_MARK);
  });

  it('an ordinary type is not remembered', async () => {
    document.body.innerHTML = '<input id="q">';
    await handleRequest(req({ type: 'type', selector: '#q', text: 'search words', tab_id: 1 }));
    const r = await handleRequest(req({ type: 'evaluate', script: "document.querySelector('#q').value", tab_id: 1 }));
    expect(r).toMatchObject({ ok: true, result: { value: 'search words' } });
  });
});
