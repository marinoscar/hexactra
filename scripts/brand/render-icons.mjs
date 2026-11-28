#!/usr/bin/env node
// Renders every raster brand asset from the master SVGs in docs/brand/.
//
//   node scripts/brand/render-icons.mjs
//
// Needs Playwright with Chromium (`require('playwright')`), and the console's
// installed fonts (`cd console && npm ci`) for the wordmark and the banners.
// It is a dev-time tool, not a dependency of any workspace: run it after
// changing a master SVG and commit what it writes. Vector copies (favicons,
// the console's source.svg) are written too, so every surface comes from one
// source.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRAND = join(ROOT, 'docs', 'brand');
const read = (name) => readFileSync(join(BRAND, name), 'utf8');

// --- Fonts, embedded as data URLs so the page needs no network ----------------
const FONT_DIR = join(ROOT, 'console', 'node_modules', '@fontsource');
const fontFile = (family, weight) => join(FONT_DIR, family, 'files', `${family}-latin-${weight}-normal.woff2`);
const FONTS = [
  ['Space Grotesk', 'space-grotesk', 700],
  ['Inter', 'inter', 500],
];
for (const [, family, weight] of FONTS) {
  if (!existsSync(fontFile(family, weight))) {
    throw new Error(`missing ${fontFile(family, weight)}: run \`npm ci\` in console/ first`);
  }
}
const FONT_CSS = FONTS.map(
  ([name, family, weight]) =>
    `@font-face{font-family:'${name}';font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(fontFile(family, weight)).toString('base64')}) format('woff2')}`,
).join('');

// --- Sources -----------------------------------------------------------------
const appIcon = read('hexactra-app-icon.svg');
// Heavier strokes for 16 and 32 px, where the regular icon blurs.
const appIconSmall = read('hexactra-app-icon-small.svg');
// Full bleed: the platform masks it (maskable) or rounds it (iOS).
const maskable = read('hexactra-icon-maskable.svg');
const square = read('hexactra-icon-square.svg');
const mark = read('hexactra-mark.svg');
const markDark = read('hexactra-mark-dark.svg');
const mono = read('hexactra-mark-mono.svg');
const monoIn = (color) => mono.replace('<svg ', `<svg style="color:${color}" `);
// A white glyph on transparency (Android draws a notification badge as a mask).
const badge = monoIn('#ffffff').replace('stroke-width="10"', 'stroke-width="12"');

// --- Raster icons from one SVG -------------------------------------------------
const icons = [
  // Console PWA
  { svg: appIcon, size: 192, out: 'console/apps/web/public/icons/icon-192.png' },
  { svg: appIcon, size: 512, out: 'console/apps/web/public/icons/icon-512.png' },
  { svg: maskable, size: 192, out: 'console/apps/web/public/icons/icon-maskable-192.png' },
  { svg: maskable, size: 512, out: 'console/apps/web/public/icons/icon-maskable-512.png' },
  { svg: square, size: 180, out: 'console/apps/web/public/icons/apple-touch-icon.png' },
  { svg: appIconSmall, size: 32, out: 'console/apps/web/public/icons/favicon-32.png' },
  { svg: badge, size: 96, out: 'console/apps/web/public/icons/badge-96.png' },
  // Chrome extension
  { svg: appIconSmall, size: 16, out: 'apps/chrome-extension/icons/icon-16.png' },
  { svg: appIconSmall, size: 32, out: 'apps/chrome-extension/icons/icon-32.png' },
  { svg: appIcon, size: 48, out: 'apps/chrome-extension/icons/icon-48.png' },
  { svg: appIcon, size: 128, out: 'apps/chrome-extension/icons/icon-128.png' },
  // Reference exports (docs/brand/png/)
  { svg: appIcon, size: 512, out: 'docs/brand/hexactra-app-icon-512.png' },
  { svg: appIcon, size: 1024, out: 'docs/brand/png/hexactra-app-icon-1024.png' },
  { svg: maskable, size: 1024, out: 'docs/brand/png/hexactra-icon-maskable-1024.png' },
  { svg: mark, size: 512, out: 'docs/brand/png/hexactra-mark-512.png' },
  { svg: mark, size: 1024, out: 'docs/brand/png/hexactra-mark-1024.png' },
  { svg: markDark, size: 1024, out: 'docs/brand/png/hexactra-mark-dark-1024.png' },
  { svg: monoIn('#12131c'), size: 1024, out: 'docs/brand/png/hexactra-mark-black-1024.png' },
  { svg: monoIn('#ffffff'), size: 1024, out: 'docs/brand/png/hexactra-mark-white-1024.png' },
];

const vectors = [
  { from: 'hexactra-app-icon.svg', out: 'console/apps/web/public/favicon.svg' },
  { from: 'hexactra-app-icon.svg', out: 'console/apps/web/public/icons/source.svg' },
  { from: 'hexactra-icon-maskable.svg', out: 'console/apps/web/public/icons/maskable.svg' },
  { from: 'hexactra-app-icon.svg', out: 'apps/dashboard/public/favicon.svg' },
];

