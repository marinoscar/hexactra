// What the "Connect an AI app" guide (/settings/ai-apps/connect, #464) tells
// people, per client. ONE source on purpose (#468): the in-app guide renders
// it, and the "Steps" section of console/docs/hosted-clients.md is generated
// from it by `npm run docs:hosted-clients` (renderGuidesMarkdown below);
// src/__tests__/hostedClientsDoc.test.ts fails when the two differ.
//
// The menu paths are the vendors', read from their published documentation
// on GUIDE_CHECKED's date, not yet from the live clients (the acceptance
// runbook, console/docs/hosted-clients-acceptance.md, records that). OpenAI's
// documentation could not be read when this was written: the ChatGPT labels
// are marked "verify on screen". `{url}` in a step is the console's MCP URL.
//
// No imports but a type: scripts/hosted-clients-doc.mjs loads this file
// directly with Node's type stripping.
import type { ConnectClientId } from '../aiApps/types';

export interface ConnectGuide {
  id: ConnectClientId;
  /** The tab's label. */
  label: string;
  /** One sentence under the tab: what this client is. */
  intro: string;
  /** Who can add a custom connector on the vendor's side (as documented; no plan prices). */
  whoCanAdd: string;
  /** Numbered steps; `{url}` is the console's MCP URL. */
  steps: string[];
  /** A command to copy instead of steps (Claude Code), with `{url}`. */
  command?: string;
  /** What the consent page on the console asks. */
  consent: string;
  /** What to try first, once connected. */
  tryFirst: string;
  /** Three first prompts, and what a good answer looks like. */
  firstPrompts: { prompt: string; good: string }[];
  /** Where it signs in from: a host the administrator allows, or the user's own computer. */
  signsInFrom: string;
}

/** When the steps were last checked, and against what. */
export const GUIDE_CHECKED = 'docs as of 2026-11-18; not yet verified on the live client';

export const CONSENT_TEXT =
  'Your console opens a page that names the app and lists what it asks to do. "Give goals to your Hexactra agent", "Runs, tasks and schedules" and "Questions" are ticked by default. Driving a browser yourself, running JavaScript, controlling the desktop and changing agent policies are separate boxes: leave them unticked unless you need them; the app can ask again later.';

export const TRY_FIRST = 'Ask it: "Use Hexactra to find the opening hours of the public library near me." It hands the goal to your agent, shows its progress and relays any question the agent asks you.';

const PROMPTS: ConnectGuide['firstPrompts'] = [
  { prompt: 'What can you do with Hexactra?', good: 'It lists giving goals to your agent, following runs, tasks and schedules, and answering the agent\'s questions. With the default boxes it does not offer to click or type in a browser itself.' },
  { prompt: 'Use Hexactra to find the opening hours of the public library in <your town>.', good: 'It starts a run, reports what the agent is doing, shows or describes a screenshot, relays a question if the agent asks one, and ends with the hours and a link to the run in your console ("Started by" names the app).' },
  { prompt: 'Which of my Hexactra tasks run on a schedule, and when do they run next?', good: 'A short list of your tasks with their next run times, read from your console; nothing is started or changed.' },
];

