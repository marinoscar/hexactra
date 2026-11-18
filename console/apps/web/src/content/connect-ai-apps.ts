// What the "Connect an AI app" guide (/settings/ai-apps/connect, #464) tells
// people, per client. ONE file on purpose: E33.10 (#468) re-checks every step
// against the real ChatGPT, Claude and Claude Code and edits only this file,
// and the user documentation (console/docs/mcp.md) quotes it.
//
// The menu paths are the vendors' as the epic (#458, "Client facts") recorded
// them; the ChatGPT path in particular has moved between releases. `{url}`
// in a step is replaced by the console's MCP URL.
import type { ConnectClientId } from '../aiApps/types';

export interface ConnectGuide {
  id: ConnectClientId;
  /** The tab's label. */
  label: string;
  /** One sentence under the tab: what this client is. */
  intro: string;
  /** Numbered steps; `{url}` is the console's MCP URL. */
  steps: string[];
  /** A command to copy instead of steps (Claude Code), with `{url}`. */
  command?: string;
  /** What the consent page on the console asks. */
  consent: string;
  /** What to try first, once connected. */
  tryFirst: string;
  /** Where it signs in from: a host the administrator allows, or the user's own computer. */
  signsInFrom: string;
}

export const CONSENT_TEXT =
  'Your console opens a page that names the app and lists what it asks to do. "Give goals to your Hexactra agent", "Runs, tasks and schedules" and "Questions" are ticked by default. Driving a browser yourself, running JavaScript, controlling the desktop and changing agent policies are separate boxes: leave them unticked unless you need them; the app can ask again later.';

export const TRY_FIRST = 'Ask it: "Use Hexactra to find the opening hours of the public library near me." It hands the goal to your agent, shows its progress and relays any question the agent asks you.';

export const CONNECT_GUIDES: readonly ConnectGuide[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    intro: 'ChatGPT on the web, desktop and phone, through a custom MCP connector (developer mode).',
    steps: [
      'Open ChatGPT in a browser and sign in.',
      'Open Settings → Apps & Connectors → Advanced settings and turn on Developer mode (an administrator may have to allow it for a workspace).',
      'Go back to Apps & Connectors and choose Create (or "Add custom connector").',
      'Name it "Hexactra", paste {url} as the MCP server URL and choose OAuth as the authentication.',
      'Save, then choose Connect: ChatGPT opens your console to sign in.',
      'Sign in to your console if asked, check what ChatGPT asks to do, and choose Allow.',
      'In a new chat, open the + menu (or Developer mode tools) and switch Hexactra on.',
    ],
    consent: CONSENT_TEXT,
    tryFirst: TRY_FIRST,
    signsInFrom: 'chatgpt.com',
  },
  {
    id: 'claude',
    label: 'Claude',
    intro: 'Claude on the web, the desktop app and the phone app (one connector serves all of them).',
    steps: [
      'Open claude.ai (or the Claude desktop app) and sign in.',
      'Open Settings → Connectors (Customize → Connectors on some plans) and choose "Add custom connector".',
      'Name it "Hexactra" and paste {url} as the remote MCP server URL. Leave the advanced OAuth fields empty.',
      'Choose Add, then Connect: Claude opens your console to sign in.',
      'Sign in to your console if asked, check what Claude asks to do, and choose Allow.',
      'In a chat, open the tools menu (the sliders icon) and make sure Hexactra is on.',
    ],
    consent: CONSENT_TEXT,
    tryFirst: TRY_FIRST,
    signsInFrom: 'claude.ai',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    intro: 'Claude Code in your terminal. It signs in through a page on your own computer, so no host has to be allowed.',
    command: 'claude mcp add --transport http hexactra {url}',
    steps: [
      'Run the command below in a terminal (add --scope user to use it in every project).',
      'Start Claude Code and type /mcp, choose hexactra, then Authenticate: your browser opens your console.',
      'Sign in to your console if asked, check what Claude Code asks to do, and choose Allow.',
      'Back in the terminal, /mcp shows hexactra as connected.',
    ],
    consent: CONSENT_TEXT,
    tryFirst: TRY_FIRST,
    signsInFrom: 'your computer (loopback)',
  },
  {
    id: 'other',
    label: 'Other MCP client',
    intro: 'Any client that speaks MCP over Streamable HTTP: with OAuth when it supports it, or with a personal access token.',
    steps: [
      'With OAuth: give the client {url} and nothing else. It finds the sign-in on its own, opens your console and asks you to allow it. An administrator must allow the host it signs in from (Administration → OAuth clients).',
      'With a personal access token: create one in Settings → Access tokens, then configure the client with {url} and the header "Authorization: Bearer <token>". A token has all of your permissions and every tool; keep it secret.',
      'Agent frameworks (Hermes Agent, OpenClaw, Pi) have ready-made recipes in docs/agent-frameworks.md.',
    ],
    consent: CONSENT_TEXT,
    tryFirst: TRY_FIRST,
    signsInFrom: 'the client\'s own host',
  },
];

/** The steps with the MCP URL filled in. */
export function stepsFor(guide: ConnectGuide, url: string): string[] {
  return guide.steps.map((s) => s.replaceAll('{url}', url));
}

/** Where the agent-framework recipes live (console/docs/agent-frameworks.md). */
export const AGENT_FRAMEWORKS_DOC_URL = 'https://github.com/marinoscar/hexactra/blob/main/console/docs/agent-frameworks.md';
