// The OAuth scopes of the console's MCP tools (epic #458, "Scopes"). Every
// tool names exactly one scope (`McpTool.scope`). E33.1 (#459) registers them
// with the platform's OAuth server (mcp.oauth.ts) as named bundles of the
// console's EXISTING permissions: a token's permissions are its user's,
// intersected with its scopes', and every tool calls the REST routes behind
// it as that narrowed principal. E33.2 adds the finer gate (a tool is offered
// and callable only with its scope); personal access tokens and sessions keep
// every tool. This file is pure data: no registration happens on import.
import type { OAuthScopeRisk } from '@marinoscar/platform-api/identity';

/** Every scope a tool may name, in consent order (low risk first). */
export const MCP_SCOPE_IDS = ['runs:read', 'usage:read', 'runs:write', 'tasks:write', 'inbox:read', 'inbox:write', 'procedures:read', 'procedures:run', 'site_facts:read', 'site_facts:write', 'browser:drive', 'browser:evaluate', 'desktop:control', 'policies:write'] as const;
export type McpScope = (typeof MCP_SCOPE_IDS)[number];

/**
 * The scopes the widgets read (`granted_scopes` of a card's result, #467), in consent order: every scope before E46.22. The learned-procedure and site-fact
 * scopes are not among them (no card uses them), so the cards' output schemas and answers are unchanged.
 */
export const MCP_CARD_SCOPE_IDS = ['runs:read', 'usage:read', 'runs:write', 'tasks:write', 'inbox:read', 'inbox:write', 'browser:drive', 'browser:evaluate', 'desktop:control', 'policies:write'] as const satisfies readonly McpScope[];
export type McpCardScope = (typeof MCP_CARD_SCOPE_IDS)[number];

/** The id of the protected resource `/api/mcp` (an `oat_` token's audience). */
export const MCP_OAUTH_RESOURCE_ID = 'mcp';

/** Where people read about the MCP endpoint: the resource's `resource_documentation`. */
export const MCP_DOCS_URL = 'https://github.com/marinoscar/hexactra/blob/main/console/docs/mcp.md';

/**
 * Hosts the admin "OAuth clients" card SUGGESTS (nothing is allowed until an
 * administrator accepts them): Claude's metadata documents and its web
 * redirect are on `claude.ai`, ChatGPT's redirect on `chatgpt.com`. E33.10
 * re-verifies them against the real clients.
 */
export const MCP_SUGGESTED_CLIENT_HOSTS: readonly string[] = ['claude.ai', 'chatgpt.com'];

/** One scope as the consent page shows it and the console grants it. */
export interface McpScopeDefinition {
  id: McpScope;
  /** The consent page's line. */
  title: string;
  /** The consent page's sentence (the epic's consent text). */
  description: string;
  risk: OAuthScopeRisk;
  /** Requested when a client asks for no scope; ticked by default. */
  default: boolean;
  /**
   * The console permissions the scope grants: exactly those the `@Auth({ permissions })`
   * of the REST routes its tools call require (docs/mcp.md, "OAuth scopes").
   */
  permissions: readonly string[];
  /**
   * Scopes a token must ALSO hold for this scope's tools (#460): running
   * JavaScript and controlling the desktop happen inside a browser session,
   * so both need `browser:drive` too.
   */
  requires?: readonly McpScope[];
}

/**
 * The scope table (epic #458). Where one permission covers a default scope's
 * tools and an opt-in scope's (`runs:write` is behind `POST /api/runs` and
 * behind every browser and desktop action of `/api/browser/sessions`), the
 * permission is NOT split here (#459): the opt-in scopes list it too, and
 * E33.2's tool gate draws the finer line (a token without `browser:drive` is
 * neither offered nor allowed a `browser_*` tool).
 */
