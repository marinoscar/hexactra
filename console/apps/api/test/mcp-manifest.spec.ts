// The MCP tool manifest (#462): every tool's name, title, scope, effect,
// hints and schema hashes, pinned in __snapshots__/mcp-tools.json, and the
// tools table of docs/mcp.md generated from the registry. A change to a tool
// updates both deliberately:
//
//   UPDATE_MCP_MANIFEST=1 npx jest --config ./test/jest.config.js mcp-manifest
//
// Tool names are permanent: a removed or renamed tool fails here whatever the
// snapshot says.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { MCP_EFFECTS, MCP_SCOPES, MCP_SCOPE_IDS } from '../src/mcp/mcp.scopes';
import { MCP_TOOLS, READ_ONLY_TOOLS, toolAnnotations, type McpTool } from '../src/mcp/mcp.tools';
import { connectionTools } from '../src/runner/host/tools/connections';

const SNAPSHOT = join(__dirname, '__snapshots__', 'mcp-tools.json');
const DOC = join(__dirname, '..', '..', '..', 'docs', 'mcp.md');
const START = '<!-- mcp-tools:start -->';
const END = '<!-- mcp-tools:end -->';
const SCOPES_START = '<!-- mcp-scopes:start -->';
const SCOPES_END = '<!-- mcp-scopes:end -->';
const UPDATE = process.env.UPDATE_MCP_MANIFEST === '1';

function hash(schema: z.ZodType | undefined): string | null {
  if (!schema) return null;
  return createHash('sha256').update(JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))).digest('hex').slice(0, 16);
}

interface Entry {
  name: string;
  title: string;
  scope: string;
  effect: string;
  annotations: ReturnType<typeof toolAnnotations>;
  inputSchema: string | null;
  outputSchema: string | null;
}

function entry(t: McpTool): Entry {
  return { name: t.name, title: t.title, scope: t.scope, effect: t.effect, annotations: toolAnnotations(t), inputSchema: hash(t.input), outputSchema: hash(t.output) };
}

