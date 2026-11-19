// The owner's connections, read once for a screen that offers them (the pickers on a task, a chat, a delivery). A read that fails
// leaves the list empty and says so: nothing here blocks saving.
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useCallback, useEffect, useState } from 'react';

import { listConnections, type Connection } from './api';

export interface UseConnections {
  /** `null` until loaded (or when the viewer may not read them). */
  connections: Connection[] | null;
  failed: boolean;
  reload: () => void;
}

export function useConnections(enabled?: boolean): UseConnections {
  const { api, viewer } = usePlatformHost();
  const allowed = (enabled ?? true) && viewer.hasPermission('connections:read');
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!allowed) return;
    let stale = false;
    listConnections(api)
      .then((rows) => {
        if (stale) return;
        setConnections(rows);
        setFailed(false);
      })
      .catch(() => {
        if (!stale) {
          setFailed(true);
          setConnections([]);
        }
      });
    return () => {
      stale = true;
    };
  }, [api, allowed, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { connections: allowed ? connections : null, failed, reload };
}
