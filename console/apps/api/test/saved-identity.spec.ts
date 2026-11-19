// Identity details the agent fills without seeing them (E37.6, #595): the pure parts of the runner's side.
import {
  appendUsedSavedIdentity,
  askedKey,
  FILLED_MARKER,
  filledOn,
  findField,
  identityLookupOf,
  identityLookupText,
  labelsLine,
  maskElements,
  MAX_USED_SAVED_IDENTITY,
  noteFilled,
  pageOf,
  readUsedSavedIdentity,
  safeLabel,
  scriptMayReadValues,
  type SavedIdentityMemory,
} from '../src/runner/saved-identity';
import type { ItemSummary } from '../src/secrets/secrets-provider.port';
import { hasIdentityScopes, vaultConnectScopes } from '../src/secrets/vault-contract';

const item = (over: Partial<ItemSummary> = {}): ItemSummary => ({
  id: 'prov-id-1',
  name: 'Passport',
  origins: [],
  matchKind: 'exact',
  hasCode: false,
  fields: [
    { key: 'full_name', label: 'Full name', sensitive: false, usableHere: true },
    { key: 'id_number', label: 'ID number', sensitive: true, usableHere: false },
  ],
  ...over,
});

describe('the lookup the model reads', () => {
  it('hands out per-run references, keeps the provider id out, and lists labels and flags only', () => {
    const memory: SavedIdentityMemory = { refs: {} };
    const lookup = identityLookupOf(memory, { origin: 'https://forms.example.test', provider: 'vault', items: [item(), item({ id: 'prov-id-2', name: 'Home', fields: [{ key: 'city', label: 'City', sensitive: false, usableHere: true }] }), item({ id: 'no-fields', fields: [] })] });
    expect(lookup.items.map((i) => i.ref)).toEqual(['details-1', 'details-2']);
    expect(memory.refs).toEqual({ 'prov-id-1': 'details-1', 'prov-id-2': 'details-2', ...{} });
    const text = identityLookupText(lookup);
    expect(text).not.toContain('prov-id');
    expect(JSON.parse(text.split('\n')[0]!)[0]).toEqual({
      ref: 'details-1',
      name: 'Passport',
      fields: [
        { key: 'full_name', label: 'Full name', sensitive: false, usableHere: true },
        { key: 'id_number', label: 'ID number', sensitive: true, usableHere: false },
      ],
    });
    // The same item keeps its reference on the next lookup.
    expect(identityLookupOf(memory, { origin: 'https://x.example.test', provider: 'vault', items: [item()] }).items[0]!.ref).toBe('details-1');
  });

  it('says what to do when nothing is saved, and masks a label that looks like a number', () => {
    const none = identityLookupText({ origin: 'https://x.example.test', provider: 'vault', items: [] });
    expect(none).toMatch(/^none:/);
    expect(none).toContain('request_human');
    expect(safeLabel('ID  number\n4111 1111 1111 1111')).not.toContain('4111 1111 1111 1111');
    expect(safeLabel('x'.repeat(300))).toHaveLength(80);
  });

  it('finds a field by key or label, and nothing else', () => {
    const lookup = identityLookupOf({ refs: {} }, { origin: 'https://x.example.test', provider: 'vault', items: [item()] });
    const i = lookup.items[0]!;
    expect(findField(i, 'id_number')?.key).toBe('id_number');
    expect(findField(i, 'ID number')?.key).toBe('id_number');
    expect(findField(i, ' Full-Name ')?.key).toBe('full_name');
    expect(findField(i, 'phone')).toBeNull();
  });
});

