// The human-emulator agent (#366): what it sees (marked screenshots as the
// round's image input), the full-power policy and defaults, and the tools
// external agents get over MCP.
import type { FabricClient } from '../src/fabric/fabric.client';
import type { FabricSession } from '../src/runner/fabric-session';
import { MCP_TOOLS, READ_ONLY_TOOLS } from '../src/mcp/mcp.tools';
import { domainAllowed } from '../src/runner/policy';
import { captureScreen, describeView, markCenter, parseMarks, roundInput, type ScreenView } from '../src/runner/vision';
import { createTaskSchema } from '../src/tasks/tasks.schemas';

const mark = { n: 3, selector: '#go', tag: 'button', text: 'Search flights', x: 100, y: 40, w: 80, h: 20 };

describe('vision helpers', () => {
  it('keeps only well-formed marks', () => {
    expect(parseMarks([mark, { n: 'x' }, null, { ...mark, n: 4, selector: 5 }])).toEqual([mark]);
    expect(parseMarks('nope')).toEqual([]);
  });

  it('clicks a mark at its center', () => {
    expect(markCenter(mark)).toEqual({ x: 140, y: 50 });
  });

  it('describes a page view with its marks and a desktop view with screen coordinates', () => {
    const page: ScreenView = { screen: 'page', dataUrl: 'data:image/jpeg;base64,QQ==', width: 1280, height: 720, url: 'https://example.test/', title: 'Example', marks: [mark] };
    const text = describeView(page);
    expect(text).toContain('1280×720');
    expect(text).toContain('[3] button "Search flights" at 140,50 — #go');
    expect(describeView({ ...page, screen: 'desktop', marks: [] })).toContain('screen pixels');
  });

  it('sends the screenshot as an image part of the round input, or text alone', () => {
    expect(roundInput('Goal: x', null)).toBe('Goal: x');
    const view: ScreenView = { screen: 'page', dataUrl: 'data:image/jpeg;base64,QQ==', width: null, height: null, url: null, title: null, marks: [] };
    const input = roundInput('Goal: x', view) as { type: string; role: string; content: { type: string; url?: string; text?: string; detail?: string }[] }[];
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(input[0]!.content[0]!.text).toBe('Goal: x');
    expect(input[0]!.content[1]).toEqual({ type: 'image', url: 'data:image/jpeg;base64,QQ==', detail: 'high' });
    expect(input[0]!.content[2]!.text).toMatch(/^Attached: a screenshot of the page/);
  });
});

describe('captureScreen', () => {
  const session = (result: Record<string, unknown>) => {
    const act = jest.fn(async () => ({ id: 'op', state: 'succeeded' as const, result }));
    return { act, s: { act } as unknown as FabricSession };
  };

  it('fetches the image by artifact handle and keeps the marks', async () => {
    const { act, s } = session({ artifact_id: 'a1', mime: 'image/jpeg', width: 800, height: 600, url: 'https://example.test/', marks: [mark] });
    const raw = jest.fn(async () => new Response(Buffer.from('JPEG'), { headers: { 'content-type': 'image/jpeg' } }));
    const v = await captureScreen(s, { raw } as unknown as FabricClient, 'sess', 'page');
    expect(act).toHaveBeenCalledWith('sess', { type: 'screenshot', marks: true }, 30_000);
    expect(raw).toHaveBeenCalledWith('GET', '/v1/artifacts/a1', { retries: 1 });
    expect(v).toMatchObject({ screen: 'page', dataUrl: `data:image/jpeg;base64,${Buffer.from('JPEG').toString('base64')}`, width: 800, marks: [mark] });
  });

  it('captures the desktop, and uses inline bytes when present', async () => {
    const { act, s } = session({ mime: 'image/png', data: 'UE5H' });
    const v = await captureScreen(s, {} as FabricClient, 'sess', 'desktop');
    expect(act).toHaveBeenCalledWith('sess', { type: 'desktop_screenshot' }, 30_000);
    expect(v.dataUrl).toBe('data:image/png;base64,UE5H');
  });

  it('fails when the screenshot failed', async () => {
    const s = { act: jest.fn(async () => ({ id: 'op', state: 'failed', error: 'no tab' })) } as unknown as FabricSession;
    await expect(captureScreen(s, {} as FabricClient, 'sess', 'page')).rejects.toThrow('no tab');
  });
});

describe('full-power policy (#366)', () => {
  it('opens any URL but javascript: when the task lists no sites', () => {
    for (const ok of ['https://example.test/', 'file:///tmp/a.pdf', 'chrome://downloads', 'data:text/html,hi', 'about:blank']) {
      expect(domainAllowed(ok, [])).toBe(true);
    }
    expect(domainAllowed('javascript:alert(1)', [])).toBe(false);
    expect(domainAllowed('not a url', [])).toBe(false);
  });

  it('keeps a task that lists sites on them', () => {
    expect(domainAllowed('https://www.shop.example.test/x', ['shop.example.test'])).toBe(true);
    expect(domainAllowed('https://other.example.test/', ['shop.example.test'])).toBe(false);
    expect(domainAllowed('file:///tmp/a', ['shop.example.test'])).toBe(false);
  });

  it('defaults new tasks to no confirmations and a human-sized budget', () => {
    expect(createTaskSchema.parse({ name: 'n', goal: 'g' })).toMatchObject({ confirmRiskyActions: false, maxSteps: 100, maxMinutes: 30, allowedDomains: [] });
    expect(createTaskSchema.parse({ name: 'n', goal: 'g', confirmRiskyActions: true })).toMatchObject({ confirmRiskyActions: true });
    expect(() => createTaskSchema.parse({ name: 'n', goal: 'g', maxSteps: 1000, maxMinutes: 480 })).not.toThrow();
  });
});

describe('MCP tools for external agents (#366)', () => {
  it('expose JavaScript, positional input and the desktop', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    for (const n of [
      'browser_evaluate', 'browser_click_at', 'browser_hover_at', 'browser_drag', 'browser_scroll_at', 'browser_type_keys', 'browser_key',
      'browser_desktop_screenshot', 'browser_desktop_click', 'browser_desktop_type', 'browser_desktop_key', 'browser_desktop_scroll', 'browser_desktop_drag',
    ]) {
      expect(names).toContain(n);
    }
    expect(READ_ONLY_TOOLS.has('browser_desktop_screenshot')).toBe(true);
    expect(READ_ONLY_TOOLS.has('browser_evaluate')).toBe(false);
  });

  it('send a marked screenshot by default and return the marks with the image', async () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'browser_screenshot')!;
    const api = jest.fn(async () => ({ state: 'succeeded', result: { url_path: '/api/browser/sessions/s/artifacts/a', marks: [mark] } }));
    const bytes = jest.fn(async () => ({ data: Buffer.from('JPEG'), mime: 'image/jpeg' }));
    const parsed = tool.input.parse({ session_id: '00000000-0000-4000-8000-000000000001' }) as Record<string, unknown>;
    const r = await tool.call(parsed, { api, bytes } as never);
    expect(api).toHaveBeenCalledWith('POST', '/browser/sessions/00000000-0000-4000-8000-000000000001/actions', { action: { type: 'screenshot', marks: true } });
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(r.content[1]).toMatchObject({ type: 'text' });
  });
});
