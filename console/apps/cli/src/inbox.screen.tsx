import type { TuiScreenProps } from '@marinoscar/platform-cli/tui';
import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { consoleApi } from './console-api.js';
import type { InboxItem } from './inbox.js';

/**
 * The inbox. Up/down selects a request. For text or a secret, type the
 * answer (a secret shows as dots) and press Enter; for a choice, press its
 * number; otherwise Enter means done. `x` declines; Esc goes back.
 */
export function InboxScreen({ onDone }: TuiScreenProps): ReactNode {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await consoleApi().get<InboxItem[]>('/inbox'));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  const send = (item: InboxItem, outcome: 'completed' | 'cancelled', value?: string) => {
    setStatus('sending…');
    void consoleApi()
      .post(`/inbox/${item.runId}/respond`, value !== undefined ? { outcome, value } : { outcome })
      .then(() => {
        setStatus(outcome === 'completed' ? 'sent; the agent continues' : 'declined');
        setTyped('');
        return load();
      })
      .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
  };

  useInput((input, key) => {
    if (key.escape) return onDone();
    const list = items ?? [];
    const item = list[selected];
    if (key.upArrow) return (setSelected((i) => Math.max(0, i - 1)), setTyped(''));
    if (key.downArrow) return (setSelected((i) => Math.min(Math.max(0, list.length - 1), i + 1)), setTyped(''));
    if (!item) return;
    const typing = item.input === 'text' || item.input === 'secret';
    if (typing) {
      if (key.return) return typed ? send(item, 'completed', typed) : undefined;
      if (key.backspace || key.delete) return setTyped((t) => t.slice(0, -1));
      if (input === 'x' && !typed) return send(item, 'cancelled');
      if (input && !key.ctrl && !key.meta) setTyped((t) => t + input);
      return;
    }
    if (input === 'x') return send(item, 'cancelled');
    if (item.input === 'choice') {
      const n = Number.parseInt(input, 10);
      if (n >= 1 && n <= item.choices.length) send(item, 'completed', item.choices[n - 1]);
      return;
    }
    if (key.return) send(item, 'completed');
    if (input === 'q') onDone();
  });

  const item = items?.[selected];
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Inbox</Text>
      {error && <Text color="red">{error}</Text>}
      {!items && !error && <Text dimColor>Loading…</Text>}
      {items?.length === 0 && <Text>Nothing is waiting for you.</Text>}
      <Box flexDirection="column">
        {items?.map((i, n) => (
          <Text key={i.runId} inverse={n === selected} wrap="truncate">
            {n === selected ? '› ' : '  '}[{i.kind}] {i.prompt}
          </Text>
        ))}
      </Box>
      {item && (item.input === 'text' || item.input === 'secret') && (
        <Text>
          {item.input === 'secret' ? 'secret' : 'answer'}: {item.input === 'secret' ? '•'.repeat(typed.length) : typed}
        </Text>
      )}
      {item?.input === 'choice' && <Text>{item.choices.map((c, n) => `${n + 1}) ${c}`).join('   ')}</Text>}
      {status && <Text>{status}</Text>}
      <Text dimColor>↑/↓ select · enter send/done · x decline · esc back</Text>
    </Box>
  );
}
