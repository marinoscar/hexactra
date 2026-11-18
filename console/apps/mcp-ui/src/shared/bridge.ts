// A widget's view of its host (#466, #467). Two implementations: the MCP
// Apps SDK's `App` (the run card, src/main.tsx) and the small postMessage
// bridge (src/shared/lite-host.ts, the question and tasks cards); the tests
// use a mock. Everything goes through the host: a widget makes no network
// request of its own (CSP: none allowed).
import type { ToolResultLike } from './text';

/** The host context fields the widgets use (`McpUiHostContext`). */
export interface HostContextLike {
  theme?: 'light' | 'dark';
  styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } };
  toolInfo?: { id?: string | number; tool?: { name?: string } };
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
  platform?: 'web' | 'desktop' | 'mobile';
}

export interface HostBridge<T extends string = string> {
  /** A server tool through the host (`tools/call`); only the widget's allowed tools. Rejects when the host refuses (an error *result* resolves, with `isError`). */
  callTool(name: T, args: Record<string, unknown>): Promise<ToolResultLike>;
  /** Ask the host to open a URL (`ui/open-link`); the host may confirm with the user first. */
  openLink(url: string): Promise<void>;
  /** Send a user message to the conversation (`ui/message`). */
  sendMessage(text: string): Promise<void>;
  /** The host context at connect time. */
  hostContext(): HostContextLike | undefined;
  /** The tool result that opened this widget, and any later one the host pushes. */
  onToolResult(cb: (r: ToolResultLike) => void): void;
  /** The arguments of the tool call that opened this widget. */
  onToolInput(cb: (args: Record<string, unknown>) => void): void;
  /** Changes to the host context (theme, styles, insets). */
  onHostContextChanged(cb: (c: HostContextLike) => void): void;
}

/** The longest message a widget sends to the conversation (hosts cap `ui/message`; a short one is all it needs). */
export const MAX_MESSAGE_CHARS = 300;
