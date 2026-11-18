/// <reference types="vitest/config" />
// The MCP Apps widgets (#466, #467): one self-contained HTML file per widget,
// every script and style inlined (vite-plugin-singlefile), so a host renders
// it under the strictest CSP (no external origin at all). The plugin inlines
// one entry per build, so each widget is its own build: `MCP_UI_WIDGET`
// names it (scripts/build-widgets.mjs runs the three in turn). The code is written
// against React's API and runs on Preact's compat layer: React DOM alone is
// ~190 KB minified and the run card's budget is 300 KB (docs/mcp-apps.md).
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** The widgets, each `src/<name>.html` built to `dist/<name>.html`. */
export const WIDGETS = ['run-card', 'question-card', 'tasks-card'] as const;
const widget = process.env.MCP_UI_WIDGET ?? 'run-card';
if (!(WIDGETS as readonly string[]).includes(widget)) throw new Error(`MCP_UI_WIDGET: unknown widget ${widget} (one of ${WIDGETS.join(', ')})`);

const HERE = typeof import.meta.dirname === 'string' ? import.meta.dirname : process.cwd();
const require = createRequire(resolve(HERE, 'package.json'));

/** Testing Library's ES module build, so its `react-dom` imports go through the aliases too (its CommonJS build would load React DOM). */
function testingLibraryEsm(): string {
  return resolve(dirname(require.resolve('@testing-library/react/package.json')), 'dist', '@testing-library', 'react.esm.js');
}

/** React's entry points, served by Preact (build and tests alike, so the tests run what ships). */
const PREACT_ALIASES = [
  { find: /^react-dom\/client$/, replacement: 'preact/compat/client' },
  { find: /^react-dom\/test-utils$/, replacement: 'preact/test-utils' },
  { find: /^react-dom$/, replacement: 'preact/compat' },
  { find: /^react\/jsx-runtime$/, replacement: 'preact/jsx-runtime' },
  { find: /^react\/jsx-dev-runtime$/, replacement: 'preact/jsx-dev-runtime' },
  { find: /^react$/, replacement: 'preact/compat' },
];

export default defineConfig({
  root: resolve(HERE, 'src'),
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  resolve: { alias: PREACT_ALIASES },
  build: {
    outDir: resolve(HERE, 'dist'),
    // The widgets share dist/: scripts/build-widgets.mjs empties it once, before the first.
    emptyOutDir: false,
    target: 'es2022',
    rollupOptions: { input: { [widget]: resolve(HERE, 'src', `${widget}.html`) } },
  },
  test: {
    root: HERE,
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    alias: [{ find: /^@testing-library\/react$/, replacement: testingLibraryEsm() }, ...PREACT_ALIASES],
    include: ['test/**/*.test.{ts,tsx}'],
    server: { deps: { inline: [/@testing-library/] } },
  },
});