export const CONNECT_GUIDES: readonly ConnectGuide[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    intro: 'ChatGPT on the web, desktop and phone, through a custom MCP connector (developer mode).',
    whoCanAdd: 'A plan and role that may use developer mode and create custom connectors; in a workspace, an administrator may have to allow it first. See OpenAI\'s help pages for the current list.',
    steps: [
      'Open ChatGPT in a browser and sign in.',
      'Open Settings → Apps & Connectors → Advanced settings and turn on Developer mode (labels: verify on screen; an administrator may have to allow it for a workspace).',
      'Go back to Apps & Connectors and choose Create (or "Add custom connector"; verify on screen).',
      'Name it "Hexactra", paste {url} as the MCP server URL and choose OAuth as the authentication.',
      'Save, then choose Connect: ChatGPT opens your console to sign in.',
      'Sign in to your console if asked, check what ChatGPT asks to do, and choose Allow.',
      'In a new chat, open the + menu (or Developer mode tools) and switch Hexactra on (verify on screen).',
    ],
    consent: CONSENT_TEXT,
    tryFirst: TRY_FIRST,
    firstPrompts: PROMPTS,
    signsInFrom: 'chatgpt.com',
  },
  {
    id: 'claude',
    label: 'Claude',
    intro: 'Claude on the web, the desktop app and the phone app: one connector, added on the web or the desktop app, serves all of them.',
    whoCanAdd: 'Free (one custom connector), Pro, Max and Ultra: you add it to your own account. Team and Enterprise: an Owner adds it under Organization settings → Connectors, then each member connects.',
    steps: [
      'Open claude.ai (or the Claude desktop app) and sign in.',
      'Go to Customize → Connectors, choose Add, then "Add custom connector". (Team and Enterprise: an Owner goes to Organization settings → Connectors, chooses Add, then Custom, and Web if asked.)',
      'Name it "Hexactra", paste {url} as the remote MCP server URL, then choose Continue.',
      'Keep the authentication settings Claude marks Detected ("Sign in now" or "Sign in when needed", and "Use Claude\'s published identity" as the OAuth client). Leave Request headers empty.',
      'Choose Add, then Connect: Claude opens your console to sign in.',
      'Sign in to your console if asked, check what Claude asks to do, and choose Allow.',
      'In a chat, choose + → Connectors and make sure Hexactra is on.',
    ],
    consent: CONSENT_TEXT,
    tryFirst: TRY_FIRST,
    firstPrompts: PROMPTS,
    signsInFrom: 'claude.ai',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    intro: 'Claude Code in your terminal. It signs in through a page on your own computer and identifies itself with a document on claude.ai, so claude.ai must be allowed.',
    whoCanAdd: 'Anyone who runs Claude Code; no administrator on the vendor side.',
    command: 'claude mcp add --transport http hexactra {url}',
    steps: [
      'Run the command below in a terminal (add --scope user to use it in every project).',
      'Start Claude Code and type /mcp, choose hexactra, then Authenticate: your browser opens your console.',
      'Sign in to your console if asked, check what Claude Code asks to do, and choose Allow.',
      'Back in the terminal, /mcp shows hexactra as connected. Without OAuth, use a personal access token instead: claude mcp add --transport http hexactra {url} --header "Authorization: Bearer <token>".',
    ],
    consent: CONSENT_TEXT,
    tryFirst: TRY_FIRST,
    firstPrompts: PROMPTS,
    signsInFrom: 'claude.ai (its client document) and your computer (a loopback page)',
  },
  {
    id: 'other',
    label: 'Other MCP client',
    intro: 'Any client that speaks MCP over Streamable HTTP: with OAuth when it supports it, or with a personal access token.',
    whoCanAdd: 'Whoever configures the client.',
    steps: [
      'With OAuth: give the client {url} and nothing else. It finds the sign-in on its own, opens your console and asks you to allow it. An administrator must allow the host it signs in from (Administration → OAuth clients).',
      'With a personal access token: create one in Settings → Access tokens, then configure the client with {url} and the header "Authorization: Bearer <token>". A token has all of your permissions and every tool; keep it secret.',
      'Agent frameworks (Hermes Agent, OpenClaw, Pi) have ready-made recipes in docs/agent-frameworks.md.',
    ],
    consent: CONSENT_TEXT,
    tryFirst: TRY_FIRST,
    firstPrompts: PROMPTS,
    signsInFrom: 'the client\'s own host',
  },
];

/** The steps with the MCP URL filled in. */
export function stepsFor(guide: ConnectGuide, url: string): string[] {
  return guide.steps.map((s) => s.replaceAll('{url}', url));
}

/** Where the agent-framework recipes live (console/docs/agent-frameworks.md). */
export const AGENT_FRAMEWORKS_DOC_URL = 'https://github.com/marinoscar/hexactra/blob/main/console/docs/agent-frameworks.md';

/** The full recipes, troubleshooting and the acceptance runbook (console/docs/hosted-clients.md). */
export const HOSTED_CLIENTS_DOC_URL = 'https://github.com/marinoscar/hexactra/blob/main/console/docs/hosted-clients.md';

/** The URL the generated documentation shows in place of `{url}`. */
export const DOC_MCP_URL = 'https://<console>/api/mcp';

/** One sentence of the guide as Markdown: `<…>` placeholders escaped (GitHub would drop them as tags), `{url}` as code. */
export function guideTextMarkdown(s: string): string {
  return s.replaceAll('<', '&lt;').replaceAll('{url}', `\`${DOC_MCP_URL}\``);
}

/**
 * The guides as Markdown: the generated "Steps" section of
 * console/docs/hosted-clients.md. Same text as the app.
 */
export function renderGuidesMarkdown(): string {
  const md = guideTextMarkdown;
  const out: string[] = [];
  for (const g of CONNECT_GUIDES) {
    out.push(`### ${g.label}`, '', md(g.intro), '', `Version checked: ${GUIDE_CHECKED}.`, '', `**Who can add it:** ${md(g.whoCanAdd)}`, '', `**Signs in from:** ${md(g.signsInFrom)}`, '');
    if (g.command) out.push('```bash', g.command.replaceAll('{url}', DOC_MCP_URL), '```', '');
    g.steps.forEach((s, i) => out.push(`${i + 1}. ${md(s)}`));
    out.push('', `**What your console will ask.** ${md(g.consent)}`, '', '**First prompts to try:**', '');
    for (const p of g.firstPrompts) out.push(`- "${md(p.prompt)}" A good answer: ${md(p.good)}`);
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
