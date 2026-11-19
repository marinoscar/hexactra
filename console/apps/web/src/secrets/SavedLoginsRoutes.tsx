// "My saved logins" (E37.5, #594): Vault's own secrets pages (`@marinoscar/vault-web/secrets/ui`) mounted inside the
// console's shell, navigation and theme. LAZY: App.tsx imports this module only when the route is opened, so the
// Vault pages are a separate chunk and cost the rest of the app nothing.
//
// The pages link to absolute `/secrets` paths, so they are mounted exactly there. The list, the editor and the
// versions drawer are Vault's; the built-in store holds the `Credential` type only (the API refuses anything else),
// so the type chooser has one entry.
import { Navigate, Route, Routes } from 'react-router-dom';
import { configureVaultWeb } from '@marinoscar/vault-web/core/headless';
import { CreateSecretPage, EditSecretPage, SecretDetailPage, SecretsPage } from '@marinoscar/vault-web/secrets/ui';
import { APP_NAME } from '@app/shared';
import { RequirePermission } from '@marinoscar/platform-web/identity/headless';
import type { ReactElement } from 'react';

import { api } from '../api';

configureVaultWeb({ http: api, apiBaseUrl: import.meta.env.VITE_API_BASE_URL || '/api', productName: APP_NAME });

const gate = (permission: string, element: ReactElement) => (
  <RequirePermission permission={permission} fallback={<Navigate to="/secrets" replace />}>
    {element}
  </RequirePermission>
);

export default function SavedLoginsRoutes() {
  return (
    <Routes>
      <Route index element={<SecretsPage />} />
      <Route path="new" element={gate('secrets:write', <CreateSecretPage />)} />
      <Route path=":id" element={<SecretDetailPage />} />
      <Route path=":id/edit" element={gate('secrets:write', <EditSecretPage />)} />
    </Routes>
  );
}
