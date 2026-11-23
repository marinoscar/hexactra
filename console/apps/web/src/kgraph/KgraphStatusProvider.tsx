import { usePlatformHost } from '@marinoscar/platform-web/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { getKgStatus, type KgStatus } from './api';

// The `kgraph` feature (E46.20, registered in App.tsx): the navigation entry that declares it shows only while it is on.
declare module '@marinoscar/platform-web/settings/headless' {
  interface SettingsFeatureRegistry {
    kgraph: true;
  }
}

/** What the shell and the pages know about the switches: `null` while loading, or when the viewer cannot read them. */
interface KgraphStatusValue {
  status: KgStatus | null;
  /** Read the switches again (after the owner turns theirs on or off). */
  refresh: () => Promise<void>;
}

const Ctx = createContext<KgraphStatusValue>({ status: null, refresh: async () => undefined });

/**
 * One `GET /api/kgraph/status` per signed-in viewer who may read it (`kgraph:read`), for the navigation entry and the pages.
 * A failure reads as off: the entry stays hidden (fail closed).
 */
export function KgraphStatusProvider({ children }: { children: ReactNode }) {
  const { api, viewer } = usePlatformHost();
  const canRead = viewer.hasPermission('kgraph:read');
  const [status, setStatus] = useState<KgStatus | null>(null);
  const refresh = useCallback(async () => {
    if (!canRead) return setStatus(null);
    try {
      setStatus(await getKgStatus(api));
    } catch {
      setStatus(null);
    }
  }, [api, canRead]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const value = useMemo(() => ({ status, refresh }), [status, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKgraphStatus(): KgraphStatusValue {
  return useContext(Ctx);
}

/** The `kgraph` settings feature: on only while both the deployment's and the viewer's own switch are on. */
export function useKgraphFeature(): boolean {
  return useContext(Ctx).status?.available === true;
}
