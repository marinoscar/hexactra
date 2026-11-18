// The in-app "Connect an AI app" guide and docs/hosted-clients.md say the same
// thing (#468): the document's generated section must equal what
// renderGuidesMarkdown() makes from src/content/connect-ai-apps.ts, the file
// the page reads. Fix a failure with `npm run docs:hosted-clients`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CONNECT_GUIDES, guideTextMarkdown, renderGuidesMarkdown } from '../content/connect-ai-apps';

const doc = readFileSync(join(__dirname, '..', '..', '..', '..', 'docs', 'hosted-clients.md'), 'utf8');

function generated(): string {
  const start = doc.indexOf('<!-- connect-guides:start');
  const end = doc.indexOf('<!-- connect-guides:end -->');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return doc.slice(doc.indexOf('-->', start) + 3, end).trim();
}

describe('docs/hosted-clients.md and the in-app guide', () => {
  it('share one source: the generated section equals the guides', () => {
    expect(generated()).toBe(renderGuidesMarkdown().trim());
  });

  it('every guide has three first prompts and every step is in the document', () => {
    for (const g of CONNECT_GUIDES) {
      expect(g.firstPrompts).toHaveLength(3);
      for (const step of g.steps) expect(doc).toContain(guideTextMarkdown(step));
    }
  });
});
