// Account sites visited in the browser (E41.5): the fixed list, as a pure function.
import { accountHostOf, accountHostsVisited } from '../src/account-hosts';

describe('account sites', () => {
  it('knows the webmail, calendar and files sites of both providers', () => {
    expect(accountHostOf('https://mail.google.com/mail/u/0/#inbox')).toEqual({ provider: 'google', service: 'mail', name: 'Google Mail' });
    expect(accountHostOf('https://calendar.google.com/')?.service).toBe('calendar');
    expect(accountHostOf('https://drive.google.com/drive')?.service).toBe('files');
    expect(accountHostOf('https://outlook.office.com/mail/')).toEqual({ provider: 'microsoft', service: 'mail', name: 'Outlook' });
    expect(accountHostOf('https://team-a.sharepoint.com/sites/x')?.provider).toBe('microsoft');
  });

  it('ignores other sites and what is not a URL', () => {
    expect(accountHostOf('https://shop.example.test/')).toBeNull();
    expect(accountHostOf('https://mail.google.com.example.test/')).toBeNull();
    expect(accountHostOf('not a url')).toBeNull();
  });

  it('lists each provider and service once, in first-visit order', () => {
    expect(accountHostsVisited(['https://shop.example.test/', 'https://mail.google.com/a', 'https://mail.google.com/b', 'https://drive.google.com/']).map((h) => h.name)).toEqual(['Google Mail', 'Google Drive']);
  });
});
