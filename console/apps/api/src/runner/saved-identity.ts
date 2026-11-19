// Identity details the agent fills without seeing them (E37.6, #595). Pure functions and types: no I/O, no clock, no Nest.
//
// A form asks for things that are sensitive but are not logins: a government ID number, a date of birth, a home address.
// The model names a FIELD of a saved item (`saved_identity` gives it per-run references and the fields' labels and flags);
// the fabric reads the page's origin itself, asks the owner's provider for that one field and types it. What lands in a
// step, the run's memory or a tool result is an item's NAME and a field's LABEL ("Date of birth"): never a value, never a
// length, never a provider id.
import { maskSensitive } from '../tasks/mask';
import type { FieldSummary, ItemSummary, SecretField } from '../secrets/secrets-provider.port';

/** What an observation reports for an input the fabric filled from a provider. */
export const FILLED_MARKER = '[filled from your saved details]';

/** One filled detail a run recorded, as `runs.used_saved_identity` stores it. */
export interface UsedSavedIdentity {
  provider: string;
  /** The item's name as the owner gave it ("Passport"). */
  itemName: string;
  /** The field's label ("Date of birth"). Never its value. */
  label: string;
  /** `scheme://host[:port]` of the page it was filled on. */
  origin: string;
  /** ISO time of its first fill in the run. */
  at: string;
}

/** At most this many entries per run. */
export const MAX_USED_SAVED_IDENTITY = 40;

/** Read `runs.used_saved_identity`: malformed entries are dropped. */
export function readUsedSavedIdentity(value: unknown): UsedSavedIdentity[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is UsedSavedIdentity => !!v && typeof v === 'object' && ['provider', 'itemName', 'label', 'origin', 'at'].every((k) => typeof (v as Record<string, unknown>)[k] === 'string'))
    .map((v) => ({ provider: v.provider, itemName: v.itemName, label: v.label, origin: v.origin, at: v.at }));
}

/** The list with one more fill, unless that item, label and site is already there (the oldest forty are kept). */
export function appendUsedSavedIdentity(current: unknown, entry: { provider: string; itemName: string; label: string; origin: string; at: Date }): UsedSavedIdentity[] {
  const list = readUsedSavedIdentity(current);
  if (list.some((u) => u.provider === entry.provider && u.itemName === entry.itemName && u.label === entry.label && u.origin === entry.origin)) return list;
  if (list.length >= MAX_USED_SAVED_IDENTITY) return list;
  return [...list, { provider: entry.provider.slice(0, 20), itemName: entry.itemName.slice(0, 200), label: entry.label.slice(0, 80), origin: entry.origin.slice(0, 300), at: entry.at.toISOString() }];
}

/** "Date of birth, ID number": the distinct labels of a list, in order, for a line the owner reads. */
export function labelsLine(list: readonly { label: string }[]): string {
  return [...new Set(list.map((u) => u.label))].join(', ');
}

/** A label or a name as the model and the trace may read it: one line, masked like any text of the trace, at most `max` characters. */
export function safeLabel(text: string, max = 80): string {
  return maskSensitive(text.replace(/\s+/g, ' ').trim().slice(0, max)).text;
}

/** A field as the model reads it. */
export interface LookedUpField {
  key: SecretField;
  label: string;
  sensitive: boolean;
  usableHere: boolean;
}

/** An identity item as the model reads it: a per-run reference, never the provider's id. */
export interface LookedUpIdentity {
  ref: string;
  /** The provider's id for the item. Kept in the run's memory to map a reference back; never shown to the model. */
  itemId: string;
  name: string;
  fields: LookedUpField[];
}

/** The lookup of the page the model is on. */
export interface SavedIdentityLookup {
  /** The page's top-level origin as the browser reported it. */
  origin: string;
  provider: string;
  items: LookedUpIdentity[];
}

/** An input the fabric filled from a provider on a page: its selector and the page, never a value. */
export interface FilledField {
  /** `origin + pathname` of the page it was filled on. */
  page: string;
  selector: string;
  label: string;
}

/** What a run remembers about saved identity details between chunks and jobs (`runs.transcript.savedIdentity`). Never a value. */
export interface SavedIdentityMemory {
  /** References handed out so far, by the provider's item id: one reference per item per run. */
  refs: Record<string, string>;
  lookup?: SavedIdentityLookup | null;
  /** Inputs the fabric filled from a provider (an identity detail, or a password typed from a saved login): their observed values are never shown to the model. */
  filled?: FilledField[];
  /** The card asked about a sensitive detail this site may not have: the owner chooses to allow the site or to type it this time. */
  asked?: { ref: string; itemId: string; key: SecretField; label: string; origin: string; itemName: string; selector: string } | null;
  /** The owner chose to type it this time: the run asks for it as a secret before anything else. */
  typeNow?: { label: string; origin: string; selector: string } | null;
  /** The owner was asked about each (item, field, site) at most once per run. */
  askedKeys?: string[];
}

