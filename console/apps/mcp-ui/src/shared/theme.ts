// The host's theme on a widget (#466, #467): the same three steps as the
// MCP Apps SDK's `applyDocumentTheme`, `applyHostStyleVariables` and
// `applyHostFonts`, written here so the widgets that do not load the SDK
// apply them identically.
import type { HostContextLike } from './bridge';

export function applyHostContext(c: HostContextLike | undefined): void {
  if (!c || typeof document === 'undefined') return;
  const root = document.documentElement;
  if (c.theme === 'light' || c.theme === 'dark') {
    root.setAttribute('data-theme', c.theme);
    root.style.colorScheme = c.theme;
  }
  for (const [k, v] of Object.entries(c.styles?.variables ?? {})) if (v !== undefined) root.style.setProperty(k, v);
  const fonts = c.styles?.css?.fonts;
  if (fonts && !document.getElementById('__mcp-host-fonts')) {
    const s = document.createElement('style');
    s.id = '__mcp-host-fonts';
    s.textContent = fonts;
    document.head.appendChild(s);
  }
}

/** The theme name and the safe-area padding a widget's root takes from the context. */
export function frameOf(ctx: HostContextLike | undefined): { theme: 'light' | 'dark'; style?: Record<string, number> } {
  const insets = ctx?.safeAreaInsets;
  return {
    theme: ctx?.theme === 'dark' ? 'dark' : 'light',
    ...(insets ? { style: { paddingTop: insets.top, paddingRight: insets.right, paddingBottom: insets.bottom, paddingLeft: insets.left } } : {}),
  };
}