export const MCP_SCOPES: readonly McpScopeDefinition[] = [
  {
    id: 'runs:read',
    title: 'See your runs, tasks, schedules and machines',
    description: 'See your runs, tasks, schedules and machines, and the agent policies you can use.',
    risk: 'low',
    default: true,
    // runs and screenshots; tasks, schedules and the schedule preview; machines; policies and their export.
    permissions: ['runs:read', 'tasks:read', 'fleet:read', 'agent_policies:read'],
  },
  {
    id: 'usage:read',
    title: 'See your AI usage and cost',
    description: 'See how many AI tokens your account used and what they cost, by day, month and model.',
    risk: 'low',
    default: true,
    // GET /usage/report (#733): the caller's own usage only.
    permissions: ['usage:read'],
  },
  {
    id: 'runs:write',
    title: 'Give goals to your Hexactra agent, start and stop runs',
    description: 'Give goals to your Hexactra agent, run your tasks, and stop runs. It can follow the runs it starts.',
    risk: 'low',
    default: true,
    // POST /runs, /tasks/:id/runs, /runs/:id/cancel; the started run is read back (GET /runs/:id).
    permissions: ['runs:write', 'runs:read'],
  },
  {
    id: 'tasks:write',
    title: 'Create and change tasks and schedules',
    description: 'Create and change your tasks, and add, pause and resume their schedules.',
    risk: 'low',
    default: true,
    permissions: ['tasks:write'],
  },
  {
    id: 'inbox:read',
    title: 'See questions your agent is waiting on',
    description: 'See the questions your agent is waiting on and whether they were answered.',
    risk: 'low',
    default: true,
    // GET /inbox, /questions, /questions/:id
    permissions: ['runs:read'],
  },
  {
    id: 'inbox:write',
    title: 'Ask you questions and pass on answers you give in the chat',
    description: 'Ask you questions on behalf of an agent, and pass on the answers you give in the chat. Secrets are only ever answered on the console.',
    risk: 'low',
    default: true,
    // POST /questions, /questions/:id/answer, /inbox/:runId/respond (and the question is read back).
    permissions: ['runs:write', 'runs:read'],
  },
  {
    id: 'procedures:read',
    title: 'See the procedures the agent learned',
    description: 'See the procedures your Hexactra agent learned from your saved tasks: their parameters, outputs, state and masked steps.',
    risk: 'low',
    // Opt-in (E46.22): the Knowledge Graph is off by default, and its tools are offered only while it is on for the deployment and the user.
    default: false,
    // GET /kgraph/procedures, /kgraph/procedures/:id.
    permissions: ['kgraph:read'],
  },
  {
    id: 'procedures:run',
    title: 'Run a learned procedure',
    description: 'Run one of the procedures your agent learned, with the values you give it. The run follows your limits and asks you what it must.',
    risk: 'low',
    default: false,
    // GET /kgraph/procedures/:id, /tasks/:id/kgraph; POST /tasks/:id/runs (the run start path every run uses).
    permissions: ['kgraph:read', 'runs:write', 'runs:read'],
  },
  {
    id: 'site_facts:read',
    title: 'See the facts your agent keeps about sites',
    description: 'See the short notes your Hexactra agent keeps about the sites you use (where things are, how a site signs in), with their status and last use.',
    risk: 'low',
    // Opt-in (E46.35): offered only while the Knowledge Graph is on for the deployment and the user.
    default: false,
    // GET /kgraph/sites, /kgraph/sites/:site/facts.
    permissions: ['kgraph:read'],
  },
  {
    id: 'site_facts:write',
    title: 'Propose facts about sites for you to review',
    description: 'Propose a short note about a site. It waits for you to approve it in Hexactra and is never used by a run before you do.',
    risk: 'low',
    default: false,
    // POST /kgraph/sites/:site/facts/proposals (always stored proposed; approving is console-only).
    permissions: ['kgraph:write'],
  },
  {
    id: 'browser:drive',
    title: 'Control a browser on your machines directly, step by step',
    description: 'Open a browser on your machines and click, type, scroll, read pages and take screenshots, step by step.',
    risk: 'elevated',
    default: false,
    // /browser/sessions: open, actions, handoffs, close (runs:write); screenshots and handoff status (runs:read).
    permissions: ['runs:write', 'runs:read'],
  },
  {
    id: 'browser:evaluate',
    title: 'Run JavaScript in pages you are signed in to',
    description: 'Run any JavaScript in the pages of your browsers, with your sign-ins. Needs browser control as well.',
    risk: 'high',
    default: false,
    // POST /browser/sessions/:id/actions (`evaluate`).
    permissions: ['runs:write'],
    requires: ['browser:drive'],
  },
  {
    id: 'desktop:control',
    title: 'Control the whole desktop of your machines (mouse, keyboard, screen)',
    description: 'See the whole screen of your machines and use their mouse and keyboard, outside the browser too. Needs browser control as well.',
    risk: 'high',
    default: false,
    // POST /browser/sessions/:id/actions (`desktop_*`); screenshots (runs:read).
    permissions: ['runs:write', 'runs:read'],
    requires: ['browser:drive'],
  },
  {
    id: 'policies:write',
    title: 'Change spending limits and model choices for your agent',
    description: 'Create, change and import agent policies (spending limits and model choices) and choose your default policy.',
    risk: 'high',
    default: false,
    // POST/PATCH /agent-policies, PUT /agent-policies/default, POST /agent-policies/import.
    permissions: ['agent_policies:write'],
  },
];

/** A scope's definition; undefined for a string that is not one of the console's scopes (ignored, never thrown on). */
export function mcpScope(id: string): McpScopeDefinition | undefined {
  return MCP_SCOPES.find((s) => s.id === id);
}

/** Every scope a token needs for a tool of `scope`: the scope itself, then what it requires, without repeats. */
export function scopeWithRequirements(scope: McpScope): McpScope[] {
  return [...new Set<McpScope>([scope, ...(mcpScope(scope)?.requires ?? [])])];
}

/** What a tool does to the user's things: the source of the MCP hints. */
export const MCP_EFFECTS = ['read', 'write', 'destructive'] as const;
export type McpEffect = (typeof MCP_EFFECTS)[number];

/**
 * The scopes the caller holds, for a widget that shows an action only when
 * it may be used (#467: Run, Pause, answering). A credential that carries
 * scopes (an OAuth token, from E33.2 on) lists them; a personal access token
 * or a session holds every scope. Display only: every call is still checked
 * by the server.
 */
export function grantedScopes(credential: { scopes?: readonly string[] } | undefined): McpCardScope[] {
  const held = credential?.scopes;
  if (!held) return [...MCP_CARD_SCOPE_IDS];
  return MCP_CARD_SCOPE_IDS.filter((s) => held.includes(s));
}
