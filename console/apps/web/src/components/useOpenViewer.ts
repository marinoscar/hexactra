import { useCallback } from 'react';

/**
 * Opens a question's browser view: a host's desktop page in this console
 * (#343) in the same tab, any other link in a new tab.
 */
export function useOpenViewer(_onError: (message: string) => void): (viewerUrl: string) => Promise<void> {
  return useCallback(async (viewerUrl: string) => {
    let url: URL;
    try {
      url = new URL(viewerUrl, window.location.origin);
    } catch {
      return;
    }
    if (url.origin === window.location.origin && /^\/fleet\/hosts\/[0-9a-f-]{36}\/desktop$/i.test(url.pathname)) {
      window.location.assign(url.pathname);
      return;
    }
    if (url.protocol === 'https:' || url.protocol === 'http:') window.open(url.toString(), '_blank', 'noopener');
  }, []);
}
