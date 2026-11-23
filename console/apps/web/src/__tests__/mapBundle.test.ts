// The Map's own copies of the modules it shares with other pages (build-config/map-bundle.ts, #894). The bundle itself is
// checked by `npm run bundle:compare --workspace=web`; this pins which imports get a copy.
import { isCopiedModule, isMapImporter, MAP_COPY_QUERY, mapBundlePlugin } from '../../build-config/map-bundle';

const ROOT = '/repo/console/apps/web';
const NM = '/repo/console/node_modules';

describe('the Map bundle plugin', () => {
  it('treats the Map, the libraries only it uses and its copies as the Map', () => {
    expect(isMapImporter(`${ROOT}/src/kgraph/map/KgraphMap.tsx`)).toBe(true);
    expect(isMapImporter(`${NM}/@xyflow/react/dist/esm/index.js`)).toBe(true);
    expect(isMapImporter(`${NM}/@dagrejs/dagre/dist/dagre.esm.js`)).toBe(true);
    expect(isMapImporter(`${NM}/zustand/esm/traditional.mjs`)).toBe(true);
    expect(isMapImporter(`${NM}/d3-transition/src/index.js`)).toBe(true);
    expect(isMapImporter(`${ROOT}/src/kgraph/labels.tsx${MAP_COPY_QUERY}`)).toBe(true);
  });

  it('never treats another page or a library other pages use as the Map', () => {
    expect(isMapImporter(`${ROOT}/src/pages/KgraphPage.tsx`)).toBe(false);
    expect(isMapImporter(`${ROOT}/src/kgraph/labels.tsx`)).toBe(false);
    expect(isMapImporter(`${NM}/@mui/x-charts/BarChart/BarChart.mjs`)).toBe(false);
    expect(isMapImporter(`${NM}/d3-interpolate/src/index.js`)).toBe(false);
  });

  it('copies only the modules the Map shares, never React, MUI or the page kit', () => {
    for (const id of [
      `${NM}/d3-color/src/color.js`,
      `${NM}/d3-interpolate/src/value.js`,
      `${NM}/d3-timer/src/timer.js`,
      `${NM}/use-sync-external-store/shim/with-selector.js`,
      `${NM}/@mui/icons-material/esm/AssignmentOutlined.js`,
      `${ROOT}/src/kgraph/api.ts`,
      `${ROOT}/src/kgraph/labels.tsx`,
      `${ROOT}/src/kgraph/siteFacts.tsx`,
    ]) {
      expect(isCopiedModule(id)).toBe(true);
    }
    for (const id of [
      `${NM}/react/index.js`,
      `${NM}/@mui/material/esm/Box/Box.js`,
      `${NM}/@marinoscar/platform-web/dist/core/index.js`,
      `${ROOT}/src/ui/index.ts`,
      `${ROOT}/src/kgraph/SitesTab.tsx`,
      `${ROOT}/src/api.ts`,
    ]) {
      expect(isCopiedModule(id)).toBe(false);
    }
  });

  it('applies to the production build only', () => {
    expect(mapBundlePlugin().apply).toBe('build');
  });
});
