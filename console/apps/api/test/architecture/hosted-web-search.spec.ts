// The provider-hosted web search is used only inside the web search provider adapter (E50.9, #979; decision record
// `docs/decisions/web-search.md` §2). Attached to the agent's own model calls it would run inside the model provider, skip
// `executeTool`, Stop, Pause, the gates, the span and the step record, and stop working when a tier falls back to another provider.
// So `web_search` as a HOSTED TOOL TYPE (`type: 'web_search'`, in any quoting, or `hostedTools: ['web_search', ...]`) may appear only
// under `apps/api/src/web-search/`, in the app and in the agent packages. The agent's own tool of that name (`name: 'web_search'`) is
// not a hosted tool and is not matched. The rule is a function over (file, source) pairs, so this spec also proves that it FIRES.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const CONSOLE = join(__dirname, '../../../..');
const ROOTS = [join(CONSOLE, 'apps/api/src'), ...readdirSync(join(CONSOLE, 'packages')).filter((p) => p.startsWith('hexactra-')).map((p) => join(CONSOLE, 'packages', p, 'src'))];
const HOME = /^apps\/api\/src\/web-search\//;

const HOSTED_TYPE = /\btype\s*:\s*['"`]web_search['"`]/;
const HOSTED_LIST = /\bhostedTools\s*:\s*\[[^\]]*['"`]web_search['"`]/;

/** Every violation in one file (`rel` is its path under console/, forward slashes). */
export function violations(rel: string, source: string): string[] {
  if (HOME.test(rel)) return [];
  const out: string[] = [];
  if (HOSTED_TYPE.test(source)) out.push(`${rel}: attaches the hosted web_search tool; only the search provider adapter (apps/api/src/web-search/) may`);
  if (HOSTED_LIST.test(source)) out.push(`${rel}: names web_search as a hosted tool; only the search provider adapter (apps/api/src/web-search/) may`);
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

const posix = (p: string) => p.split(sep).join('/');

describe('the hosted web search stays inside the search provider adapter (E50.9)', () => {
  it('holds in every source file of the API and the agent packages', () => {
    const files = ROOTS.flatMap(walk);
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((p) => violations(posix(relative(CONSOLE, p)), readFileSync(p, 'utf8')));
    expect(found).toEqual([]);
  });

  it('the adapter itself is where it is used', () => {
    const adapter = readFileSync(join(CONSOLE, 'apps/api/src/web-search/providers/openai.provider.ts'), 'utf8');
    expect(HOSTED_TYPE.test(adapter)).toBe(true);
  });

  it('fires on a model call of the runner or a package that attaches it, and not on the agent tool of the same name', () => {
    expect(violations('apps/api/src/runner/host/model-port.ts', "tools: [...fns, { type: 'web_search', searchContextSize: 'low' }]")).toHaveLength(1);
    expect(violations('packages/hexactra-agent/src/loop.ts', 'tools.push({ type: "web_search" })')).toHaveLength(1);
    expect(violations('apps/api/src/chat/chat-turn.service.ts', "const target = { hostedTools: ['web_search'] };")).toHaveLength(1);
    expect(violations('packages/hexactra-web-agent/src/tools/web-search.ts', "defineRunnerTool({ name: 'web_search', group: 'web' })")).toEqual([]);
    expect(violations('apps/api/src/web-search/providers/openai.provider.ts', "tools: [{ type: 'web_search' }]")).toEqual([]);
  });
});
