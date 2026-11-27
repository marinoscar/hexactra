// An automated accessibility pass (axe-core) for a rendered page or dialog under jsdom. Colour contrast needs a real layout, so it is
// left to the screenshot audit (`npm run ui:screens`); everything else axe checks here. Returns the serious and critical findings.
import axe from 'axe-core';

export async function seriousFindings(root: Element = document.body): Promise<string[]> {
  const r = await axe.run(root, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
