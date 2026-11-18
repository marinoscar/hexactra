import { textColor, useTuiTheme, type TuiScreenProps } from '@marinoscar/platform-cli/tui';
import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { consoleApi } from './console-api.js';
import type { InboxItem } from './inbox.js';
import { constraintText, type AnswerBody } from './questions.js';

const TYPED = new Set(['text', 'secret', 'number']);

/** The keys that answer the selected item, shown under it. */
function hint(item: InboxItem, armed: boolean): string {
  switch (item.input) {
    case 'text':
    case 'number':
    case 'secret':
      return 'type, enter send · x decline (before typing)';
    case 'choice':
      return 'press an option number · x decline';
    case 'multi_choice':
      return 'numbers toggle · enter send · x decline';
    case 'credentials':
      return 'a sign-in: answer it in the web app (chat or Inbox) · x decline';
    case 'confirm':
      return armed ? `press y again to ${item.confirmLabel ?? 'approve'} (high risk) · any other key cancels` : `y ${item.confirmLabel ?? 'approve'} · n ${item.denyLabel ?? 'deny'} · x decline`;
    default:
      return 'enter done · x decline';
  }
}

/**
 * The inbox. Up/down selects a request. Text, a number or a secret: type
 * it (a secret shows as dots) and press Enter. A choice: press its number.
 * Several choices: numbers toggle, Enter sends. A confirmation: y or n (a
 * high-risk one asks for y twice). Otherwise Enter means done. `x`
 * declines; Esc goes back.
 */
export function InboxScreen({ onDone }: TuiScreenProps): ReactNode {
  const theme = useTuiTheme();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [typed, setTyped] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [armed, setArmed] = useState(false);
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

  const reset = () => {
    setTyped('');
    setPicked([]);
    setArmed(false);
  };

  const send = (item: InboxItem, body: AnswerBody) => {
    setStatus('sending…');
    // The typed value is dropped from state at once (a secret is not kept).
    reset();
    const path = item.runId ? `/inbox/${item.runId}/respond` : `/questions/${item.questionId}/answer`;
    void consoleApi()
      .post(path, item.runId ? body : { ...body, channel: 'tui' })
      .then(() => {
        setStatus(body.outcome === 'completed' ? 'sent; the agent continues' : 'declined');
        return load();
      })
      .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
  };

  useInput((input, key) => {
    if (key.escape) return onDone();
    const list = items ?? [];
    const item = list[selected];
    if (key.upArrow) return (setSelected((i) => Math.max(0, i - 1)), reset());
    if (key.downArrow) return (setSelected((i) => Math.min(Math.max(0, list.length - 1), i + 1)), reset());
    if (!item) return;
    // A sign-in (#527) is answered in the web app, where its password field is; here it can only be declined.
    if (item.input === 'credentials') {
      if (input === 'x') send(item, { outcome: 'cancelled' });
      return;
    }
    if (TYPED.has(item.input)) {
      if (key.return) return typed ? send(item, { outcome: 'completed', value: typed }) : undefined;
      if (key.backspace || key.delete) return setTyped((t) => t.slice(0, -1));
      if (input === 'x' && !typed) return send(item, { outcome: 'cancelled' });
      if (input && !key.ctrl && !key.meta) setTyped((t) => t + input);
      return;
    }
    if (item.input === 'confirm') {
      if (armed) {
        if (input === 'y') return send(item, { outcome: 'completed', value: 'approve' });
        return setArmed(false);
      }
      if (input === 'y') return item.risk === 'low' ? send(item, { outcome: 'completed', value: 'approve' }) : setArmed(true);
      if (input === 'n') return send(item, { outcome: 'completed', value: 'deny' });
    }
    if (input === 'x') return send(item, { outcome: 'cancelled' });
    const options = item.options ?? item.choices.map((c) => ({ id: c, label: c }));
    const n = Number.parseInt(input, 10);
    if (item.input === 'choice') {
      if (n >= 1 && n <= options.length) send(item, { outcome: 'completed', value: options[n - 1]!.id });
      return;
    }
    if (item.input === 'multi_choice') {
      if (n >= 1 && n <= options.length) {
        const id = options[n - 1]!.id;
        return setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
      }
      if (key.return && picked.length) send(item, { outcome: 'completed', values: options.map((o) => o.id).filter((id) => picked.includes(id)) });
      return;
    }
    if (item.input === 'confirm') return;
    if (key.return) send(item, { outcome: 'completed' });
    if (input === 'q') onDone();
  });

  const item = items?.[selected];
  const options = item ? (item.options ?? item.choices.map((c) => ({ id: c, label: c }))) : [];
  const c = item ? constraintText(item) : '';
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold {...textColor(theme.primary)}>Inbox</Text>
      {error && <Text {...textColor(theme.error)}>{error}</Text>}
      {!items && !error && <Text dimColor>Loading…</Text>}
      {items?.length === 0 && <Text>Nothing is waiting for you.</Text>}
      <Box flexDirection="column">
        {items?.map((i, n) => (
          <Text key={i.questionId} inverse={n === selected} wrap="truncate">
            {n === selected ? '› ' : '  '}[{i.kind}] {i.prompt}
          </Text>
        ))}
      </Box>
      {item && c && <Text dimColor>{c}</Text>}
      {item && TYPED.has(item.input) && (
        <Text>
          {item.input === 'secret' ? 'secret' : 'answer'}: {item.input === 'secret' ? '•'.repeat(typed.length) : typed}
          {item.input === 'number' && item.constraints?.unit ? ` ${item.constraints.unit}` : ''}
        </Text>
      )}
      {(item?.input === 'choice' || item?.input === 'multi_choice') && (
        <Box flexDirection="column">
          {options.map((o, n) => (
            <Text key={o.id}>
              {item.input === 'multi_choice' ? (picked.includes(o.id) ? '[x] ' : '[ ] ') : ''}
              {n + 1}) {o.label}
              {'description' in o && o.description ? ` — ${o.description}` : ''}
            </Text>
          ))}
        </Box>
      )}
      {item?.input === 'takeover' && <Text>Take over the browser (open it from the web app), then press enter.</Text>}
      {item && <Text dimColor>{hint(item, armed)}</Text>}
      {status && <Text>{status}</Text>}
      <Text dimColor>↑/↓ select · x decline · esc back</Text>
    </Box>
  );
}