// --- Pages with the wordmark: lockups, the README banner, the social image ----
const MARK_PATH = 'M60 60V108L18.4 84V36L60 12L101.6 36V84L80 96.5';
const SCHEMES = {
  light: { bg: '#f6f6fb', line: '#4b4be8', dot: '#ff6b4a', text: '#12131c', muted: '#5a5e72', rule: '#e3e4ef' },
  dark: { bg: '#0d0e17', line: '#8c8cff', dot: '#ff8a6e', text: '#ecedf7', muted: '#a3a7bd', rule: '#2a2d42' },
};
const markSvg = (s, size) =>
  `<svg viewBox="0 0 120 120" width="${size}" height="${size}"><path d="${MARK_PATH}" fill="none" stroke="${s.line}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><circle cx="60" cy="60" r="12" fill="${s.dot}"/></svg>`;
const page = (body, w, h, s) =>
  `<html><head><style>${FONT_CSS}*{margin:0;box-sizing:border-box}body{width:${w}px;height:${h}px;background:${s ? s.bg : 'transparent'};font-family:'Inter',sans-serif}.wm{font-family:'Space Grotesk';font-weight:700;letter-spacing:-0.03em;line-height:1}</style></head><body>${body}</body></html>`;

const TAGLINE = 'AI agents that operate real browsers, the way a person does.';
const SUBLINE = 'Self-hosted · human in the loop · web, Android, CLI, MCP';

const lockup = (s) =>
  `<div style="display:flex;align-items:center;gap:36px;padding:40px 56px">${markSvg(s, 160)}<div class="wm" style="font-size:136px;color:${s.text}">hexactra</div></div>`;
const banner = (s) => `
  <div style="height:100%;display:flex;align-items:center;gap:72px;padding:0 96px;border-bottom:6px solid ${s.line}">
    ${markSvg(s, 220)}
    <div style="display:flex;flex-direction:column;gap:22px">
      <div class="wm" style="font-size:132px;color:${s.text}">hexactra</div>
      <div style="font-size:34px;font-weight:500;color:${s.text}">${TAGLINE}</div>
      <div style="font-size:24px;font-weight:500;color:${s.muted}">${SUBLINE}</div>
    </div>
  </div>`;
const social = (s) => `
  <div style="height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:40px;text-align:center;padding:0 80px">
    <div style="display:flex;align-items:center;gap:36px">${markSvg(s, 200)}<div class="wm" style="font-size:150px;color:${s.text}">hexactra</div></div>
    <div style="font-size:36px;font-weight:500;white-space:nowrap;color:${s.text}">${TAGLINE}</div>
    <div style="font-size:28px;font-weight:500;color:${s.muted}">${SUBLINE}</div>
  </div>`;

const pages = [
  { html: page(lockup(SCHEMES.light), 940, 240), w: 940, h: 240, out: 'docs/brand/png/hexactra-lockup.png', transparent: true },
  { html: page(lockup(SCHEMES.dark), 940, 240), w: 940, h: 240, out: 'docs/brand/png/hexactra-lockup-dark.png', transparent: true },
  { html: page(banner(SCHEMES.light), 1600, 440, SCHEMES.light), w: 1600, h: 440, out: 'docs/brand/hexactra-banner.png' },
  { html: page(banner(SCHEMES.dark), 1600, 440, SCHEMES.dark), w: 1600, h: 440, out: 'docs/brand/hexactra-banner-dark.png' },
  { html: page(social(SCHEMES.light), 1280, 640, SCHEMES.light), w: 1280, h: 640, out: 'docs/brand/png/hexactra-social-preview.png' },
  { html: page(social(SCHEMES.dark), 1280, 640, SCHEMES.dark), w: 1280, h: 640, out: 'docs/brand/png/hexactra-social-preview-dark.png' },
];

// --- Render ----------------------------------------------------------------------
const ensureDir = (out) => {
  const target = join(ROOT, out);
  mkdirSync(dirname(target), { recursive: true });
  return target;
};

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
// Headful, never headless (AGENTS.md, "Never a headless browser"): without a desktop, run under `xvfb-run -a`.
const browser = await chromium.launch({ headless: false });
const tab = await browser.newPage();

for (const { svg, size, out } of icons) {
  const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  await tab.setViewportSize({ width: size, height: size });
  await tab.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
  writeFileSync(ensureDir(out), await tab.locator('svg').screenshot({ omitBackground: true }));
  console.log(`wrote ${out} (${size}px)`);
}

for (const { html, w, h, out, transparent } of pages) {
  await tab.setViewportSize({ width: w, height: h });
  await tab.setContent(html);
  await tab.evaluate(() => document.fonts.ready);
  writeFileSync(ensureDir(out), await tab.screenshot({ omitBackground: Boolean(transparent), clip: { x: 0, y: 0, width: w, height: h } }));
  console.log(`wrote ${out} (${w}x${h})`);
}
await browser.close();

for (const { from, out } of vectors) {
  copyFileSync(join(BRAND, from), ensureDir(out));
  console.log(`copied ${out}`);
}
