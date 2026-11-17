// Capability parity, web side (packages/shared/capabilities.json): every web
// route a capability names is declared, and the web app calls at least one of
// that capability's REST operations.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CAPABILITIES, type CapabilitySurface } from '@app/shared';
import { describe, expect, it } from 'vitest';

const values = (s: CapabilitySurface): readonly string[] => (typeof s === 'string' ? [s] : 'none' in s ? [] : s);
const src = join(__dirname, '..');
const read = (p: string) => readFileSync(join(src, p), 'utf8');
const tsx = (dir: string) => readdirSync(join(src, dir)).filter((f) => /\.tsx?$/.test(f)).map((f) => read(join(dir, f)));

const routeSources = [read('App.tsx'), ...tsx('slices')].join('\n');
const declared = new Set([...routeSources.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => `/${m[1]}`));
// The pages, the live stream, the agent policy client (src/policies/api.ts holds every policy call) and the schedule editor's preview hook.
const calls = [...tsx('pages'), ...tsx('policies'), ...tsx('schedule'), read('live.ts')].join('\n');

/** `/api/runs/{id}/cancel` → a pattern for the call `` `/runs/${...}/cancel` `` or `'/runs'`. */
function callPattern(op: string): RegExp {
  const path = op.split(' ')[1]!.replace(/^\/api/, '');
  const body = path
    .split(/\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\$\\{[^}]+\\}');
  return new RegExp(`[\`'"]${body}(?:[\`'"?]|\\$\\{)`);
}

describe('capability parity (web)', () => {
  const onWeb = CAPABILITIES.filter((c) => values(c.web).length > 0);

  it('declares every web route a capability names', () => {
    expect(onWeb.flatMap((c) => values(c.web).filter((r) => !declared.has(r)).map((r) => `${c.id}: ${r}`))).toEqual([]);
  });

  it('calls at least one REST operation of each capability it shows', () => {
    expect(onWeb.filter((c) => !c.rest.some((op) => callPattern(op).test(calls))).map((c) => c.id)).toEqual([]);
  });
});
