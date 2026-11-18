// The entry of a widget that talks to its host through the small bridge
// (src/shared/lite-host.ts): connect, apply the host's theme, render.
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import type { HostBridge } from './bridge';
import { LiteHost, windowPort } from './lite-host';
import { applyHostContext } from './theme';

export function mountWidget<T extends string>(info: { name: string; version: string }, allowed: readonly T[], render: (host: HostBridge<T>) => ReactNode): void {
  const port = windowPort() ?? { post: () => undefined, listen: () => () => undefined };
  const host = new LiteHost<T>(info, port, { allowed });
  host.onHostContextChanged(applyHostContext);
  const root = createRoot(document.getElementById('root')!);
  // Handlers are registered by the widget on its first render, before the handshake ends: no result is missed (the bridge also keeps early ones).
  root.render(render(host));
  host
    .connect()
    .then(() => applyHostContext(host.hostContext()))
    .catch(() => {
      // Not inside an MCP Apps host: the widget stays on its loading state.
    });
}
