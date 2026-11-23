/**
 * Keeps the Knowledge Graph Map (E46.21, #795) out of every other page's bundle (#894).
 *
 * The Map is loaded through one `lazy()` import (`src/pages/KgraphPage.tsx` loads `src/kgraph/map/MapTab`, which loads
 * `KgraphMap` from 768 px up). Rolldown never lets a lazy chunk import the entry chunk, so a module the Map shares with the
 * entry or with another page is moved into a shared chunk of its own, and a module whose exports the Map uses beyond the
 * other page's keeps them all in that shared chunk. Measured before this plugin:
 *
 * - `d3-color`, `d3-interpolate`, `d3-timer` (React Flow's zoom and transitions; MUI X Charts uses them too) left the chart
 *   chunk for a new shared chunk, with the exports only React Flow uses (+1.7 kB on every chart page);
 * - `use-sync-external-store`'s shim (zustand, under React Flow; MUI X uses it too) became a new shared chunk;
 * - `src/kgraph/api.ts`, `labels.tsx` and `siteFacts.tsx` (the Knowledge Graph page's own helpers, in the entry chunk) left
 *   the entry for a new shared chunk that every first load then fetched;
 * - an icon the Map shares with another page (`AssignmentOutlined`) became a shared chunk of its own.
 *
 * This plugin gives the Map its own copy of exactly those modules: imported from the Map's code, its libraries or another
 * copy, each resolves to the same file with a `?kgmap` query, a separate module that only the Map's chunk holds. The
 * copies are stateless (pure functions, constants, components) except `d3-timer`, whose own timer queue then serves only
 * React Flow, which is how it works on its own. The Map's chunk grows by the copies; no other chunk changes for it.
 * `npm run bundle:compare --workspace=web` checks it.
 *
 * Config-side code: the React tree never imports it.
 */
import type { Plugin } from 'vite';

/** The query that marks the Map's copy of a shared module. */
export const MAP_COPY_QUERY = '?kgmap';

/** Code that only the Map loads: its own modules and the libraries only it uses. */
const MAP_ONLY = /(\/src\/kgraph\/map\/|\/node_modules\/(@xyflow|@dagrejs|zustand|classcat|d3-(zoom|drag|selection|transition|dispatch|ease))\/)/;

/** Modules the Map shares with the entry or with another page, which the Map gets its own copy of. */
const COPIED = /(\/node_modules\/(d3-color|d3-interpolate|d3-timer|use-sync-external-store|@mui\/icons-material)\/|\/src\/kgraph\/(api|labels|siteFacts)\.tsx?$)/;

const clean = (id: string) => id.replace(/\?.*$/, '');

/** Whether a module imported by `importer` should be the Map's copy. */
export function isMapImporter(importer: string): boolean {
  return importer.endsWith(MAP_COPY_QUERY) || MAP_ONLY.test(clean(importer));
}

/** Whether a resolved module is one the Map gets its own copy of. */
export function isCopiedModule(id: string): boolean {
  return COPIED.test(clean(id));
}

export function mapBundlePlugin(): Plugin {
  return {
    name: 'kgraph-map-bundle',
    apply: 'build',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (importer === undefined || !isMapImporter(importer)) return null;
      const resolved = await this.resolve(source, clean(importer), { ...options, skipSelf: true });
      if (resolved === null || resolved.external || !isCopiedModule(resolved.id)) return null;
      return { ...resolved, id: `${clean(resolved.id)}${MAP_COPY_QUERY}` };
    },
  };
}
