// The run card's entry: the MCP Apps SDK's App, connected with no transport
// argument (the SDK finds the host), wrapped as the card's HostBridge.
import { App, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { createRoot } from 'react-dom/client';

import type { HostBridge, HostContextLike } from './bridge';
import { MAX_MESSAGE_CHARS } from './shared/bridge';
import { ALLOWED_TOOLS, type ToolResultLike } from './model';
import { version } from '../package.json';
import { RunCard } from './RunCard';
import { applyHostContext } from './shared/theme';
import './styles.css';

const app = new App({ name: 'Hexactra run card', version }, {});

/** The host's theme, style variables and fonts (src/shared/theme.ts: the SDK's three helpers, shared with the other cards). */
function applyContext(c: McpUiHostContext | undefined): void {
  applyHostContext(c as HostContextLike | undefined);
}

// Handlers before connect(), so the first tool input and result are not missed;
// the card subscribes later and gets what arrived before it.
const results: ToolResultLike[] = [];
let resultCb: ((r: ToolResultLike) => void) | null = null;
let contextCb: ((c: HostContextLike) => void) | null = null;
app.ontoolresult = (r) => {
  if (resultCb) resultCb(r as ToolResultLike);
  else results.push(r as ToolResultLike);
};
app.onhostcontextchanged = (c) => {
  applyContext(c);
  contextCb?.(c as HostContextLike);
};

const bridge: HostBridge = {
  async callTool(name, args) {
    if (!(ALLOWED_TOOLS as readonly string[]).includes(name)) throw new Error('not an allowed tool');
    return (await app.callServerTool({ name, arguments: args })) as ToolResultLike;
  },
  async openLink(url) {
    const r = await app.openLink({ url });
    if (r?.isError) throw new Error('the host did not open the link');
  },
  async sendMessage(text) {
    const t = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
    const r = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: t }] });
    if (r?.isError) throw new Error('the host did not send the message');
  },
  hostContext: () => app.getHostContext() as HostContextLike | undefined,
  onToolResult(cb) {
    resultCb = cb;
    for (const r of results.splice(0)) cb(r);
  },
  onToolInput() {
    // The card reads the run from the result; the arguments are not needed.
  },
  onHostContextChanged(cb) {
    contextCb = cb;
  },
};

async function main(): Promise<void> {
  try {
    await app.connect();
  } catch {
    // Not inside an MCP Apps host: the card stays on its loading state.
  }
  applyContext(app.getHostContext());
  createRoot(document.getElementById('root')!).render(<RunCard host={bridge} />);
}

void main();
