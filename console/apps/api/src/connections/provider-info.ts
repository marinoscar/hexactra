// What the Connect dialog and the administrator page say about each provider, independent of the adapter (E39.2, #599).
// PROVISIONAL: follows the decision record of E39.1 (`docs/decisions/connections-auth.md`, itself provisional: derived from
// documentation, no real account tried yet). The adapters (E39.3, E39.4) and the experiments of #598 settle the text.
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
      { id: 'personal', label: 'Personal Gmail account', supported: true, note: 'Expected to work once the administrator has published the Google app ("In production"); you will see a "Google has not verified this app" page and must continue through it. While the app is in testing mode Google ends the sign-in after about a week.' },
      { id: 'workspace', label: 'Google Workspace account', supported: true, note: "You will see the same unverified-app page. Your organization's administrator may have to mark the app as trusted before it works." },
      { id: 'advanced_protection', label: 'Account in Google Advanced Protection', supported: false, note: 'Google allows only verified apps on these accounts.' },
    ],
    setupSteps: [
      'In the Google Cloud console, create a project (or choose one) and enable the Gmail, Google Calendar, Google Docs, Google Sheets and Google Drive APIs.',
      'Configure the Google Auth Platform (the OAuth consent screen): choose External and set the publishing status to "In production". A project left in testing mode ends every sign-in after about a week. You do not need to submit the app for verification for your own use; users accept an unverified-app warning when they connect.',
      'Create an OAuth client of type "Web application" and add the redirect URI shown on this page. It must be an https address with a public domain name.',
      'Paste the client id and client secret here and switch Google on.',
      'Google Workspace only: in the Google Admin console (Security, API controls) mark the client as trusted if your organization blocks unverified apps.',
    ],
  },
  microsoft: {
    displayName: 'Microsoft',
    accountTypes: [
      { id: 'personal', label: 'Personal Microsoft account', supported: true, note: 'Outlook.com, Hotmail and Live accounts. Some document features may be limited on personal OneDrive.' },
      { id: 'work_same_tenant', label: 'Work or school account in the same organization as the app', supported: true, note: "Depending on the organization's settings, a user may need an administrator's approval; the administrator can approve for everyone." },
      { id: 'work_other_tenant', label: 'Work or school account of another organization', supported: true, note: 'That organization\'s administrator has to approve the app once; until then the account sees "needs admin approval".' },
    ],
    setupSteps: [
      'In the Microsoft Entra admin center, register an application. For account types choose "Accounts in any organizational directory and personal Microsoft accounts".',
      'Add the redirect URI shown on this page as a Web redirect URI.',
      'Under API permissions add the delegated Microsoft Graph permissions of the capabilities you will use, plus offline_access and User.Read. Do not add application permissions.',
      'Create a client secret and copy its value (it is shown once). Note its expiry date: sign-ins stop refreshing when the secret expires.',
      'Paste the application (client) id and the secret here, set the tenant (common allows work, school and personal accounts) and switch Microsoft on.',
    ],
  },
};