describe('what a run records', () => {
  const entry = (label: string, at = new Date(0)) => ({ provider: 'vault', itemName: 'Passport', label, origin: 'https://forms.example.test', at });

  it('keeps one entry per item, label and site, labels only, at most forty', () => {
    let list = appendUsedSavedIdentity(null, entry('Date of birth'));
    list = appendUsedSavedIdentity(list, entry('ID number'));
    list = appendUsedSavedIdentity(list, entry('Date of birth', new Date(5)));
    expect(list.map((u) => u.label)).toEqual(['Date of birth', 'ID number']);
    expect(labelsLine(list)).toBe('Date of birth, ID number');
    let many: unknown = null;
    for (let i = 0; i < MAX_USED_SAVED_IDENTITY + 5; i++) many = appendUsedSavedIdentity(many, entry(`Field ${i}`));
    expect(readUsedSavedIdentity(many)).toHaveLength(MAX_USED_SAVED_IDENTITY);
  });

  it('drops malformed entries when reading', () => {
    expect(readUsedSavedIdentity('x')).toEqual([]);
    expect(readUsedSavedIdentity([{ provider: 'vault' }, null, { provider: 'v', itemName: 'n', label: 'l', origin: 'o', at: 'a', extra: 1 }])).toEqual([{ provider: 'v', itemName: 'n', label: 'l', origin: 'o', at: 'a' }]);
  });
});

describe('the read-back filter', () => {
  it('notes a filled selector per page and returns those of the page on screen', () => {
    const memory: SavedIdentityMemory = { refs: {} };
    noteFilled(memory, { page: 'https://a.example.test/form', selector: '#name', label: 'Full name' });
    noteFilled(memory, { page: 'https://a.example.test/form', selector: '#name', label: 'Full name' });
    noteFilled(memory, { page: 'https://a.example.test/other', selector: '#city', label: 'City' });
    expect(filledOn(memory, 'https://a.example.test/form')).toEqual(['#name']);
    expect(filledOn(memory, 'https://a.example.test/other')).toEqual(['#city']);
    expect(filledOn(memory, null)).toEqual([]);
    expect(filledOn(undefined, 'https://a.example.test/form')).toEqual([]);
    for (let i = 0; i < 100; i++) noteFilled(memory, { page: 'p', selector: `#f${i}`, label: 'x' });
    expect(memory.filled).toHaveLength(60);
  });

  it('replaces a filled element\'s text and nothing else', () => {
    const els = [
      { selector: '#name', tag: 'input', text: 'Person A Canary-Name' },
      { selector: '#other', tag: 'input', text: 'typed by the model' },
    ];
    expect(maskElements(els, new Set(['#name']))).toEqual([{ selector: '#name', tag: 'input', text: FILLED_MARKER }, els[1]]);
    expect(maskElements(els, new Set())).toEqual(els);
  });

  it('recognises a script that could read a value', () => {
    for (const s of ["document.querySelector('#a').value", 'new FormData(form)', 'form.outerHTML', 'x.innerHTML', "el.getAttribute('value')", 'sel.selectedIndex']) expect(scriptMayReadValues(s)).toBe(true);
    for (const s of ['document.title', 'window.scrollTo(0, 0)', 'history.length']) expect(scriptMayReadValues(s)).toBe(false);
  });

  it('keys a page by origin and path, and a question by item, field and site', () => {
    expect(pageOf('https://a.example.test/form?token=1#x')).toBe('https://a.example.test/form');
    expect(pageOf('nope')).toBeNull();
    expect(pageOf(null)).toBeNull();
    expect(askedKey('i', 'id_number', 'https://a.example.test')).toBe('i:id_number@https://a.example.test');
  });
});

describe('the Vault scopes', () => {
  it('asks for the identity scopes only when the owner allowed them, and reads them back', () => {
    expect(vaultConnectScopes(false)).toEqual(['vault:items_read', 'vault:items_fill', 'offline_access']);
    const withBoth = vaultConnectScopes(true, true);
    expect(withBoth).toEqual(['vault:items_read', 'vault:items_fill', 'vault:items_write', 'vault:identity_read', 'vault:identity_fill', 'offline_access']);
    expect(hasIdentityScopes(withBoth)).toBe(true);
    expect(hasIdentityScopes(vaultConnectScopes(true))).toBe(false);
    expect(hasIdentityScopes(['vault:identity_read'])).toBe(false);
  });
});