function docTable(): string {
  const yes = (b: boolean) => (b ? 'yes' : 'no');
  const rows = MCP_TOOLS.map((t) => `| \`${t.name}\` | ${t.title} | \`${t.scope}\` | ${t.effect} | ${yes(t.openWorld)} | ${yes(t.idempotent ?? false)} | ${t.output ? 'yes' : 'no'} |`);
  return ['| Tool | Title | Scope | Effect | Open world | Idempotent | Structured output |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
}

/** The OAuth scope table of docs/mcp.md, "What a connected app can do" (#459, #460): scope, consent title, risk, default, required scopes, tools, permissions. */
function scopeTable(): string {
  const rows = MCP_SCOPES.map((s) => {
    const tools = MCP_TOOLS.filter((t) => t.scope === s.id).map((t) => `\`${t.name}\``).join(', ');
    const needs = s.requires?.length ? s.requires.map((r) => `\`${r}\``).join(', ') : '—';
    return `| \`${s.id}\` | ${s.title} | ${s.risk} | ${s.default ? 'yes' : 'no'} | ${needs} | ${tools} | ${s.permissions.map((p) => `\`${p}\``).join(', ')} |`;
  });
  return [
    '| Scope | Consent page | Risk | Default | Also needs | Tools | Console permissions |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '| `offline_access` | Stay connected without asking again | — | requested by the client | — | (a refresh token) | none |',
  ].join('\n');
}

/** Replace (or, with UPDATE, rewrite) one generated block of docs/mcp.md. */
function generatedBlock(start: string, end: string, body: string): void {
  const doc = readFileSync(DOC, 'utf8');
  const a = doc.indexOf(start);
  const b = doc.indexOf(end);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  const block = `${start}\n${body}\n${end}`;
  if (UPDATE) writeFileSync(DOC, doc.slice(0, a) + block + doc.slice(b + end.length));
  else expect(doc.slice(a, b + end.length)).toBe(block);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** The 22 tools #462 requires an `outputSchema` for. */
const STRUCTURED = [
  'run_goal', 'run_status', 'runs_list', 'run_cancel', 'tasks_list', 'task_create', 'task_update', 'task_run', 'schedules_list', 'schedule_preview', 'schedule_create',
  'inbox_list', 'ask_human', 'question_status', 'inbox_answer', 'hosts_list', 'policies_list', 'policy_get', 'browser_open', 'browser_tabs', 'browser_elements', 'browser_handoff_status',
];

describe('MCP tool manifest (#462)', () => {
  const current = MCP_TOOLS.map(entry);

  it("offers no connection tool: a hosted AI app does not get the owner's mailbox, calendar or documents through Hexactra (E39.7)", () => {
    const names = new Set(MCP_TOOLS.map((t) => t.name));
    // Neither the agent's own tools (the runner's connection family)...
    expect(connectionTools.map((t) => t.name).filter((n) => names.has(n))).toEqual([]);
    // ...nor any tool that reads or changes mail, a calendar, a drive or a connection.
    expect([...names].filter((n) => /^(mail|calendar|docs|sheet|file_upload|connection)/.test(n))).toEqual([]);
  });

  it('matches the snapshot (UPDATE_MCP_MANIFEST=1 rewrites it), and never loses a tool', () => {
    const pinned = readJson<Entry[]>(SNAPSHOT, []);
    const names = new Set(current.map((e) => e.name));
    // Rule: tool names are permanent (epic #458, "PAT clients must not regress"). Add tools; never rename or remove one.
    const lost = pinned.map((e) => e.name).filter((n) => !names.has(n));
    expect({ rule: 'MCP tool names are permanent: never remove or rename a tool, add a new one instead', lost }).toEqual({ rule: expect.any(String), lost: [] });
    if (UPDATE) writeFileSync(SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`);
    else expect(current).toEqual(pinned);
  });

  it('generates the tools table of docs/mcp.md', () => {
    const doc = readFileSync(DOC, 'utf8');
    const a = doc.indexOf(START);
    const b = doc.indexOf(END);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    const table = `${START}\n${docTable()}\n${END}`;
    if (UPDATE) writeFileSync(DOC, doc.slice(0, a) + table + doc.slice(b + END.length));
    else expect(doc.slice(a, b + END.length)).toBe(table);
  });

  it('generates the OAuth scope table of docs/mcp.md (#459)', () => {
    generatedBlock(SCOPES_START, SCOPES_END, scopeTable());
  });

  it('every scope of the registry is one of MCP_SCOPE_IDS, in the same order, and names a tool (#459)', () => {
    expect(MCP_SCOPES.map((s) => s.id)).toEqual([...MCP_SCOPE_IDS]);
    for (const s of MCP_SCOPES) {
      expect([s.id, MCP_TOOLS.some((t) => t.scope === s.id)]).toEqual([s.id, true]);
      expect([s.id, s.permissions.length > 0]).toEqual([s.id, true]);
    }
    // The default consent is delegation only: no browser, desktop or policy change (epic #458, decision 3). Reading one's own AI usage (#733) is default too.
    expect(MCP_SCOPES.filter((s) => s.default).map((s) => s.id)).toEqual(['runs:read', 'usage:read', 'runs:write', 'tasks:write', 'inbox:read', 'inbox:write']);
    expect(MCP_SCOPES.filter((s) => s.risk === 'high').map((s) => s.id)).toEqual(['browser:evaluate', 'desktop:control', 'policies:write']);
  });

  it('every tool: a name of at most 64, a unique title of at most 40, a description of at most 1,024, a scope and one effect', () => {
    const titles = new Set<string>();
    for (const t of MCP_TOOLS) {
      expect([t.name, /^[a-z][a-z0-9_]{0,63}$/.test(t.name)]).toEqual([t.name, true]);
      expect([t.name, t.title.length <= 40 && t.title.length > 0]).toEqual([t.name, true]);
      expect([t.name, /^[A-Z]/.test(t.title)]).toEqual([t.name, true]);
      expect([t.name, t.description.length <= 1024]).toEqual([t.name, true]);
      expect([t.name, (MCP_SCOPE_IDS as readonly string[]).includes(t.scope)]).toEqual([t.name, true]);
      // One effect per tool: no tool both reads and writes depending on its arguments.
      expect([t.name, (MCP_EFFECTS as readonly string[]).includes(t.effect)]).toEqual([t.name, true]);
      titles.add(t.title);
    }
    expect(titles.size).toBe(MCP_TOOLS.length);
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(MCP_TOOLS.length);
  });

  it('every input property is described, and every output schema is an object', () => {
    for (const t of MCP_TOOLS) {
      const schema = z.toJSONSchema(t.input, { io: 'input' }) as { type: string; properties?: Record<string, { description?: string }> };
      expect(schema.type).toBe('object');
      const undescribed = Object.entries(schema.properties ?? {})
        .filter(([, p]) => !p.description)
        .map(([k]) => k);
      expect([t.name, undescribed]).toEqual([t.name, []]);
      if (t.output) expect([t.name, (z.toJSONSchema(t.output, { io: 'input' }) as { type: string }).type]).toEqual([t.name, 'object']);
    }
  });

  it('derives every hint explicitly from the effect', () => {
    for (const t of MCP_TOOLS) {
      const a = toolAnnotations(t);
      expect(Object.keys(a).sort()).toEqual(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint', 'title']);
      expect([t.name, a.readOnlyHint, a.destructiveHint]).toEqual([t.name, t.effect === 'read', t.effect === 'destructive']);
    }
    expect([...READ_ONLY_TOOLS].sort()).toEqual(MCP_TOOLS.filter((t) => t.effect === 'read').map((t) => t.name).sort());
  });

  it('classifies the tools by the rules of #462', () => {
    const by = (n: string) => MCP_TOOLS.find((t) => t.name === n)!;
    // 70 tools for the model (run_pause and run_resume, E38.2; usage_report, #733; procedures_list, procedure_get and procedure_run, E46.22; site_facts_list and site_fact_propose, E46.35; task_run_batch and batch_status, E51.1; run_diagnostics, task_consistency, task_improvement_request and task_improvement_get, E52.10), plus the widgets' app-only helpers: run_card_poll (#466) and question_card_answer (#467).
    expect(MCP_TOOLS).toHaveLength(72);
    for (const n of ['run_cancel', 'browser_close', 'task_update', 'policy_update', 'policy_set_default', 'policies_import', 'task_pause', 'browser_click', 'browser_type', 'browser_press', 'browser_click_at', 'browser_drag', 'browser_type_keys', 'browser_key', 'browser_evaluate', 'browser_type_secret']) {
      expect([n, by(n).effect]).toEqual([n, 'destructive']);
    }
    for (const t of MCP_TOOLS.filter((x) => x.name.startsWith('browser_desktop_'))) expect([t.name, t.effect]).toEqual([t.name, t.name === 'browser_desktop_screenshot' ? 'read' : 'destructive']);
    for (const n of ['browser_navigate', 'browser_scroll', 'browser_hover_at', 'browser_wait_for', 'browser_back', 'browser_open', 'run_goal', 'task_run', 'ask_human', 'inbox_answer', 'browser_request_human', 'run_pause', 'run_resume', 'procedure_run', 'site_fact_propose']) {
      expect([n, by(n).effect]).toEqual([n, 'write']);
    }
    for (const n of ['policies_export', 'run_export', 'schedule_preview', 'browser_handoff_status', 'browser_screenshot', 'browser_text', 'browser_elements', 'browser_tabs', 'run_diagnostics', 'task_consistency', 'task_improvement_get']) expect([n, by(n).effect]).toEqual([n, 'read']);
    // Proposals (E52.10): asking for one writes a proposal row only; nothing applies, dismisses or approves.
    expect([by('task_improvement_request').effect, by('task_improvement_request').scope]).toEqual(['write', 'tasks:write']);
    expect(MCP_TOOLS.filter((t) => /improvement/.test(t.name) && /apply|approve|dismiss/.test(t.name))).toEqual([]);
    for (const t of MCP_TOOLS) {
      const web = t.name.startsWith('browser_') || t.name === 'run_goal' || t.name === 'task_run' || t.name === 'task_run_batch' || t.name === 'procedure_run';
      expect([t.name, t.openWorld]).toEqual([t.name, web]);
      const idem = t.effect === 'read' || ['task_pause', 'task_resume', 'policy_set_default', 'run_cancel', 'run_pause', 'run_resume', 'browser_close', 'site_fact_propose'].includes(t.name);
      expect([t.name, t.idempotent ?? false]).toEqual([t.name, idem]);
    }
    // Read tools sit in a read scope; policies_export only reads, so it is runs:read (not policies:write).
    expect(by('policies_export').scope).toBe('runs:read');
    expect(by('browser_evaluate').scope).toBe('browser:evaluate');
  });

  it('the learned-procedure tools (E46.22): from the package descriptors, behind the Knowledge Graph switch, and nothing that changes a procedure or a switch', () => {
    const kg = MCP_TOOLS.filter((t) => t.feature === 'kgraph');
    expect(kg.map((t) => [t.name, t.scope, t.effect, t.openWorld])).toEqual([
      ['procedures_list', 'procedures:read', 'read', false],
      ['procedure_get', 'procedures:read', 'read', false],
      ['procedure_run', 'procedures:run', 'write', true],
      ['site_facts_list', 'site_facts:read', 'read', false],
      ['site_fact_propose', 'site_facts:write', 'write', false],
    ]);
    // Every other tool is always available.
    expect(MCP_TOOLS.filter((t) => t.feature !== undefined && t.feature !== 'kgraph')).toEqual([]);
    // Never over MCP: creating, editing, approving, declining, restoring, forgetting, exporting or importing a procedure, or a switch.
    expect(MCP_TOOLS.map((t) => t.name).filter((n) => /(^|_)(procedures?|kgraph|reviews?)(_|$)/.test(n) && !['procedures_list', 'procedure_get', 'procedure_run'].includes(n))).toEqual([]);
    expect(MCP_SCOPES.filter((s) => s.id.startsWith('procedures:')).map((s) => [s.id, s.default])).toEqual([['procedures:read', false], ['procedures:run', false]]);
  });

  it('the site-fact tools (E46.35): one reads (untrusted), one proposes; nothing approves, edits, archives or deletes a fact', () => {
    expect(MCP_TOOLS.map((t) => t.name).filter((n) => /site_?facts?/.test(n))).toEqual(['site_facts_list', 'site_fact_propose']);
    expect(MCP_SCOPES.filter((s) => s.id.startsWith('site_facts:')).map((s) => [s.id, s.default, s.permissions])).toEqual([
      ['site_facts:read', false, ['kgraph:read']],
      ['site_facts:write', false, ['kgraph:write']],
    ]);
  });

  it('declares an output schema for the 22 tools #462 lists', () => {
    for (const n of STRUCTURED) expect([n, Boolean(MCP_TOOLS.find((t) => t.name === n)?.output)]).toEqual([n, true]);
  });
});
