// The card's view of its host. One implementation over the MCP Apps SDK's
// `App` (src/main.tsx); the tests use a mock. Everything goes through the
// host: the card makes no network request of its own (CSP: none allowed).
import type { AllowedTool, ToolResultLike } from './model';

/** The host context fields the card uses (`McpUiHostContext`). */
export interface HostContextLike {
  theme?: 'light' | 'dark';
  styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } };
  toolInfo?: { id?: string | number; tool?: { name?: string } };
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
  platform?: 'web' | 'desktop' | 'mobile';
}

export interface HostBridge {
  /** A server tool through the host (`tools/call`); only {@link AllowedTool}s. Rejects when the host or the server refuses. */
  callTool(name: AllowedTool, args: Record<string, unknown>): Promise<ToolResultLike>;
  /** Ask the host to open a URL (`ui/open-link`); the host may confirm with the user first. */
  openLink(url: string): Promise<void>;
  /** Send a user message to the conversation (`ui/message`). */
  sendMessage(text: string): Promise<void>;
  /** The host context at connect time. */
  hostContext(): HostContextLike | undefined;
  /** The tool result that opened this card, and any later one the host pushes. */
  onToolResult(cb: (r: ToolResultLike) => void): void;
  /** The arguments of the tool call that opened this card. */
  onToolInput(cb: (args: Record<string, unknown>) => void): void;
  /** Changes to the host context (theme, styles, insets). */
  onHostContextChanged(cb: (c: HostContextLike) => void): void;
}
