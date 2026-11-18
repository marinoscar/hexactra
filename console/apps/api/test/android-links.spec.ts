// The AI-app links on Android (#516): what can be proven without a device.
//
// A hosted client's sign-in lands on `/oauth/consent?request=…`, and the
// `app.connected` / `app.scope_added` notifications link to
// `/settings/ai-apps/:clientId`. Both open inside the Android app (a Trusted
// Web Activity) only when its verified https intent-filter covers them. These
// tests pin that the filter covers the whole console host (no path, prefix or
// pattern narrows it) and that the notification links stay same-origin paths,
// which the app resolves against its own origin. What a device must still
// check (that Android's link verification succeeded for the host, and how a
// vendor's mobile app opens the sign-in) is recorded in docs/parity.md.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { appLink, appConnectedTemplate, appScopeAddedTemplate } from '../src/connected-apps/connected-apps.notifications';

const manifest = readFileSync(resolve(__dirname, '../../android/app/src/main/AndroidManifest.xml'), 'utf8');

/** The `<intent-filter>` blocks of the manifest. */
function intentFilters(xml: string): string[] {
  return [...xml.matchAll(/<intent-filter\b[^>]*>[\s\S]*?<\/intent-filter>/g)].map((m) => m[0]);
}

describe('Android app links for AI apps (#516)', () => {
  const httpsFilters = intentFilters(manifest).filter((f) => /android:scheme="https"/.test(f));

  it('has one verified https VIEW + BROWSABLE filter for the console host', () => {
    expect(httpsFilters).toHaveLength(1);
    const f = httpsFilters[0]!;
    expect(f).toMatch(/android:autoVerify="true"/);
    expect(f).toMatch(/android\.intent\.action\.VIEW/);
    expect(f).toMatch(/android\.intent\.category\.BROWSABLE/);
    expect(f).toMatch(/android:host="\$\{twaHost\}"/);
  });

  it('does not narrow the filter by path, so /oauth/consent and /settings/ai-apps open in the app', () => {
    expect(httpsFilters[0]).not.toMatch(/android:path(Prefix|Pattern|AdvancedPattern|Suffix)?=/);
  });

  it('links the AI-app notifications to same-origin paths of the app page', () => {
    expect(appLink('client 1/x')).toBe('/settings/ai-apps/client%201%2Fx');
    expect(appLink('')).toBe('/settings/ai-apps');
    for (const tpl of [appConnectedTemplate, appScopeAddedTemplate]) {
      const link = tpl({ appName: 'Claude', clientId: 'c-1', scopes: 'runs', added: 'browser' } as never).link;
      expect(link).toBe('/settings/ai-apps/c-1');
      expect(link?.startsWith('/')).toBe(true);
      expect(link?.startsWith('//')).toBe(false);
    }
  });
});
