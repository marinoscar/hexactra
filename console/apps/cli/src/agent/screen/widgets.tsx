// Small ink widgets the Agent screen is built from (#374). No new
// dependencies: the platform's layout pieces plus these.
import { useTuiTheme } from '@marinoscar/platform-cli/tui';
import { toneProps, useTerminalSize, type TuiTone } from '@marinoscar/platform-cli/tui/ui';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState, type ReactNode } from 'react';

import type { Panel } from './model.js';

export interface SelectItem<T extends string> {
  id: T;
  label: string;
  /** A hotkey that selects it directly. */
  key?: string;
  hint?: string;
}

/** A vertical menu: ↑↓ (or j/k) move, enter selects, an item's hotkey selects it directly. */
export function SelectList<T extends string>({
  items,
  onSelect,
  isActive = true,
  initial = 0,
}: {
  items: readonly SelectItem<T>[];
  onSelect: (id: T) => void;
  isActive?: boolean;
  initial?: number;
}): ReactNode {
  const theme = useTuiTheme();
  const [index, setIndex] = useState(Math.min(initial, Math.max(0, items.length - 1)));
  useEffect(() => {
    if (index >= items.length) setIndex(Math.max(0, items.length - 1));
  }, [items.length, index]);
  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setIndex((i) => (i - 1 + items.length) % items.length);
      else if (key.downArrow || input === 'j') setIndex((i) => (i + 1) % items.length);
      else if (key.return) {
        const it = items[index];
        if (it) onSelect(it.id);
      } else {
        const hit = items.find((it) => it.key && it.key === input);
        if (hit) onSelect(hit.id);
      }
    },
    { isActive },
  );
  const current = items[index];
  return (
    <Box flexDirection="column">
      {items.map((it, i) => (
        <Text key={it.id} wrap="truncate" {...(i === index ? toneProps(theme, 'primary') : {})} bold={i === index}>
          {i === index ? '› ' : '  '}
          {it.key ? `${it.key}  ` : ''}
          {it.label}
        </Text>
      ))}
      {current?.hint && (
        <Text dimColor wrap="truncate">
          {'   '}
          {current.hint}
        </Text>
      )}
    </Box>
  );
}

/**
 * A one-line text field. With `mask`, every character shows as `•` and the
 * value never appears on screen (the sudo password).
 */
export function TextField({
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  mask = false,
  isActive = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onCancel?: () => void;
  mask?: boolean;
  isActive?: boolean;
}): ReactNode {
  const theme = useTuiTheme();
  useInput(
    (input, key) => {
      if (key.return) onSubmit(value);
      else if (key.escape) onCancel?.();
      else if (key.backspace || key.delete) onChange(value.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        onChange(value + input.replace(/[\r\n]/g, ''));
      }
    },
    { isActive },
  );
  return (
    <Text wrap="truncate">
      <Text {...toneProps(theme, 'primary')}>{label}: </Text>
      {mask ? '•'.repeat(value.length) : value}
      <Text {...toneProps(theme, 'primary')}>▏</Text>
    </Text>
  );
}

export interface ToneLine {
  text: string;
  tone?: TuiTone;
  bold?: boolean;
}

/**
 * Coloured lines in a viewport that fits the terminal: ↑↓ / j k scroll,
 * PgUp/PgDn page, g/G top and bottom. `follow` sticks to the end while new
 * lines arrive, until the person scrolls up.
 */
export function ToneLines({ lines, reservedRows = 8, isActive = true, follow = false }: { lines: readonly ToneLine[]; reservedRows?: number; isActive?: boolean; follow?: boolean }): ReactNode {
  const theme = useTuiTheme();
  const { rows } = useTerminalSize();
  const height = Math.max(3, rows - reservedRows);
  const maxTop = Math.max(0, lines.length - height);
  const [top, setTop] = useState(follow ? maxTop : 0);
  const [stuck, setStuck] = useState(follow);
  useEffect(() => {
    if (stuck) setTop(maxTop);
    else if (top > maxTop) setTop(maxTop);
  }, [maxTop, stuck, top]);
  useInput(
    (input, key) => {
      const move = (t: number) => {
        const next = Math.max(0, Math.min(maxTop, t));
        setTop(next);
        setStuck(follow && next >= maxTop);
      };
      if (key.upArrow || input === 'k') move(top - 1);
      else if (key.downArrow || input === 'j') move(top + 1);
      else if (key.pageUp) move(top - height);
      else if (key.pageDown) move(top + height);
      else if (input === 'g') move(0);
      else if (input === 'G') move(maxTop);
    },
    { isActive },
  );
  const view = lines.slice(top, top + height);
  return (
    <Box flexDirection="column">
      {view.map((l, i) => (
        <Text key={`${top + i}`} wrap="truncate" bold={l.bold} {...toneProps(theme, l.tone)}>
          {l.text || ' '}
        </Text>
      ))}
      {lines.length > height && (
        <Text dimColor>
          {`lines ${top + 1}-${Math.min(lines.length, top + height)} of ${lines.length}${follow ? (stuck ? ' · following' : ' · G to follow') : ''}`}
        </Text>
      )}
    </Box>
  );
}

/**
 * The panels as one coloured line each, for terminals too narrow or short for
 * the boxed panels: `Agent  mini-pc · 1.2.0 · active (running)`.
 */
export function CompactPanels({ panels }: { panels: readonly Panel[] }): ReactNode {
  const theme = useTuiTheme();
  const width = Math.max(...panels.map((p) => p.title.split(' · ')[0]!.length)) + 2;
  return (
    <Box flexDirection="column">
      {panels.map((p) => (
        <Text key={p.title} wrap="wrap">
          <Text bold {...toneProps(theme, 'primary')}>
            {p.title.split(' · ')[0]!.padEnd(width)}
          </Text>
          {p.rows.map((r, i) => (
            <Text key={`${i}-${r.label}`}>
              {i > 0 && <Text dimColor> · </Text>}
              {r.label === 'Host' || r.label === 'Version' || r.label === 'Browser' || r.label === 'Desktop' || r.label === 'Graphics' ? '' : <Text dimColor>{r.label} </Text>}
              <Text {...toneProps(theme, r.tone)}>{r.value}</Text>
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

/** A titled block of label/value rows with tone colours. */
export function PanelView({ panel, width }: { panel: Panel; width?: number }): ReactNode {
  const theme = useTuiTheme();
  const labelWidth = Math.max(8, ...panel.rows.map((r) => r.label.length)) + 2;
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} {...(width ? { width } : {})}>
      <Text bold {...toneProps(theme, 'primary')} wrap="truncate">
        {panel.title}
      </Text>
      {panel.rows.map((r, i) => (
        <Text key={`${i}-${r.label}`} wrap="truncate">
          <Text dimColor>{r.label.padEnd(labelWidth)}</Text>
          <Text {...toneProps(theme, r.tone)}>{r.value}</Text>
        </Text>
      ))}
    </Box>
  );
}
