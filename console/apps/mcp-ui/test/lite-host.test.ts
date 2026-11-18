// The small postMessage bridge of the question and tasks cards
// (src/shared/lite-host.ts) against the MCP Apps SDK's own host side
// (`AppBridge`, @modelcontextprotocol/ext-apps/app-bridge): the handshake,
// a tool result before and after the widget subscribes, tools/call,
// ui/message, ui/open-link, the host context, ping, teardown, and that a
// tool outside the widget's list is never sent. A drift from the SDK's wire
// format fails here.
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { describe, expect, it, vi } from 'vitest';

import { LiteHost, APPS_PROTOCOL_VERSION, type Port } from '../src/shared/lite-host';
import type { ToolResultLike } from '../src/shared/text';

/** A host (AppBridge on an in-memory transport) and a widget port wired to it. */
function pair() {
  let toWidget: ((m: unknown) => void) | null = null;
  const sentByWidget: unknown[] = [];
  const transport = {
    onmessage: undefined as ((m: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((e: Error) => void) | undefined,
    async start() {},
    async send(m: unknown) {
      // Structured clone, as postMessage does.
      const copy = JSON.parse(JSON.stringify(m)) as unknown;
      queueMicrotask(() => toWidget?.(copy));
    },
    async close() {},
  };
  const port: Port = {
    post(m) {
      sentByWidget.push(m);
      const copy = JSON.parse(JSON.stringify(m)) as unknown;
      queueMicrotask(() => transport.onmessage?.(copy));
    },
    listen(cb) {
      toWidget = cb;
      return () => {
        toWidget = null;
      };
    },
  };
  const bridge = new AppBridge(null, { name: 'test-host', version: '1.0.0' }, { openLinks: {}, serverTools: {}, message: { text: {} } }, { hostContext: { theme: 'dark' } });
  return { bridge, transport, port, sentByWidget };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LiteHost against the SDK host (AppBridge)', () => {
  it('connects, receives the tool result and the host context, calls an allowed tool, sends a message and opens a link', async () => {
    const { bridge, transport, port, sentByWidget } = pair();
    const initialized = vi.fn();
    bridge.oninitialized = initialized;
    const calls: unknown[] = [];
    bridge.oncalltool = async (params) => {
      calls.push(params);
      return { content: [{ type: 'text', text: 'done' }], structuredContent: { ok: true } };
    };
    const messages: unknown[] = [];
    bridge.onmessage = async (params) => {
      messages.push(params);
      return {};
    };
    const links: unknown[] = [];
    bridge.onopenlink = async (params) => {
      links.push(params);
      return {};
    };
    await bridge.connect(transport as never);

    const host = new LiteHost({ name: 'test widget', version: '1' }, port, { allowed: ['inbox_list'] as const, autoResize: false });
    await host.connect();
    await tick();
    expect(initialized).toHaveBeenCalledTimes(1);
    expect(host.hostContext()).toMatchObject({ theme: 'dark' });
    expect(sentByWidget[0]).toMatchObject({ jsonrpc: '2.0', method: 'ui/initialize', params: { protocolVersion: APPS_PROTOCOL_VERSION, appInfo: { name: 'test widget' } } });

    // A result sent before the widget subscribes is kept for it.
    await bridge.sendToolResult({ content: [{ type: 'text', text: 'first' }], structuredContent: { items: [] } });
    await tick();
    const results: ToolResultLike[] = [];
    host.onToolResult((r) => results.push(r));
    expect(results).toEqual([expect.objectContaining({ structuredContent: { items: [] } })]);

    const contexts: unknown[] = [];
    host.onHostContextChanged((c) => contexts.push(c));
    bridge.setHostContext({ theme: 'light' });
    await tick();
    expect(contexts).toEqual([expect.objectContaining({ theme: 'light' })]);
    expect(host.hostContext()).toMatchObject({ theme: 'light' });

    expect(await host.callTool('inbox_list', {})).toMatchObject({ structuredContent: { ok: true } });
    expect(calls).toEqual([{ name: 'inbox_list', arguments: {} }]);
    await expect(host.callTool('task_pause' as never, {})).rejects.toThrow('not an allowed tool');
    expect(calls).toHaveLength(1);

    await host.sendMessage('I answered the agent\'s question: 20:00');
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: "I answered the agent's question: 20:00" }] }]);
    await host.sendMessage('x'.repeat(1000));
    expect((messages[1] as { content: { text: string }[] }).content[0]!.text.length).toBeLessThanOrEqual(300);

    await host.openLink('https://console.example.test/inbox/q/1');
    expect(links).toEqual([{ url: 'https://console.example.test/inbox/q/1' }]);

    // The host may ask to tear the view down: the bridge answers.
    await expect(bridge.teardownResource({})).resolves.toBeDefined();
    host.close();
  });

  it('a host that refuses a call (the user declined its prompt) rejects; an error result resolves with isError', async () => {
    const { bridge, transport, port } = pair();
    let refuse = true;
    bridge.oncalltool = async () => {
      if (refuse) throw new Error('The user declined');
      return { isError: true, content: [{ type: 'text', text: 'At most 5 [INVALID_ANSWER]' }] };
    };
    await bridge.connect(transport as never);
    const host = new LiteHost({ name: 'w', version: '1' }, port, { allowed: ['question_card_answer'] as const, autoResize: false });
    await host.connect();
    await expect(host.callTool('question_card_answer', { question_id: 'q' })).rejects.toThrow();
    refuse = false;
    expect(await host.callTool('question_card_answer', { question_id: 'q' })).toMatchObject({ isError: true });
    host.close();
  });

  it('ignores what is not JSON-RPC and answers requests it does not offer with "method not found"', async () => {
    const sent: unknown[] = [];
    let deliver: (m: unknown) => void = () => undefined;
    const port: Port = {
      post: (m) => {
        sent.push(m);
        const msg = m as { id?: number; method?: string };
        if (msg.method === 'ui/initialize') queueMicrotask(() => deliver({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: APPS_PROTOCOL_VERSION, hostInfo: { name: 'h', version: '1' }, hostCapabilities: {}, hostContext: {} } }));
      },
      listen: (cb) => {
        deliver = cb;
        return () => undefined;
      },
    };
    const host = new LiteHost({ name: 'w', version: '1' }, port, { allowed: [], autoResize: false });
    await host.connect();
    deliver('<b>not json-rpc</b>');
    deliver({ jsonrpc: '1.0', method: 'ui/notifications/tool-result', params: {} });
    deliver({ jsonrpc: '2.0', id: 7, method: 'ping' });
    deliver({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'x' } });
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 7, result: {} });
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 8, error: { code: -32601, message: 'Method not found: tools/call' } });
    const results: unknown[] = [];
    host.onToolResult((r) => results.push(r));
    expect(results).toEqual([]);
    host.close();
  });
});
