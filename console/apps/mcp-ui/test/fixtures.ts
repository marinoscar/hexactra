// A mocked MCP Apps host for the run card, and tool results shaped like the
// console's (the run with its progress block, #463).
import { act } from '@testing-library/react';
import { vi } from 'vitest';

import type { HostBridge, HostContextLike } from '../src/bridge';
import type { HostBridge as SharedHostBridge } from '../src/shared/bridge';
import type { ToolResultLike } from '../src/model';

export const RUN_ID = '11111111-1111-4111-8111-111111111111';
export const TASK_ID = '22222222-2222-4222-8222-222222222222';
export const CONSOLE = `https://console.example.test/runs/${RUN_ID}`;
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function progress(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: RUN_ID,
    status,
    changed: true,
    cursor: `cur-${status}`,
    activity: status === 'running' ? 'Doing: click #submit' : 'Done',
    steps_done: 3,
    elapsed_s: 42,
    needs_human: status === 'waiting_human',
    console_url: CONSOLE,
    ...extra,
  };
}

export function result(status: string, opts: { run?: Record<string, unknown>; progress?: Record<string, unknown>; image?: boolean; key?: { created_at: number; seq: number } } = {}): ToolResultLike {
  const p = progress(status, opts.progress);
  return {
    content: [{ type: 'text', text: 'summary' }, ...(opts.image ? [{ type: 'image', data: PNG, mimeType: 'image/png' }] : [])],
    structuredContent: {
      id: RUN_ID,
      goal: 'Book a table for two at eight',
      status,
      taskId: null,
      stopReason: null,
      costUsd: 0.0123,
      costKnown: true,
      currentTier: 'standard',
      policy: { name: 'Balanced' },
      ...opts.run,
      progress: p,
      ...(opts.key ? { card_key: opts.key } : {}),
    },
  };
}

/** A bare progress block, as run_wait answers. */
export function waitResult(status: string, extra: Record<string, unknown> = {}): ToolResultLike {
  return { content: [{ type: 'text', text: 'summary' }], structuredContent: progress(status, extra) };
}

export type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<ToolResultLike>;

export function mockHost(opts: { context?: HostContextLike; tools?: ToolHandler } = {}) {
  let onResult: ((r: ToolResultLike) => void) | null = null;
  let onContext: ((c: HostContextLike) => void) | null = null;
  const handler: { fn: ToolHandler } = { fn: opts.tools ?? (async () => new Promise<ToolResultLike>(() => undefined)) };
  const host = {
    callTool: vi.fn((name: string, args: Record<string, unknown>) => handler.fn(name, args)),
    openLink: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    hostContext: () => opts.context,
    onToolResult: (cb: (r: ToolResultLike) => void) => {
      onResult = cb;
    },
    onToolInput: () => undefined,
    onHostContextChanged: (cb: (c: HostContextLike) => void) => {
      onContext = cb;
    },
  } satisfies HostBridge;
  return {
    host,
    setTools(fn: ToolHandler) {
      handler.fn = fn;
    },
    push(r: ToolResultLike) {
      act(() => onResult?.(r));
    },
    context(c: HostContextLike) {
      act(() => onContext?.(c));
    },
  };
}

/** An in-memory BroadcastChannel bus. */
export function channelBus() {
  const channels = new Map<string, Set<{ onmessage: ((ev: { data: unknown }) => void) | null }>>();
  const factory = (name: string) => {
    const set = channels.get(name) ?? new Set();
    channels.set(name, set);
    const ch = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      postMessage(m: unknown) {
        for (const other of set) if (other !== ch) queueMicrotask(() => other.onmessage?.({ data: m }));
      },
      close() {
        set.delete(ch);
      },
    };
    set.add(ch);
    return ch;
  };
  return { factory, channels };
}

/** A mocked host for any widget (the question and tasks cards, #467). */
export function mockWidgetHost<T extends string>(opts: { context?: HostContextLike; tools?: (name: T, args: Record<string, unknown>) => Promise<ToolResultLike> } = {}) {
  let onResult: ((r: ToolResultLike) => void) | null = null;
  const pending: ToolResultLike[] = [];
  const handler = { fn: opts.tools ?? (async () => new Promise<ToolResultLike>(() => undefined)) };
  const host = {
    callTool: vi.fn((name: T, args: Record<string, unknown>) => handler.fn(name, args)),
    openLink: vi.fn(async (_url: string) => undefined),
    sendMessage: vi.fn(async (_text: string) => undefined),
    hostContext: () => opts.context,
    onToolResult: (cb: (r: ToolResultLike) => void) => {
      onResult = cb;
      for (const r of pending.splice(0)) cb(r);
    },
    onToolInput: () => undefined,
    onHostContextChanged: () => undefined,
  } satisfies SharedHostBridge<T>;
  return {
    host,
    setTools(fn: (name: T, args: Record<string, unknown>) => Promise<ToolResultLike>) {
      handler.fn = fn;
    },
    push(r: ToolResultLike) {
      act(() => {
        if (onResult) onResult(r);
        else pending.push(r);
      });
    },
  };
}
