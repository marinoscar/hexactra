// Whether "use my saved logins" can work for this viewer right now, and why not (E37.4, #593): what the task form and
// the chat settings show next to the switch. Four things must hold: the viewer may read their secrets settings, a
// provider is connected, and both the deployment's and the owner's switches are on.
import { usePlatformHost } from '@marinoscar/platform-web/core';
import { useEffect, useState } from 'react';

import { getDefaultUseSavedLogins, getStatus, type SecretsStatus } from './api';

export interface SavedLoginsAvailability {
  /** The status has been read (or could not be, or is not allowed). */
  loaded: boolean;
  /** The switch can be used. */
  available: boolean;
  /** Why it cannot, in one sentence; null while available or loading. */
  reason: string | null;
  /** Where to fix it, when the reason has a place. */
  fixTo: string | null;
  /** The owner's default for a new task or chat (`secrets.defaultUseSavedLogins`). */
  defaultOn: boolean;
  /** Whether the "identity details" sub-switch can work (E37.6): saved logins can, and the provider's identity permissions are granted. */
  identityAvailable: boolean;
  /** Why not, in one sentence, when saved logins can work but identity cannot; null otherwise. */
  identityReason: string | null;
}

/** The reason in words, from a status. Pure. */
export function unavailableReason(status: SecretsStatus | null, canRead: boolean): { reason: string; fixTo: string | null } | null {
  if (!canRead) return { reason: 'Saved logins are not available to your account.', fixTo: null };
  if (!status) return { reason: 'Saved logins could not be checked.', fixTo: null };
  if (!status.agentUse.deployment) return { reason: 'An administrator has turned off saved logins for this deployment.', fixTo: null };
  if (status.providers.vault.status !== 'connected') return { reason: 'Connect a secrets provider first.', fixTo: '/settings/secrets' };
  if (!status.agentUse.user) return { reason: 'Turn on “Let the agent use saved logins” first.', fixTo: '/settings/secrets' };
  return null;
}

/** Whether a grant's scopes let the agent fill identity details (E37.6). */
export const hasIdentityScopes = (scopes: readonly string[] | undefined): boolean => !!scopes && scopes.includes('vault:identity_read') && scopes.includes('vault:identity_fill');

/** Why the identity sub-switch cannot be used, given that saved logins can. Pure. */
export function identityReason(status: SecretsStatus | null): string | null {
  if (!status) return 'Saved details could not be checked.';
  return hasIdentityScopes(status.providers.vault.scopes) ? null : 'Allow “Let the agent fill identity details” on the Secrets page first.';
}

export function useSavedLoginsAvailability(): SavedLoginsAvailability {
  const { api, viewer } = usePlatformHost();
  const canRead = viewer.hasPermission('secrets:read');
  const [state, setState] = useState<{ loaded: boolean; status: SecretsStatus | null; defaultOn: boolean }>({ loaded: !canRead, status: null, defaultOn: false });

  useEffect(() => {
    if (!canRead) return;
    let live = true;
    Promise.all([getStatus(api).catch(() => null), getDefaultUseSavedLogins(api).catch(() => false)]).then(([status, defaultOn]) => {
      if (live) setState({ loaded: true, status, defaultOn });
    });
    return () => {
      live = false;
    };
  }, [api, canRead]);

  const why = state.loaded ? unavailableReason(state.status, canRead) : null;
  const available = state.loaded && why === null;
  const idReason = available ? identityReason(state.status) : null;
  return { loaded: state.loaded, available, reason: why?.reason ?? null, fixTo: why?.fixTo ?? null, defaultOn: state.defaultOn, identityAvailable: available && idReason === null, identityReason: idReason };
}
