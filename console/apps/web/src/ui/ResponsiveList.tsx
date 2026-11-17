import { Box, Checkbox, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip } from '@mui/material';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useBreakpoint } from './useBreakpoint';

export interface Column<T> {
  key: string;
  /** The column's header; a string also labels the column for assistive technology. */
  header: ReactNode;
  render: (item: T) => ReactNode;
  /** Hide the column below this breakpoint (`lg` 1200 px, `xl` 1536 px). */
  hideBelow?: 'lg' | 'xl';
  /** `right` for a numeric column. */
  align?: 'left' | 'right' | 'center';
  /** A fixed width (a number is pixels). The first column grows unless it has one. */
  width?: number | string;
  /** This column grows and wraps instead of the first one (a list whose first column is a status chip). */
  grow?: boolean;
}

export interface ListSelection {
  /** The keys (`getKey`) of the selected items. */
  selected: Set<string>;
  onToggle: (key: string) => void;
  /** Select every listed item, or clear the selection when all are selected. */
  onToggleAll: () => void;
  /** Why an item cannot be selected (its checkbox is disabled, with this as its tooltip); null when it can. */
  disabledReason?: (key: string) => string | null;
}

export interface ResponsiveListProps<T> {
  items: readonly T[];
  columns: Column<T>[];
  /** One item below `md`, where the list is a stack of cards. */
  renderCard: (item: T) => ReactNode;
  getKey: (item: T) => string;
  /** Opens an item: a row click, or Enter on a focused row. */
  onRowClick?: (item: T) => void;
  selection?: ListSelection;
  /** Under the rows or cards: a "load more" button, a count. */
  footer?: ReactNode;
  /** The list's accessible name. */
  'aria-label'?: string;
  /** Names an item for its selection checkbox ("Select {label}"); default: its key. */
  getLabel?: (item: T) => string;
  /**
   * Past this many items the list is windowed: rows far from the viewport are
   * replaced by a spacer of their measured height, in chunks of
   * `WINDOW_CHUNK`. Off by default, and where `IntersectionObserver` is missing.
   */
  windowAfter?: number;
}

/** Rows per window chunk. */
export const WINDOW_CHUNK = 25;
/** How far outside the viewport a chunk stays rendered. */
const WINDOW_MARGIN = '1200px 0px';

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Whether a chunk is near the viewport, and the height it had when it last
 * was (what its spacer takes). Always near when windowing is off.
 */
