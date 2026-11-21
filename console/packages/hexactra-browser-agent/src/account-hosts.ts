// Account work done in the browser (E41.5, #702): the webmail, calendar and files sites of the providers the owner can connect. A run that
// visited one of them in the browser, while it had no connection of that provider for that kind of work, could have used the owner's account
// instead: the owner is told so after the run (never the model, and nothing changes by itself). A small fixed list; a pure function.

export type AccountService = 'mail' | 'calendar' | 'files';
export interface AccountHost {
  provider: 'google' | 'microsoft';
  service: AccountService;
  /** What the owner reads: "Google Mail". */
  name: string;
}

const HOSTS: Record<string, AccountHost> = {
  'mail.google.com': { provider: 'google', service: 'mail', name: 'Google Mail' },
  'calendar.google.com': { provider: 'google', service: 'calendar', name: 'Google Calendar' },
  'docs.google.com': { provider: 'google', service: 'files', name: 'Google Docs' },
  'drive.google.com': { provider: 'google', service: 'files', name: 'Google Drive' },
  'sheets.google.com': { provider: 'google', service: 'files', name: 'Google Sheets' },
  'outlook.live.com': { provider: 'microsoft', service: 'mail', name: 'Outlook' },
  'outlook.office.com': { provider: 'microsoft', service: 'mail', name: 'Outlook' },
  'outlook.office365.com': { provider: 'microsoft', service: 'mail', name: 'Outlook' },
  'onedrive.live.com': { provider: 'microsoft', service: 'files', name: 'OneDrive' },
  'www.office.com': { provider: 'microsoft', service: 'files', name: 'Microsoft 365' },
  'm365.cloud.microsoft': { provider: 'microsoft', service: 'files', name: 'Microsoft 365' },
};

/** The account site a URL is on, or null. `*.sharepoint.com` is Microsoft files (OneDrive for work). */
export function accountHostOf(url: string): AccountHost | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (HOSTS[host]) return HOSTS[host]!;
  if (host.endsWith('.sharepoint.com')) return { provider: 'microsoft', service: 'files', name: 'OneDrive' };
  return null;
}

/** The distinct account sites among the URLs a run visited, in first-visit order. */
export function accountHostsVisited(urls: readonly string[]): AccountHost[] {
  const out: AccountHost[] = [];
  for (const u of urls) {
    const h = accountHostOf(u);
    if (h && !out.some((o) => o.provider === h.provider && o.service === h.service)) out.push(h);
  }
  return out;
}
