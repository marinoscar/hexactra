// Capability parity, CLI and TUI side (packages/shared/capabilities.json):
// every CLI command a capability names is registered, every TUI screen it
// names is mounted, and every app command belongs to a capability.
import { CAPABILITIES, type CapabilitySurface } from '@app/shared';
import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const values = (s: CapabilitySurface): readonly string[] => (typeof s === 'string' ? [s] : 'none' in s ? [] : s);

/** Every leaf command path of the app's own commands, e.g. `tasks list`. */
function leafPaths(): string[] {
  const program = new Command();
  for (const register of APP_CLI_OPTIONS.extraCommands ?? []) register(program);
  const out: string[] = [];
  const walk = (cmd: Command, prefix: string[]) => {
    for (const sub of cmd.commands) {
      const path = [...prefix, sub.name()];
      if (sub.commands.length) walk(sub, path);
      else out.push(path.join(' '));
    }
  };
  walk(program, []);
  return out;
}

/** Commands that are tooling rather than a capability of the product: the MCP bridge and the platform's Android release group. */
const isTooling = (path: string) => path === 'mcp serve' || path.startsWith('android ') || path === 'android';

describe('capability parity (CLI, TUI)', () => {
  const commands = leafPaths();

  it('registers every command a capability names', () => {
    const missing = CAPABILITIES.flatMap((c) => values(c.cli).filter((p) => !commands.includes(p)).map((p) => `${c.id}: ${p}`));
    expect(missing).toEqual([]);
  });

  it('every app command belongs to a capability', () => {
    const named = new Set(CAPABILITIES.flatMap((c) => values(c.cli)));
    expect(commands.length).toBeGreaterThan(20);
    expect(commands.filter((p) => !named.has(p) && !isTooling(p))).toEqual([]);
  });

  it('mounts every TUI screen a capability names', () => {
    const routes = new Set((APP_CLI_OPTIONS.tuiScreens ?? []).map((s) => s.route));
    expect(routes.has('android')).toBe(true);
    const missing = CAPABILITIES.flatMap((c) => values(c.tui).filter((r) => !routes.has(r)).map((r) => `${c.id}: ${r}`));
    expect(missing).toEqual([]);
  });
});
