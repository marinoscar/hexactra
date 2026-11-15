#!/usr/bin/env node
// Renders every raster icon from the master SVGs in docs/brand/.
//
//   node scripts/brand/render-icons.mjs
//
// Needs Playwright with Chromium (`require('playwright')`). It is a dev-time
// tool, not a dependency of any workspace: run it after changing a master SVG
// and commit what it writes. Vector copies (favicon.svg, the console's
// source.svg) are written too, so every surface comes from one source.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRAND = join(ROOT, 'docs', 'brand');
const read = (name) => readFileSync(join(BRAND, name), 'utf8');

const appIcon = read('hexactra-app-icon.svg');
// Heavier strokes for 16 and 32 px, where the regular icon blurs.
const appIconSmall = read('hexactra-app-icon-small.svg');
// A white glyph on transparency (Android draws a notification badge as a mask).
const badge = read('hexactra-mark-mono.svg').replace('<svg ', '<svg style="color:#ffffff" ').replace('stroke-width="10"', 'stroke-width="12"');

const rasters = [
  { svg: appIcon, size: 192, out: 'console/apps/web/public/icons/icon-192.png' },
  { svg: appIcon, size: 512, out: 'console/apps/web/public/icons/icon-512.png' },
  { svg: badge, size: 96, out: 'console/apps/web/public/icons/badge-96.png' },
  { svg: appIconSmall, size: 16, out: 'apps/chrome-extension/icons/icon-16.png' },
  { svg: appIconSmall, size: 32, out: 'apps/chrome-extension/icons/icon-32.png' },
  { svg: appIcon, size: 48, out: 'apps/chrome-extension/icons/icon-48.png' },
  { svg: appIcon, size: 128, out: 'apps/chrome-extension/icons/icon-128.png' },
  { svg: appIcon, size: 512, out: 'docs/brand/hexactra-app-icon-512.png' },
];

const vectors = [
  { from: 'hexactra-app-icon.svg', out: 'console/apps/web/public/favicon.svg' },
  { from: 'hexactra-app-icon.svg', out: 'console/apps/web/public/icons/source.svg' },
  { from: 'hexactra-app-icon.svg', out: 'apps/dashboard/public/favicon.svg' },
];

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const { svg, size, out } of rasters) {
  const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
  const target = join(ROOT, out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, await page.locator('svg').screenshot({ omitBackground: true }));
  console.log(`wrote ${out} (${size}px)`);
}
await browser.close();

for (const { from, out } of vectors) {
  const target = join(ROOT, out);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(BRAND, from), target);
  console.log(`copied ${out}`);
}
