// What the Connect dialog and the administrator page say about each provider, independent of the adapter (E39.2, #599).
// PROVISIONAL: written for the bring-your-own-app model while the decision record of E39.1 (#598) is being finished; the
// authoritative setup text and the supported account types are `docs/connections.md` and the adapters (E39.3, E39.4).
import type { ConnectionProviderId } from './connections.constants';

export interface ProviderAccountType {
  id: string;
  label: string;
  supported: boolean;
  /** One sentence the owner reads before starting. */
  note: string;
}

export interface ProviderInfo {
  displayName: string;
  accountTypes: readonly ProviderAccountType[];
  /** The administrator's checklist: what to create at the provider before switching it on here. */
  setupSteps: readonly string[];
}

export const PROVIDER_INFO: Record<ConnectionProviderId, ProviderInfo> = {
  google: {
    displayName: 'Google',
    accountTypes: [
      { id: 'personal', label: 'Personal Gmail account', supported: true, note: 'Works while the Google project is published; in testing mode Google ends the sign-in after about a week and you must connect again.' },
      { id: 'workspace', label: 'Google Workspace account', supported: true, note: "Your organization's administrator may have to allow the app first." },
    ],
    setupSteps: [
      'In the Google Cloud console, create a project (or choose one) and enable the Gmail, Google Calendar, Google Docs, Google Sheets and Google Drive APIs.',
      'Configure the OAuth consent screen. Publish it (a project left in testing mode ends every sign-in after about a week).',
      'Create an OAuth client of type "Web application" and add the redirect URI shown on this page.',
      'Paste the client id and client secret here and switch Google on.',
    ],
  },
  microsoft: {
    displayName: 'Microsoft',
    accountTypes: [
      { id: 'personal', label: 'Personal Microsoft account', supported: true, note: 'Outlook.com, Hotmail and Live accounts.' },
      { id: 'work', label: 'Work or school account', supported: true, note: "Your organization's administrator may have to approve the app, depending on its settings." },
    ],
    setupSteps: [
      'In the Microsoft Entra admin center, register an application. Choose the account types you want to allow.',
      'Add the redirect URI shown on this page as a Web redirect URI.',
      'Create a client secret and note its value (it is shown once).',
      'Paste the application (client) id and the secret here, set the tenant (common allows work, school and personal accounts) and switch Microsoft on.',
    ],
  },
};
