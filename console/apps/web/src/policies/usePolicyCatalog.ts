import { useCallback, useEffect, useState } from 'react';
import { isPlatformApiError, usePlatformHost } from '@marinoscar/platform-web/core';

import { getDefaultPolicy, getEffectiveTiers, listPolicies } from './api';
import { sortPolicies } from './format';
import type { AgentPolicy, EffectiveTiers } from './types';

/** An API error as a sentence. */
export function errorText(e: unknown, fallback: string): string {
  if (isPlatformApiError(e)) return e.message || fallback;
  return e instanceof Error ? e.message : fallback;
}

export interface PolicyCatalog {
  /** Built-ins first, then own policies by name. */
  policies: AgentPolicy[];
  /** The user's default policy id (`builtin:balanced` when none was chosen). */
  defaultId: string | null;
  /** The caller's resolved model tiers; null until loaded, or when the tiers route is not available. */
  effective: EffectiveTiers | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  byId: (id: string | null | undefined) => AgentPolicy | undefined;
}

/**
 * The policies a picker offers, the default, and the effective model tiers.
 * Without `agent_policies:read` it loads nothing (pickers then hide).
 */
export function usePolicyCatalog(options: { withTiers?: boolean } = {}): PolicyCatalog {
  const { api, viewer } = usePlatformHost();
  const canRead = viewer.hasPermission('agent_policies:read');
  const withTiers = options.withTiers ?? true;
  const [policies, setPolicies] = useState<AgentPolicy[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [effective, setEffective] = useState<EffectiveTiers | null>(null);
  const [loading, setLoading] = useState(canRead);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!canRead) return;
    setError(null);
    try {
      const [list, def] = await Promise.all([listPolicies(api), getDefaultPolicy(api)]);
      setPolicies(sortPolicies(list));
      setDefaultId(def.policyId);
    } catch (e) {
      setError(errorText(e, 'Could not load agent policies'));
    } finally {
      setLoading(false);
    }
    if (withTiers) {
      // The tiers are a nice-to-have here: a missing route or AI switched off leaves them out.
      getEffectiveTiers(api)
        .then(setEffective)
        .catch(() => setEffective(null));
    }
  }, [api, canRead, withTiers]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const byId = useCallback((id: string | null | undefined) => (id ? policies.find((p) => p.id === id) : undefined), [policies]);

  return { policies, defaultId, effective, loading, error, reload, byId };
}