function useNearViewport<E extends Element>(windowed: boolean): { ref: React.RefObject<E | null>; near: boolean; height: number } {
  const ref = useRef<E | null>(null);
  const [state, setState] = useState({ near: true, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!windowed || !el || typeof IntersectionObserver === 'undefined') {
      setState((s) => (s.near ? s : { ...s, near: true }));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        // Leaving: keep the height the rendered rows had. A spacer that stays away keeps its height.
        setState((s) => (entry.isIntersecting ? (s.near ? s : { ...s, near: true }) : s.near ? { near: false, height: entry.boundingClientRect.height } : s));
      },
      { rootMargin: WINDOW_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [windowed]);
  return { ref, ...state };
}

/** A group of table rows that collapses to one spacer row while it is far from the viewport. */
function TableChunk({ windowed, colSpan, children }: { windowed: boolean; colSpan: number; children: () => ReactNode }) {
  const { ref, near, height } = useNearViewport<HTMLTableSectionElement>(windowed);
  return (
    <TableBody ref={ref}>
      {near ? (
        children()
      ) : (
        <tr aria-hidden style={{ height }}>
          <td colSpan={colSpan} style={{ padding: 0, border: 0 }} />
        </tr>
      )}
    </TableBody>
  );
}

/** True when the event came from a control inside the row (a checkbox, a button, a link), which handles it itself. */
function fromControl(target: EventTarget, row: HTMLElement): boolean {
  const el = target instanceof Element ? target.closest('a, button, input, select, textarea, label, [role="button"], [role="menuitem"], [role="checkbox"]') : null;
  return el !== null && el !== row && row.contains(el);
}

/**
 * A list that is a table at `md` and up (sticky header, the first column
 * grows, or the one marked `grow`; numeric columns right-aligned) and a stack
 * of cards below. It renders
 * the items it is given: paging is the caller's (keyset paging from the API,
 * with a "load more" in `footer`).
 */
export function ResponsiveList<T>({ items, columns, renderCard, getKey, onRowClick, selection, footer, getLabel, windowAfter, ...rest }: ResponsiveListProps<T>) {
  const { isDesktop } = useBreakpoint();
  const label = rest['aria-label'];
  // An item that cannot be selected does not count towards "all selected".
  const selectable = selection?.disabledReason ? items.filter((item) => selection.disabledReason!(getKey(item)) === null) : items;
  const allSelected = selection !== undefined && selectable.length > 0 && selectable.every((item) => selection.selected.has(getKey(item)));
  const someSelected = selection !== undefined && items.some((item) => selection.selected.has(getKey(item)));
  const name = (item: T) => getLabel?.(item) ?? getKey(item);
  const windowed = windowAfter !== undefined && items.length > windowAfter;
  const chunks = chunksOf(items, windowed ? WINDOW_CHUNK : Math.max(items.length, 1));
  const growIndex = Math.max(0, columns.findIndex((c) => c.grow));
  /** An item's checkbox: disabled, with the reason as its tooltip, when the item cannot be selected. */
  const checkbox = (item: T, key: string, sx?: object) => {
    const reason = selection?.disabledReason?.(key) ?? null;
    const box = (
      <Checkbox
        checked={selection!.selected.has(key)}
        disabled={reason !== null}
        onChange={() => selection!.onToggle(key)}
        slotProps={{ input: { 'aria-label': `Select ${name(item)}` } }}
        sx={sx}
      />
    );
    return reason === null ? (
      box
    ) : (
      <Tooltip title={reason}>
        <span>{box}</span>
      </Tooltip>
    );
  };

  if (!isDesktop) {
    return (
      <Box>
        {selection && items.length > 0 && (
          <Box sx={{ display: 'flex', alignItems: 'center', minHeight: 44 }}>
            <Checkbox checked={allSelected} indeterminate={someSelected && !allSelected} onChange={selection.onToggleAll} slotProps={{ input: { 'aria-label': 'Select all' } }} />
            <Box component="span" sx={{ typography: 'body2', color: 'text.secondary' }}>
              {selection.selected.size > 0 ? `${selection.selected.size} selected` : 'Select all'}
            </Box>
          </Box>
        )}
        <Stack spacing={1.5} component="ul" aria-label={label} sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {items.map((item) => {
            const key = getKey(item);
            return (
              // Windowed: the browser skips laying out and painting a card that is off screen.
              <Box component="li" key={key} sx={{ display: 'flex', alignItems: 'flex-start', minWidth: 0, ...(windowed ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 150px' } : {}) }}>
                {selection && checkbox(item, key, { mt: 0.5, width: 44, height: 44 })}
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>{renderCard(item)}</Box>
              </Box>
            );
          })}
        </Stack>
        {footer}
      </Box>
    );
  }

  const hidden = (column: Column<T>) => (column.hideBelow ? { display: { xs: 'none', [column.hideBelow]: 'table-cell' } } : {});
  return (
    <Box>
      {/* The container scrolls sideways when the columns cannot fit, so the page never does. */}
      <TableContainer sx={{ maxWidth: '100%' }}>
        <Table stickyHeader size="small" aria-label={label}>
          <TableHead>
            <TableRow>
              {selection && (
                <TableCell padding="checkbox">
                  <Checkbox checked={allSelected} indeterminate={someSelected && !allSelected} onChange={selection.onToggleAll} slotProps={{ input: { 'aria-label': 'Select all' } }} />
                </TableCell>
              )}
              {columns.map((column, index) => (
                <TableCell
                  key={column.key}
                  align={column.align}
                  sx={{ ...hidden(column), width: column.width ?? (index === growIndex ? '100%' : undefined), whiteSpace: index === growIndex ? undefined : 'nowrap' }}
                >
                  {column.header}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          {chunks.map((chunk, chunkIndex) => (
            <TableChunk key={chunk[0] ? getKey(chunk[0]) : chunkIndex} windowed={windowed} colSpan={columns.length + (selection ? 1 : 0)}>
              {() =>
            chunk.map((item) => {
              const key = getKey(item);
              const open = onRowClick
                ? {
                    hover: true,
                    tabIndex: 0,
                    onClick: (e: React.MouseEvent<HTMLTableRowElement>) => {
                      if (!fromControl(e.target, e.currentTarget)) onRowClick(item);
                    },
                    onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
                      if (e.key === 'Enter' && !fromControl(e.target, e.currentTarget)) onRowClick(item);
                    },
                    sx: { cursor: 'pointer', '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 } },
                  }
                : {};
              return (
                <TableRow key={key} selected={selection?.selected.has(key)} {...open}>
                  {selection && (
                    <TableCell padding="checkbox">
                      {checkbox(item, key)}
                    </TableCell>
                  )}
                  {columns.map((column, index) => (
                    <TableCell key={column.key} align={column.align} sx={{ ...hidden(column), overflowWrap: index === growIndex ? 'anywhere' : undefined, whiteSpace: index === growIndex ? undefined : 'nowrap' }}>
                      {column.render(item)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })
              }
            </TableChunk>
          ))}
        </Table>
      </TableContainer>
      {footer}
    </Box>
  );
}
