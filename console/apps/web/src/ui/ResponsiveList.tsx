import { Box, Checkbox, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow } from '@mui/material';
import type { KeyboardEvent, ReactNode } from 'react';

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
}

export interface ListSelection {
  /** The keys (`getKey`) of the selected items. */
  selected: Set<string>;
  onToggle: (key: string) => void;
  /** Select every listed item, or clear the selection when all are selected. */
  onToggleAll: () => void;
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
}

/** True when the event came from a control inside the row (a checkbox, a button, a link), which handles it itself. */
function fromControl(target: EventTarget, row: HTMLElement): boolean {
  const el = target instanceof Element ? target.closest('a, button, input, select, textarea, label, [role="button"], [role="menuitem"], [role="checkbox"]') : null;
  return el !== null && el !== row && row.contains(el);
}

/**
 * A list that is a table at `md` and up (sticky header, the first column
 * grows, numeric columns right-aligned) and a stack of cards below. It renders
 * the items it is given: paging is the caller's (keyset paging from the API,
 * with a "load more" in `footer`).
 */
export function ResponsiveList<T>({ items, columns, renderCard, getKey, onRowClick, selection, footer, getLabel, ...rest }: ResponsiveListProps<T>) {
  const { isDesktop } = useBreakpoint();
  const label = rest['aria-label'];
  const allSelected = selection !== undefined && items.length > 0 && items.every((item) => selection.selected.has(getKey(item)));
  const someSelected = selection !== undefined && items.some((item) => selection.selected.has(getKey(item)));
  const name = (item: T) => getLabel?.(item) ?? getKey(item);

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
              <Box component="li" key={key} sx={{ display: 'flex', alignItems: 'flex-start', minWidth: 0 }}>
                {selection && (
                  <Checkbox
                    checked={selection.selected.has(key)}
                    onChange={() => selection.onToggle(key)}
                    slotProps={{ input: { 'aria-label': `Select ${name(item)}` } }}
                    sx={{ mt: 0.5 }}
                  />
                )}
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
                  sx={{ ...hidden(column), width: column.width ?? (index === 0 ? '100%' : undefined), whiteSpace: index === 0 ? undefined : 'nowrap' }}
                >
                  {column.header}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((item) => {
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
                      <Checkbox checked={selection.selected.has(key)} onChange={() => selection.onToggle(key)} slotProps={{ input: { 'aria-label': `Select ${name(item)}` } }} />
                    </TableCell>
                  )}
                  {columns.map((column, index) => (
                    <TableCell key={column.key} align={column.align} sx={{ ...hidden(column), overflowWrap: index === 0 ? 'anywhere' : undefined, whiteSpace: index === 0 ? undefined : 'nowrap' }}>
                      {column.render(item)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      {footer}
    </Box>
  );
}
