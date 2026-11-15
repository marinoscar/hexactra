# hexactra brand

The mark, the wordmark and the color theme used by every hexactra surface: the Console (web and Android), the Chrome extension and the dashboard. Tracked in #283.

![hexactra app icon](hexactra-app-icon-512.png)

## The idea

hexactra lets an agent operate a computer the way a person does. The **Trace** mark draws that: one continuous line that starts at a single point (the coral dot, where the hand starts) and traces a hexagon. It is one gesture, not a printed shape.

## Files

| File | Use |
|---|---|
| `hexactra-mark.svg` | Mark on light backgrounds |
| `hexactra-mark-dark.svg` | Mark on dark backgrounds |
| `hexactra-mark-mono.svg` | One color (`currentColor`): notification badges, themed icons, print |
| `hexactra-app-icon.svg` | App icon: the white mark on an indigo plate (favicon, PWA, extension 48 and 128 px) |
| `hexactra-app-icon-small.svg` | Heavier strokes for 16 and 32 px |
| `hexactra-app-icon-512.png` | Raster preview |
| `hexactra-lockup.svg`, `hexactra-lockup-dark.svg` | Mark and wordmark side by side |

The lockups set the wordmark as live text in Space Grotesk. Before using them outside a browser (print, slides), convert the text to outlines in a design tool.

## Regenerating icons

Every raster icon comes from these SVGs. After changing one, run:

```bash
node scripts/brand/render-icons.mjs   # needs Playwright with Chromium
```

It writes the Console PWA icons and push badge, the Chrome extension icons and the 512 px preview, and copies the favicon to the Console and the dashboard. Commit what it writes. The Android launcher, themed and notification icons are vector drawables in `console/apps/android/app/src/main/res/drawable/`, drawn on the same 120-unit grid: change them by hand alongside the SVGs.

## Wordmark

- Always lowercase: **hexactra**. Never "Hexactra" or "HEXACTRA" in the logo.
- Space Grotesk Bold, tracking -0.02em.
- Prose may still capitalize the name at the start of a sentence, and screen readers get the product name ("Hexactra Console") as the logo's accessible name.

## Color tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| Primary | `#4B4BE8` | `#8C8CFF` | Mark line, primary buttons, links, selection |
| Accent | `#FF6B4A` | `#FF8A6E` | The starting dot, small highlights. Never body text on light backgrounds |
| Danger | `#C2412A` | `#FF8A6E` | Deny, stop and remove actions; the extension's connected badge |
| Background | `#F6F6FB` | `#0D0E17` | Page |
| Surface | `#FFFFFF` | `#181A28` | Cards, panels |
| Text | `#12131C` | `#ECEDF7` | Body |
| Muted | `#5A5E72` | `#A3A7BD` | Secondary text, labels |
| Divider | `#E3E4EF` | `#2A2D42` | Borders |

Contrast (measured): white on primary 6.0:1, white on danger 5.1:1, dark text on the dark primary 6.7:1, muted on background 6.0:1 (light) and 7.3:1 (dark). Coral accent on white is 2.8:1, so it is for marks and dots, never text.

Where the tokens live:

- Console web: `console/apps/web/src/theme.ts` (`BRAND`), with the light primary and background in `console/packages/shared/identity.json`, so `scripts/rename.mjs` still recolors the app.
- Console Android: `identity.json` again (launcher background, status bar), via the platform's Gradle identity.
- Chrome extension: CSS custom properties at the top of `apps/chrome-extension/sidepanel.html`.
- Dashboard: CSS custom properties in `apps/dashboard/index.html`.

## Typography

- **Space Grotesk** (700): the wordmark and headings h1 to h4.
- **Inter** (400, 500, 600): everything else.
- The Console self-hosts both through `@fontsource`, so the content security policy (`font-src 'self'`) holds. The extension and the dashboard name them first in their font stacks and fall back to system fonts.

## Usage rules

- Keep clear space around the mark of at least the dot's diameter.
- Do not rotate the mark, close the line's open end, recolor the line and the dot alike in full color, or put the mark on a busy photo.
- Below 24 px, use the small app icon or the mono mark.
