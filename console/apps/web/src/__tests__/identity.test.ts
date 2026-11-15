import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_NAME, APP_TAGLINE, CLI_NAME, THEME_COLOR } from '@app/shared';

import { readIdentity, renderIndexHtml, renderManifest } from '../../vite.config';

// The page shell and the manifest come from identity.json, so a rename edits
// one file and the browser tab, the install prompt and the theme follow.
describe('the identity in the page shell', () => {
  it('renders the product name into <title> and the brand colour into theme-color', () => {
    const html = renderIndexHtml('<meta name="theme-color" content="%APP_THEME_COLOR%" /><title>%APP_NAME%</title>', readIdentity());
    expect(html).toContain(`<title>${APP_NAME}</title>`);
    expect(html).toContain(`content="${THEME_COLOR}"`);
  });

  it('names the app in the manifest', () => {
    const manifest = JSON.parse(renderManifest(readIdentity())) as { name: string; theme_color: string };
    expect(manifest.name).toBe(APP_NAME);
    expect(manifest.theme_color).toBe(THEME_COLOR);
  });

  it('puts the lowercase short name on the home screen, on Android and iOS', () => {
    const manifest = JSON.parse(renderManifest(readIdentity())) as { short_name: string; description: string };
    expect(manifest.short_name).toBe(CLI_NAME);
    expect(manifest.description).toBe(APP_TAGLINE);
    const html = renderIndexHtml(readFileSync(join(PUBLIC, '..', 'index.html'), 'utf8'), readIdentity());
    expect(html).toContain(`<meta name="apple-mobile-web-app-title" content="${CLI_NAME}" />`);
    expect(html).not.toContain('%APP_');
  });
});

// The installable PWA: the manifest's icons, and the page's icon links, all exist in public/.
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

describe('the PWA install assets', () => {
  const manifest = JSON.parse(renderManifest(readIdentity())) as {
    id: string;
    scope: string;
    display: string;
    icons: Array<{ src: string; sizes: string; purpose: string }>;
  };

  it('is a standalone app scoped to the whole site', () => {
    expect(manifest).toMatchObject({ id: '/', scope: '/', display: 'standalone' });
  });

  it('offers 192 and 512 px icons both as "any" and as "maskable"', () => {
    for (const purpose of ['any', 'maskable']) {
      const sizes = manifest.icons.filter((icon) => icon.purpose === purpose).map((icon) => icon.sizes);
      expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    }
  });

  it('ships every icon the manifest and index.html name', () => {
    const html = readFileSync(join(PUBLIC, '..', 'index.html'), 'utf8');
    const linked = [...html.matchAll(/href="(\/[^"]+\.(?:png|svg))"/g)].map((match) => match[1]!);
    for (const src of [...manifest.icons.map((icon) => icon.src), ...linked]) {
      expect(existsSync(join(PUBLIC, src)), src).toBe(true);
    }
  });
});
