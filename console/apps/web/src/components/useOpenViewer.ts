import { useCallback } from 'react';
import { usePlatformHost } from '@marinoscar/platform-web/core';

/**
 * Opens a question's browser viewer in a new tab. The bundled local viewer
 * (`/viewer/local/`) needs a short-lived ticket first; the tab is opened
 * before the request so a popup blocker lets it through.
 */
export function useOpenViewer(onError: (message: string) => void): (viewerUrl: string) => Promise<void> {
  const { api } = usePlatformHost();
  return useCallback(
    async (viewerUrl: string) => {
      if (!viewerUrl.includes('/viewer/local/')) return void window.open(viewerUrl, '_blank', 'noopener');
      const tab = window.open('', '_blank');
      try {
        const { url } = await api.post<{ url: string }>('/fleet/viewer-ticket', {});
        if (tab) tab.location.href = url;
      } catch (e) {
        tab?.close();
        onError(e instanceof Error ? e.message : 'Could not open the viewer');
      }
    },
    [api, onError],
  );
}
