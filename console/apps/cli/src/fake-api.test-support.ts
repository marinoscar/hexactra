// Test support for the E50.15 command tests: a fake console API (a fake `fetch`, no real login) and a runner that captures stdout.
import { Command } from 'commander';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';
import { vi } from 'vitest';

import { setConsoleApiFactory } from './console-api.js';

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

/** `routes`: `METHOD /path` → the `data` to answer, or `{ status, body }` for an error answer. A route not listed answers 404. */
export function fakeApi(routes: Record<string, unknown>, errors: Record<string, { status: number; body: unknown }> = {}): FakeCall[] {
  const calls: FakeCall[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = decodeURIComponent(url.pathname.replace(/^\/api/, ''));
    calls.push({ method, path, query: Object.fromEntries(url.searchParams), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path}`;
    if (errors[key]) return new Response(JSON.stringify(errors[key].body), { status: errors[key].status, headers: { 'content-type': 'application/json' } });
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    if (routes[key] === null) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ data: routes[key] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  setConsoleApiFactory(() => new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch }));
  return calls;
}

/** Runs one command line against a program with only `register`; returns what was written to stdout. */
export async function runCommand(register: CliCommandRegistration, ...args: string[]): Promise<string> {
  const program = new Command().exitOverride();
  register(program);
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    await program.parseAsync(['node', 'hexactra', ...args]);
  } finally {
    spy.mockRestore();
  }
  return out;
}