/** The reference of an item in this run, handing out the next one (`details-1`, `details-2`, …) the first time. */
export function identityRefFor(memory: SavedIdentityMemory, itemId: string): string {
  const known = memory.refs[itemId];
  if (known) return known;
  const ref = `details-${Object.keys(memory.refs).length + 1}`;
  memory.refs[itemId] = ref;
  return ref;
}

function lookedUpField(f: FieldSummary): LookedUpField {
  return { key: f.key, label: safeLabel(f.label), sensitive: f.sensitive, usableHere: f.usableHere };
}

/** A provider's identity items for a page as the lookup the model reads and the runner remembers. Items with no field are dropped. */
export function identityLookupOf(memory: SavedIdentityMemory, result: { origin: string; provider: string; items: ItemSummary[] }): SavedIdentityLookup {
  const items: LookedUpIdentity[] = result.items
    .filter((i) => (i.fields?.length ?? 0) > 0)
    .map((i) => ({ ref: identityRefFor(memory, i.id), itemId: i.id, name: safeLabel(i.name, 120), fields: (i.fields ?? []).map(lookedUpField) }));
  return { origin: result.origin, provider: result.provider, items };
}

/** The model-facing form of one item: `{ ref, name, fields: [{ key, label, sensitive, usableHere }] }`. No value, no length. */
export function identityForModel(i: LookedUpIdentity) {
  return { ref: i.ref, name: i.name, fields: i.fields.map((f) => ({ key: f.key, label: f.label, sensitive: f.sensitive, usableHere: f.usableHere })) };
}

/** What `saved_identity` tells the model about a page. */
export function identityLookupText(lookup: SavedIdentityLookup): string {
  if (lookup.items.length === 0) {
    return 'none: no saved details are available for this page. If the form needs personal details, ask the owner in one request (request_human, input "text") listing every detail you need.';
  }
  const list = JSON.stringify(lookup.items.map(identityForModel));
  return (
    `${list}\n` +
    'Fill each field the form asks for with fill_from_identity(ref, field, selector), using the field key; for a date of birth split into three selects, call it once per select with part "day", "month" or "year". ' +
    'You never see a value and you never type one yourself: not from the goal, a memory or the page. ' +
    'A field with usableHere false is saved but not allowed on this site: fill_from_identity then asks the owner. If a field the form needs is not listed at all, ask the owner once for all missing details together (request_human, input "text").'
  );
}

/** Find the field of an item by its key (or, forgivingly, its label); null when the item has no such field. */
export function findField(item: LookedUpIdentity, field: string): LookedUpField | null {
  const f = field.trim().toLowerCase();
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return item.fields.find((x) => x.key === f) ?? item.fields.find((x) => norm(x.label) === norm(field) || x.key === norm(field)) ?? null;
}

/** `<itemId>:<field>@<origin>`: the key of the once-per-run question about a detail this site may not have. */
export const askedKey = (itemId: string, field: string, origin: string): string => `${itemId}:${field}@${origin}`;

/** `origin + pathname` of a URL: where a fill happened, for the read-back filter. Null for an address that is not a URL. */
export function pageOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/** The selectors filled from a provider on this page. */
export function filledOn(memory: SavedIdentityMemory | undefined, page: string | null): string[] {
  if (!memory?.filled || !page) return [];
  return [...new Set(memory.filled.filter((f) => f.page === page).map((f) => f.selector))];
}

/** Record a fill (a selector on a page); an identical one is not added twice. At most 60 are kept. */
export function noteFilled(memory: SavedIdentityMemory, entry: FilledField): void {
  const list = memory.filled ?? [];
  if (list.some((f) => f.page === entry.page && f.selector === entry.selector)) return;
  memory.filled = [...list, entry].slice(-60);
}

/**
 * Whether a script could read a form control's value or its serialised markup: the one thing the read-back filter checks for
 * `run_javascript` while a page holds a filled input. Best effort, deliberately broad.
 */
export function scriptMayReadValues(script: string): boolean {
  return /\b(value|valueAsDate|valueAsNumber|FormData|outerHTML|innerHTML|selectedOptions|selectedIndex|defaultValue|textContent|innerText)\b|getAttribute\s*\(\s*['"]value['"]/i.test(script);
}

/** The model's `observe_elements` listing with the filled inputs' text replaced by the marker. `filledSelectors` are the listing's own selectors that name a filled input. */
export function maskElements(els: Array<Record<string, unknown>>, filledSelectors: ReadonlySet<string>): Array<Record<string, unknown>> {
  return els.map((el) => {
    if (!filledSelectors.has(String(el.selector))) return el;
    const out: Record<string, unknown> = { ...el, text: FILLED_MARKER };
    for (const k of ['value', 'name_value', 'placeholder_value']) if (k in out) out[k] = FILLED_MARKER;
    return out;
  });
}
